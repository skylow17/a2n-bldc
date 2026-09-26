/**
 * @file console.c
 * @brief Console ASCII de diagnostic, ligne par ligne.
 *
 * Reprise du principe le mieux réussi du v1 : une ligne de texte, une réponse, lisible
 * depuis n'importe quel terminal série sans aucun outil. Le canal binaire viendra à côté,
 * sur le même lien, discriminé par l'octet de fin.
 *
 * Tourne dans la superloop. Rien ici n'est appelé depuis l'ISR de contrôle.
 *
 * Depuis M1b, la séparation des deux canaux et le découpage en lignes appartiennent à
 * comm/rx_router.c : la console reçoit des lignes complètes et n'a plus d'état.
 */
#include "console.h"

#include <stdlib.h>
#include <string.h>

#include "stm32g4xx_ll_adc.h"

#include "adc_sync.h"
#include "board.h"
#include "ctrl.h"
#include "drv8304.h"
#include "encoder.h"
#include "imot.h"
#include "nvm.h"
#include "openloop.h"
#include "sensors.h"
#include "comm/param.h"
#include "comm/proto.h"
#include "comm/rx_router.h"
#include "comm/selftest.h"
#include "link_usb.h"
#include "pwm.h"
#include "safety.h"
#include "version.h"

void Console_Init(void)
{
  /* Plus rien à initialiser : l'état de réception vit dans le routeur. La fonction est
   * conservée pour que main.c garde une séquence d'initialisation homogène. */
}

void Console_ReplyOverflow(void)
{
  Link_TxPrintf("ERR OVF\r\n");
}

static void Reply(const char *text)
{
  Link_TxPrintf("%s\r\n", text);
}

/* Compare la commande sans tenir compte de la casse, et rend l'argument éventuel. */
static bool Match(const char *line, const char *cmd, const char **arg)
{
  const size_t n = strlen(cmd);
  if (strncasecmp(line, cmd, n) != 0) {
    return false;
  }
  if ((line[n] != '\0') && (line[n] != ' ')) {
    return false;   /* "PINGX" ne doit pas passer pour "PING" */
  }
  if (arg != NULL) {
    const char *a = &line[n];
    while (*a == ' ') { a++; }
    *arg = a;
  }
  return true;
}

static void CmdStats(void)
{
  Ctrl_Stats_t st;
  Ctrl_GetStats(&st);

  /* Durées en nanosecondes entières : pas de formatage flottant, donc pas de printf
   * flottant à embarquer, et aucune perte de précision utile à 144 MHz (6,94 ns/cycle). */
  const uint32_t last_ns = (uint32_t)(((uint64_t)st.cycles_last * 1000000000ULL) / BOARD_SYSCLK_HZ);
  const uint32_t max_ns  = (uint32_t)(((uint64_t)st.cycles_max  * 1000000000ULL) / BOARD_SYSCLK_HZ);
  /* Charge en pour mille du budget d'une période PWM. */
  const uint32_t budget  = BOARD_SYSCLK_HZ / PWM_FREQ_HZ;
  const uint32_t load_pm = (st.cycles_max * 1000U) / budget;

  Link_TxPrintf("OK ticks=%lu ms=%lu last_ns=%lu max_ns=%lu load_pm=%lu "
                "ia=%u ib=%u ic=%u\r\n",
                (unsigned long)st.ticks, (unsigned long)HAL_GetTick(),
                (unsigned long)last_ns, (unsigned long)max_ns, (unsigned long)load_pm,
                st.raw_ia, st.raw_ib, st.raw_ic);
}

static void CmdSelftest(void)
{
  SelftestResult_t r;
  Selftest_Run(&r);

  /* Une seule ligne, lisible depuis un terminal : le detail par famille sert a savoir
   * ou chercher sans rebrancher une sonde. */
  Link_TxPrintf("%s total=%u failed=%u crc16=%u cobs_enc=%u cobs_dec=%u frame=%u "
                "dict_hash=%08lX dict_ok=%u\r\n",
                (r.failed == 0U) ? "OK" : "ERR",
                r.total, r.failed, r.crc16_failed, r.cobs_encode_failed,
                r.cobs_decode_failed, r.frame_failed,
                (unsigned long)r.dict_hash, r.dict_hash_ok ? 1U : 0U);
}

/* ---------------------------------------------------------------- DRV8304 */

static void CmdDrvStatus(void)
{
  Drv8304_Status_t st;
  const bool read = Drv8304_ReadFaults();
  Drv8304_GetStatus(&st);

  uint16_t regs[DRV_REG_COUNT] = {0};
  bool regs_ok = read;
  for (uint8_t r = DRV_REG_DRIVER_CONTROL; (r < DRV_REG_COUNT) && regs_ok; r++) {
    regs_ok = Drv8304_ReadReg(r, &regs[r]);
  }

  /* `spi` dit si le bus répond ; `nfault` est la broche telle qu'elle est maintenant ;
   * `events` compte les fronts vus par l'EXTI depuis le reset — une faute déjà retombée
   * reste ainsi visible. Les registres en hexadécimal sur 11 bits, dans l'ordre de la carte. */
  Link_TxPrintf("%s spi=%u nfault=%u events=%lu fs1=%03X fs2=%03X ctrl=%03X hs=%03X "
                "ls=%03X ocp=%03X csa=%03X\r\n",
                regs_ok ? "OK" : "ERR", st.spi_ok ? 1U : 0U, st.nfault_low ? 1U : 0U,
                (unsigned long)st.fault_events, st.fault_status_1, st.vgs_status_2,
                regs[DRV_REG_DRIVER_CONTROL], regs[DRV_REG_GATE_DRIVE_HS],
                regs[DRV_REG_GATE_DRIVE_LS], regs[DRV_REG_OCP_CONTROL],
                regs[DRV_REG_CSA_CONTROL]);
}

/* ---------------------------------------------------------------- PWM à vide (M2, étape 3) */

/* Traduit le refus de la barrière en réponse console. Une cause par code : un refus qu'on
 * ne sait pas expliquer pousse à réessayer, et réessayer n'est pas la bonne réponse. */
static void ReplyEnable(SafetyEnable_t r)
{
  switch (r) {
    case SAFETY_EN_OK:      Reply("OK");          break;
    case SAFETY_EN_LATCHED: Reply("ERR LATCHED"); break;
    case SAFETY_EN_NOZERO:  Reply("ERR NOZERO");  break;
    case SAFETY_EN_CAL:     Reply("ERR CAL");     break;
    case SAFETY_EN_CSA:     Reply("ERR CSA");     break;
    case SAFETY_EN_DISARMED: Reply("ERR DISARMED"); break;
    case SAFETY_EN_LINK:
    default:                Reply("ERR LINK");    break;
  }
}

/* `PWM ON` lève MOE ; `PWM OFF` le coupe ; `PWM <a> <b> <c>` pose les rapports cycliques en
 * pour mille. Les rapports se posent MOE coupé ou levé, indifféremment : les CCR sont
 * préchargés. Lever MOE exige un driver qui répond et aucune faute — sans quoi on
 * commanderait des grilles que le DRV tient coupées, et on ne verrait rien de ce qu'on
 * croit mesurer. */
static void CmdPwm(const char *arg)
{
  if (strcasecmp(arg, "ON") == 0) {
    Drv8304_Status_t st;
    if (!Drv8304_ReadFaults()) {
      Reply("ERR DRV");
      return;
    }
    Drv8304_GetStatus(&st);
    if (st.nfault_low || ((st.fault_status_1 & DRV_FS1_FAULT) != 0U)) {
      Reply("ERR FAULT");
      return;
    }
    /* Seule voie d'activation : la barrière connaît l'hôte, la faute latchée et l'état
     * de la surveillance du courant, et repart d'un délai de watchdog neuf. */
    ReplyEnable(Safety_EnableOutputs(0U));
    return;
  }
  if (strcasecmp(arg, "OFF") == 0) {
    Safety_Disarm();
    Reply("OK");
    return;
  }

  char *end = NULL;
  unsigned long d[3];
  const char *p = arg;
  for (int i = 0; i < 3; i++) {
    d[i] = strtoul(p, &end, 10);
    if ((end == p) || (d[i] > 1000UL)) {
      Reply("ERR ARG");
      return;
    }
    p = end;
    while (*p == ' ') { p++; }
  }
  if (*p != '\0') {
    Reply("ERR ARG");
    return;
  }
  if (!Pwm_TestDutyOk((uint16_t)d[0], (uint16_t)d[1], (uint16_t)d[2])) {
    Reply("ERR LIMIT");
    return;
  }
  Pwm_SetDutyPermille((uint16_t)d[0], (uint16_t)d[1], (uint16_t)d[2]);
  Reply("OK");
}

/* `OL <amp_pm> <elec_hz> <ms>`, `OL STOP` — la boucle ouverte de l'étape 10. Les mêmes
 * contrôles du DRV que `PWM ON` ; les limites propres à la rotation sont dans `openloop.c`. */
static void CmdOpenloop(const char *arg)
{
  if (strcasecmp(arg, "STOP") == 0) {
    Openloop_Stop();
    Reply("OK");
    return;
  }
  char *end = NULL;
  const unsigned long amp = strtoul(arg, &end, 10);
  if (end == arg) { Reply("ERR ARG"); return; }
  const char *p = end;
  const float hz = strtof(p, &end);
  if (end == p) { Reply("ERR ARG"); return; }
  p = end;
  const unsigned long ms = strtoul(p, &end, 10);
  if (end == p) { Reply("ERR ARG"); return; }
  while (*end == ' ') { end++; }
  if (*end != '\0') { Reply("ERR ARG"); return; }
  if (amp > 1000UL) { Reply("ERR LIMIT"); return; }

  if (!Pwm_IsEnabled()) {
    Drv8304_Status_t st;
    if (!Drv8304_ReadFaults()) { Reply("ERR DRV"); return; }
    Drv8304_GetStatus(&st);
    if (st.nfault_low || ((st.fault_status_1 & DRV_FS1_FAULT) != 0U)) {
      Reply("ERR FAULT");
      return;
    }
  }
  SafetyEnable_t en = SAFETY_EN_OK;
  switch (Openloop_Start((uint16_t)amp, hz, (uint32_t)ms, &en)) {
    case OL_OK:         Reply("OK");        break;
    case OL_ERR_LIMIT:  Reply("ERR LIMIT"); break;
    case OL_ERR_BUSY:   Reply("ERR BUSY");  break;
    case OL_ERR_ENABLE: ReplyEnable(en);    break;
    case OL_ERR_ARG:
    default:            Reply("ERR ARG");   break;
  }
}

static void CmdOpenloopStatus(void)
{
  Openloop_Status_t o;
  Openloop_GetStatus(&o);
  Link_TxPrintf("OK active=%u amp_pm=%u hz_target_milli=%ld hz_milli=%ld theta_mrad=%ld left_ms=%lu\r\n",
                o.active ? 1U : 0U, o.amp_pm, (long)(o.hz_target * 1000.0f),
                (long)(o.hz * 1000.0f), (long)(o.theta_rad * 1000.0f),
                (unsigned long)(o.active ? Safety_PulseLeftMs() : 0UL));
}

/* `PWM.PULSE <a> <b> <c> <ms>` — l'essai de l'étape 5. Les rapports se posent, `MOE` se
 * lève, et c'est l'ISR qui le rabaisse au terme : la durée ne dépend ni de l'hôte ni de la
 * superloop. Les mêmes contrôles que `PWM ON`, dans le même ordre. */
static void CmdPwmPulse(const char *arg)
{
  unsigned long v[4];
  const char *p = arg;
  char *end = NULL;
  for (int i = 0; i < 4; i++) {
    v[i] = strtoul(p, &end, 10);
    if (end == p) {
      Reply("ERR ARG");
      return;
    }
    p = end;
    while (*p == ' ') { p++; }
  }
  if ((*p != '\0') || (v[3] == 0UL) || (v[3] > SAFETY_PULSE_MAX_MS) ||
      (v[0] > 1000UL) || (v[1] > 1000UL) || (v[2] > 1000UL)) {
    Reply("ERR ARG");
    return;
  }
  if (!Pwm_TestDutyOk((uint16_t)v[0], (uint16_t)v[1], (uint16_t)v[2])) {
    Reply("ERR LIMIT");
    return;
  }
  if (Pwm_IsEnabled()) {
    Reply("ERR BUSY");        /* une impulsion ne se greffe pas sur des sorties déjà actives */
    return;
  }
  Drv8304_Status_t st;
  if (!Drv8304_ReadFaults()) {
    Reply("ERR DRV");
    return;
  }
  Drv8304_GetStatus(&st);
  if (st.nfault_low || ((st.fault_status_1 & DRV_FS1_FAULT) != 0U)) {
    Reply("ERR FAULT");
    return;
  }
  Pwm_SetDutyPermille((uint16_t)v[0], (uint16_t)v[1], (uint16_t)v[2]);
  /* Les CCR sont préchargés : on laisse passer une mise à jour pour qu'ils soient en place
   * avant que `MOE` ne se lève. Une période PWM fait 50 µs ; 1 ms est large et invisible. */
  HAL_Delay(1U);
  ReplyEnable(Safety_EnableOutputs((uint32_t)v[3]));
}

/* `DRV.REG <addr>` lit, `DRV.REG <addr> <value>` écrit puis relit. Hexadécimal libre.
 * Écriture refusée sorties actives : un gain d'ampli changé en marche changerait la limite
 * de courant en ampères sans toucher à son chiffre. */
static void CmdDrvReg(const char *arg)
{
  char *end = NULL;
  const unsigned long addr = strtoul(arg, &end, 16);
  if ((end == arg) || (addr >= DRV_REG_COUNT)) {
    Reply("ERR ARG");
    return;
  }
  while (*end == ' ') { end++; }
  if (*end != '\0') {
    if (Pwm_IsEnabled()) {
      Reply("ERR LIVE");
      return;
    }
    char *end2 = NULL;
    const unsigned long value = strtoul(end, &end2, 16);
    if ((end2 == end) || (value > DRV_DATA_MASK)) {
      Reply("ERR ARG");
      return;
    }
    if (!Drv8304_WriteReg((uint8_t)addr, (uint16_t)value)) {
      Reply("ERR SPI");
      return;
    }
  }
  uint16_t readback;
  if (!Drv8304_ReadReg((uint8_t)addr, &readback)) {
    Reply("ERR SPI");
    return;
  }
  Link_TxPrintf("OK reg=%lX value=%03X\r\n", addr, readback);
}

/* ------------------------------------------------------------------ diagnostic analogique */

/* Une conversion régulière isolée, sur le convertisseur et la voie demandés. Le tourniquet
 * de `sensors.c` utilise les mêmes registres depuis la superloop : on attend qu'il ait
 * fini, et lui repartira de zéro au prochain passage. */
static uint16_t ConvertOnce(ADC_TypeDef *adc, uint32_t channel, uint32_t smp)
{
  while ((adc->CR & ADC_CR_ADSTART) != 0U) { }
  if (channel < 10U) {
    MODIFY_REG(adc->SMPR1, 0x7UL << (3U * channel), smp << (3U * channel));
  } else {
    MODIFY_REG(adc->SMPR2, 0x7UL << (3U * (channel - 10U)), smp << (3U * (channel - 10U)));
  }
  adc->SQR1 = (channel << ADC_SQR1_SQ1_Pos);
  adc->ISR  = ADC_ISR_EOC | ADC_ISR_EOS | ADC_ISR_OVR;
  adc->CR  |= ADC_CR_ADSTART;
  while ((adc->ISR & ADC_ISR_EOC) == 0U) { }
  return (uint16_t)adc->DR;
}

/* Rafale de conversions de VREFINT aussi serrees que possible. Un VREF+ stable donne une
 * poignee de LSB d'ecart entre le minimum et le maximum ; un ecart de plusieurs centaines
 * dit que la reference bouge d'une conversion a l'autre, et alors *toutes* les mesures de
 * la carte sont fausses, pas seulement celle-la. */
#define SCAN_N  64U

/* Rafale sur une voie, puis min/max/moyenne. Sert deux fois : sur VREFINT, dont la source
 * est interne et à haute impédance, et sur un diviseur de rail, source externe et basse
 * impédance. Si VREF+ bougeait vraiment, les deux seraient dispersées dans la même
 * proportion ; si seule la voie interne l'est, c'est la lecture qui est mauvaise et non
 * la référence. La séquence brute est donnée telle quelle : une alternance régulière et
 * un nuage aléatoire ne racontent pas la même histoire. */
/* Écart imposé entre deux conversions d'une rafale, en microsecondes. Ce réglage est le
 * seul moyen de distinguer deux causes qui donnent la même dispersion : une oscillation
 * extérieure entretenue, que l'on échantillonne trop lentement — l'écart change le motif
 * mais pas les extrêmes — et un nœud à haute impédance que les conversions pompent
 * elles-mêmes — laisser le nœud se rétablir entre deux fait fondre la dispersion. */
static uint32_t s_scan_gap_us;

static void ScanChannel(ADC_TypeDef *adc, uint32_t ch, uint32_t smp, uint16_t *out)
{
  for (uint32_t i = 0U; i < SCAN_N; i++) {
    out[i] = ConvertOnce(adc, ch, smp);
    if (s_scan_gap_us != 0U) {
      const uint32_t t0 = DWT->CYCCNT;
      while ((DWT->CYCCNT - t0) < (s_scan_gap_us * (BOARD_SYSCLK_HZ / 1000000U))) { }
    }
  }
}

static void ScanStats(const uint16_t *raw, uint16_t *lo, uint16_t *hi, uint16_t *mean)
{
  uint32_t sum = 0U;
  *lo = 0xFFFFU;
  *hi = 0U;
  for (uint32_t i = 0U; i < SCAN_N; i++) {
    sum += raw[i];
    if (raw[i] < *lo) { *lo = raw[i]; }
    if (raw[i] > *hi) { *hi = raw[i]; }
  }
  *mean = (uint16_t)(sum / SCAN_N);
}

/* Le rapport de deux voies converties au même instant ne dépend pas de VREF+ : il s'y
 * simplifie. ADC1 et ADC2 sont une paire, on peut donc les lancer côte à côte et lire un
 * rail *en unités de VREFINT*, c'est-à-dire absolument. Si ce rapport est stable alors que
 * chaque voie prise seule balaie de 43 %, c'est VREF+ qui bouge et les rails sont sains.
 * S'il balaie lui aussi, c'est le rail qui bouge, et VREF+ ne fait que le suivre. */
/* Le tampon de référence interne du MCU, branché sur la *même* broche `VREF+`, et réglé sur
 * la *même* tension que le MCP1501 — 2,048 V — pour qu'aucune des deux sources ne tire
 * contre l'autre si elles sont effectivement reliées. Ce que ce test dit : si la broche est
 * bien attachée au réseau VREF et à ses condensateurs, la mettre en basse impédance ne
 * changera pas grand-chose au balayage. Si le balayage s'arrête net, c'est que la broche
 * n'était tenue par personne — et donc qu'elle n'est reliée ni à `U5` ni aux condensateurs. */
/* Fréquence de ce qui bouge sur `VREF+`, mesurée de l'intérieur.
 *
 * L'ADC échantillonne VREFINT à cadence régulière — cadencée au compteur de cycles, pas au
 * hasard de la boucle — et on compte les passages par la moyenne. Pour une oscillation
 * propre, deux passages font une période. Le seuil d'hystérésis écarte le bruit de
 * conversion : seul un écart franc arme le passage suivant.
 *
 * Un repliement reste possible au-dessus de la moitié de la cadence. C'est pourquoi la
 * cadence est un argument : deux mesures à deux cadences qui donnent la même fréquence la
 * désignent comme réelle, deux résultats différents disent qu'on est au-dessus de Nyquist.
 *
 * Ce que ça décide : le courant qu'il faut pour faire bouger le réseau VREF de son amplitude
 * mesurée vaut C·2πf·V/2. À 25 kHz avec 4,7 µF il serait absurde, à quelques centaines de
 * hertz il est banal. La fréquence dit donc si le condensateur est réellement en place. */
static void CmdVrefFreq(const char *arg)
{
  enum { N = 512U };
  static uint16_t raw[N];          /* 1 Ko : statique, la pile de la superloop est étroite */

  uint32_t iv = (*arg != '\0') ? strtoul(arg, NULL, 10) : 10UL;
  if (iv < 8U)    { iv = 8U; }     /* sous le temps de conversion, la boucle court libre  */
  if (iv > 5000U) { iv = 5000U; }
  const uint32_t ticks = iv * (BOARD_SYSCLK_HZ / 1000000U);

  while ((ADC1->CR & ADC_CR_ADSTART) != 0U) { }
  MODIFY_REG(ADC1->SMPR2, 0x7UL << (3U * 8U), 6UL << (3U * 8U));   /* VREFINT, 247,5 cycles */
  ADC1->SQR1 = (18UL << ADC_SQR1_SQ1_Pos);

  const uint32_t t0 = DWT->CYCCNT;
  uint32_t next = t0;
  for (uint32_t i = 0U; i < N; i++) {
    while ((int32_t)(DWT->CYCCNT - next) < 0) { }
    next += ticks;
    ADC1->ISR = ADC_ISR_EOC;
    ADC1->CR |= ADC_CR_ADSTART;
    while ((ADC1->ISR & ADC_ISR_EOC) == 0U) { }
    raw[i] = (uint16_t)ADC1->DR;
  }
  const uint32_t window_us = (DWT->CYCCNT - t0) / (BOARD_SYSCLK_HZ / 1000000U);

  uint32_t sum = 0U;
  uint16_t lo = 0xFFFFU, hi = 0U;
  for (uint32_t i = 0U; i < N; i++) {
    sum += raw[i];
    if (raw[i] < lo) { lo = raw[i]; }
    if (raw[i] > hi) { hi = raw[i]; }
  }
  const uint16_t mean = (uint16_t)(sum / N);
  const uint16_t hyst = (uint16_t)((hi - lo) / 8U);

  uint32_t crossings = 0U;
  int8_t   side = 0;
  for (uint32_t i = 0U; i < N; i++) {
    int8_t now = side;
    if (raw[i] > (mean + hyst))      { now = 1; }
    else if (raw[i] < (mean - hyst)) { now = -1; }
    if ((now != 0) && (side != 0) && (now != side)) { crossings++; }
    side = now;
  }
  /* Deux passages par période ; en hertz, avec une fenêtre en microsecondes. */
  const uint32_t freq_hz = (window_us != 0U) ? (crossings * 500000UL / window_us) : 0UL;

  Link_TxPrintf("OK n=%u interval_us=%lu window_us=%lu raw_min=%u raw_max=%u raw_mean=%u "
                "crossings=%lu freq_hz=%lu seq=",
                (unsigned)N, (unsigned long)iv, (unsigned long)window_us, lo, hi, mean,
                (unsigned long)crossings, (unsigned long)freq_hz);
  for (uint32_t i = 0U; i < 16U; i++) {
    Link_TxPrintf("%u%s", raw[i], (i == 15U) ? "\r\n" : ",");
  }
  Sensors_Restart();
}

/* Echelles du tampon interne. 2900 est la seule qui depasse le seuil de sous-tension de
 * 2,6 V de la broche VREF du DRV8304 : c'est elle qui permet de savoir, sans fer a souder,
 * si les amplis de shunt sont simplement tenus eteints par cette protection. */
/* ------------------------------------------------------------------ AS5600 (etape 6)
 *
 * `ENC?` donne le budget de retard de l'etape 6 en une ligne : duree de transfert,
 * intervalle entre echantillons, et pire age vu par l'ISR. Les deux premiers disent si le
 * bus tient la cadence, le troisieme dit ce que la boucle de controle subit reellement. */
static void CmdEncStatus(void)
{
  Encoder_t e;
  Encoder_Get(&e);
  Link_TxPrintf("OK present=%u magnet=%u status=%02X mag=%u raw=%u turns=%ld "
                "pos_mrad=%ld vel_mrad_s=%ld bus_hz=%lu xfer_us=%u period_us=%u "
                "age_max_us=%u ok=%lu err=%lu\r\n",
                e.present ? 1U : 0U, e.magnet_ok ? 1U : 0U, (unsigned)e.status_raw,
                (unsigned)e.magnitude, e.raw_angle, (long)e.turns,
                (long)(e.pos_rad * 1000.0f), (long)(e.vel_rad_s * 1000.0f),
                (unsigned long)e.bus_hz, e.xfer_us, e.period_us, e.age_max_us,
                (unsigned long)e.reads_ok, (unsigned long)e.reads_err);
}

static void CmdEncReg(const char *arg)
{
  char *end = NULL;
  const unsigned long reg = strtoul(arg, &end, 0);
  unsigned long len = 1UL;
  if ((end != NULL) && (*end != '\0')) {
    len = strtoul(end, NULL, 0);
  }
  if ((reg > 0xFFUL) || (len < 1UL) || (len > 8UL)) {
    Reply("ERR ARG");
    return;
  }
  uint8_t buf[8] = {0};
  if (!Encoder_ReadReg((uint8_t)reg, buf, (uint8_t)len)) {
    Reply("ERR I2C");
    return;
  }
  Link_TxPrintf("OK reg=%02lX len=%lu", reg, len);
  for (unsigned long i = 0UL; i < len; i++) {
    Link_TxPrintf(" %02X", buf[i]);
  }
  Reply("");
}

static void CmdEncBus(const char *arg)
{
  Reply(Encoder_SetBusHz(strtoul(arg, NULL, 0)) ? "OK" : "ERR ARG");
}

static void CmdVrefBuf(const char *arg)
{
  const char *mv = NULL;
  if (strncasecmp(arg, "ON", 2U) == 0) {
    uint32_t vrs = 0U;                       /* 2,048 V par defaut */
    const char *p = arg + 2U;
    while ((*p == ' ') || (*p == '\t')) { p++; }
    if (*p != '\0') {
      if (strcmp(p, "2048") == 0)      { vrs = 0U; }
      else if (strcmp(p, "2500") == 0) { vrs = VREFBUF_CSR_VRS_0; }
      else if (strcmp(p, "2900") == 0) { vrs = VREFBUF_CSR_VRS_1; }
      else { Reply("ERR ARG"); return; }
    }
    const uint32_t target_mv = (vrs == 0U) ? 2048UL
                             : ((vrs == VREFBUF_CSR_VRS_0) ? 2500UL : 2900UL);
    mv = (vrs == 0U) ? "2048" : ((vrs == VREFBUF_CSR_VRS_0) ? "2500" : "2900");

    /* Refus si quelqu'un tient déjà la broche plus haut que la consigne.
     *
     * Depuis la retouche du 2026-09-21, `VREF+` est câblé sur le rail 3,3 V. Activer le
     * tampon interne reviendrait à lui demander de tirer la broche à 2,048 V contre un
     * LDO : il se mettrait en limitation sans jamais lever `VRR`, et les mesures
     * seraient fausses sans que rien ne le dise. C'est exactement le genre d'erreur de
     * configuration silencieuse qu'une carte retouchée à la main finit par produire.
     *
     * La marge de 150 mV est large devant l'incertitude de `VREFINT` (±1 %, soit 33 mV à
     * 3,3 V) et étroite devant le plus petit écart qui nous intéresse (3300 − 2900). Un
     * `vref_mv` à zéro veut dire que le tourniquet n'a pas encore publié : on laisse
     * passer plutôt que de bloquer sur une absence de mesure. */
    Sensors_t sn;
    Sensors_Get(&sn);
    if ((sn.vref_mv != 0U) && ((uint32_t)sn.vref_mv > (target_mv + 150UL))) {
      Link_TxPrintf("ERR DRIVEN vref_mv=%u target_mv=%lu\r\n",
                    sn.vref_mv, (unsigned long)target_mv);
      return;
    }

    __HAL_RCC_SYSCFG_CLK_ENABLE();
    MODIFY_REG(VREFBUF->CSR, VREFBUF_CSR_VRS | VREFBUF_CSR_HIZ, vrs);  /* pilote la broche */
    SET_BIT(VREFBUF->CSR, VREFBUF_CSR_ENVR);
    uint32_t guard = 0U;
    while (((VREFBUF->CSR & VREFBUF_CSR_VRR) == 0U) && (guard < 100000U)) { guard++; }
    Link_TxPrintf("OK csr=%08lX ready=%u nominal_mv=%s\r\n", (unsigned long)VREFBUF->CSR,
                  ((VREFBUF->CSR & VREFBUF_CSR_VRR) != 0U) ? 1U : 0U, mv);
  } else if (strcasecmp(arg, "OFF") == 0) {
    VREFBUF->CSR = VREFBUF_CSR_HIZ;     /* tampon coupé, broche rendue à l'extérieur */
    Link_TxPrintf("OK csr=%08lX ready=0\r\n", (unsigned long)VREFBUF->CSR);
  } else {
    Reply("ERR ARG");
  }
}

/* Les trois lignes du SPI relues en entree numerique, tirees vers le bas puis vers le haut.
 * Au repos nCS est haut, donc le DRV relache `SDO` : la ligne doit suivre le tirage. Trois
 * verdicts possibles, et ils ne se reparent pas de la meme facon.
 *
 *   pullup=1 pulldown=0  la ligne est libre — le DRV ne pilote rien, le defaut est ailleurs
 *   pullup=0 pulldown=0  quelque chose la tient basse — court-circuit, ou SDO colle bas
 *   pullup=1 pulldown=1  quelque chose la tient haute — court-circuit vers 3,3 V
 *
 * Restaure l'alternate a la fin : sans ca le SPI resterait muet jusqu'au prochain reset. */
static void CmdDrvPins(void)
{
  GPIO_InitTypeDef g = {0};
  const uint32_t pins = PIN_SPI_MISO | PIN_SPI_SCK | PIN_SPI_MOSI;
  uint32_t down = 0U, up = 0U;

  g.Pin   = pins;
  g.Mode  = GPIO_MODE_INPUT;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  g.Pull  = GPIO_PULLDOWN;
  HAL_GPIO_Init(GPIOB, &g);
  HAL_Delay(2U);
  down = GPIOB->IDR & pins;
  g.Pull = GPIO_PULLUP;
  HAL_GPIO_Init(GPIOB, &g);
  HAL_Delay(2U);
  up = GPIOB->IDR & pins;

  g.Mode      = GPIO_MODE_AF_PP;
  g.Alternate = GPIO_AF5_SPI2;
  g.Pin       = PIN_SPI_SCK | PIN_SPI_MOSI;
  g.Pull      = GPIO_NOPULL;
  HAL_GPIO_Init(GPIOB, &g);
  /* Sans tirage, comme `Drv8304_Init` : la resistance externe existe et une seconde en
   * parallele ne ferait que deplacer le niveau continu du bus. Laisser la commande de
   * diagnostic poser une configuration que le firmware ne choisit nulle part est
   * exactement le genre d'ecart qui se paie deux jours plus tard. */
  g.Pin = PIN_SPI_MISO;
  HAL_GPIO_Init(GPIOB, &g);

  Link_TxPrintf("OK miso=%lu,%lu sck=%lu,%lu mosi=%lu,%lu ncs=%lu\r\n",
                (unsigned long)((down & PIN_SPI_MISO) != 0U),
                (unsigned long)((up   & PIN_SPI_MISO) != 0U),
                (unsigned long)((down & PIN_SPI_SCK) != 0U),
                (unsigned long)((up   & PIN_SPI_SCK) != 0U),
                (unsigned long)((down & PIN_SPI_MOSI) != 0U),
                (unsigned long)((up   & PIN_SPI_MOSI) != 0U),
                (unsigned long)(HAL_GPIO_ReadPin(PIN_DRV_NCS_PORT, PIN_DRV_NCS) ==
                                GPIO_PIN_SET));
}

/* `nCS` et `SDO` relus ensemble, en entree, avec des tirages opposes.
 *
 * Ecrite parce qu'une hypothese manquait a l'appel et qu'elle expliquait tout autrement.
 * `DRV.BITBANG` rend `cs=0 idle=1` : `MISO` suit exactement le niveau de `nCS`. On en a
 * conclu que le DRV pilotait `SDO` parce qu'il se voyait selectionne — mais **deux lignes
 * reliees entre elles donnent la meme trace**, sans qu'aucun composant ne fasse quoi que
 * ce soit. Tant que ce doute tient, « le composant est vivant » n'est pas acquis, et on
 * enverrait quelqu'un verifier deux fils alors que le defaut serait ailleurs.
 *
 * Le montage separe les deux cas sans jamais piloter quoi que ce soit — que des entrees,
 * donc aucun conflit possible :
 *
 *   `nCS` en entree tiree vers le **bas**. Si le fil ne va qu'au DRV, dont l'entree est en
 *   haute impedance, rien ne s'oppose au tirage : la broche lit 0 et le DRV se croit
 *   selectionne.
 *   `MISO` en entree tiree vers le **haut**, en plus de sa resistance externe. Seul un
 *   pilotage actif peut encore la faire descendre.
 *
 * Trois verdicts, et ils envoient a trois endroits differents :
 *
 *   `ncs=0 miso=0`  ALIVE : lignes separees, et le DRV a bien reagi a la selection en
 *                   tirant `SDO` bas contre le tirage. Le composant est alimente et
 *                   reveille, et le defaut est sur `SCLK` ou `SDI`.
 *   `ncs=0 miso=1`  MUTE : lignes separees, et le DRV n'a pas repondu. Ce n'est plus une
 *                   histoire de fil de bus — il faut regarder son alimentation.
 *   `ncs=1 ...`     TIED : quelque chose tient `nCS` haut alors que rien ne devrait. La
 *                   resistance externe de `SDO` en est la source la plus probable, ce qui
 *                   veut dire que les deux lignes se touchent.
 *
 * Restaure `nCS` en sortie haute et `MISO` a l'alternate sans tirage, c'est-a-dire l'etat
 * exact que pose `Drv8304_Init` — sinon le bus resterait dans une configuration que le
 * firmware ne choisit nulle part. */
static void CmdDrvNcs(void)
{
  GPIO_InitTypeDef g = {0};

  g.Mode  = GPIO_MODE_INPUT;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  g.Pull  = GPIO_PULLDOWN;
  g.Pin   = PIN_DRV_NCS;
  HAL_GPIO_Init(PIN_DRV_NCS_PORT, &g);
  g.Pull  = GPIO_PULLUP;
  g.Pin   = PIN_SPI_MISO;
  HAL_GPIO_Init(PIN_SPI_MISO_PORT, &g);
  /* Le DRV8304 met quelques microsecondes a prendre la main sur `SDO` apres la selection ;
   * deux millisecondes couvrent ca et la constante de temps du bus avec une large marge. */
  HAL_Delay(2U);

  const uint32_t ncs =
      (HAL_GPIO_ReadPin(PIN_DRV_NCS_PORT, PIN_DRV_NCS) == GPIO_PIN_SET) ? 1U : 0U;
  const uint32_t miso =
      (HAL_GPIO_ReadPin(PIN_SPI_MISO_PORT, PIN_SPI_MISO) == GPIO_PIN_SET) ? 1U : 0U;

  HAL_GPIO_WritePin(PIN_DRV_NCS_PORT, PIN_DRV_NCS, GPIO_PIN_SET);
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Pin  = PIN_DRV_NCS;
  HAL_GPIO_Init(PIN_DRV_NCS_PORT, &g);
  g.Mode      = GPIO_MODE_AF_PP;
  g.Alternate = GPIO_AF5_SPI2;
  g.Pin       = PIN_SPI_MISO;
  HAL_GPIO_Init(PIN_SPI_MISO_PORT, &g);

  Link_TxPrintf("OK ncs=%lu miso=%lu verdict=%s\r\n", (unsigned long)ncs,
                (unsigned long)miso,
                (ncs != 0U) ? "TIED" : ((miso != 0U) ? "MUTE" : "ALIVE"));
}

/* Martele une lecture de registre pendant quelques secondes, pour qu'on puisse poser un
 * oscilloscope sur les quatre lignes du SPI et declencher dessus. Une lecture isolee dure
 * 15 µs et ne se rattrape pas a la main ; c'est la meme raison qui avait fait ecrire
 * `IMOT.WIGGLE`. Compte les echanges qui ont abouti et ce qu'ils ont rendu, pour que la
 * mesure au scope ait tout de suite son pendant numerique. */
static void CmdDrvLoop(const char *arg)
{
  uint32_t ms = (*arg != '\0') ? strtoul(arg, NULL, 10) : 2000UL;
  if (ms == 0UL) { ms = 2000UL; }
  if (ms > 20000UL) { ms = 20000UL; }

  /* Mot emis brut, reponse brute, sans masquage. `Drv8304_ReadReg` ne rend que les 11 bits
   * de donnees, et c'est ce masquage qui cachait l'information utile : `0x0000` (ligne tenue
   * basse), `0xFFFF` (elle flotte haute, le composant ne repond pas) et un echo du mot emis
   * (les deux lignes en court-circuit) donnent tous les trois une donnee nulle.
   *
   * La trame de lecture du registre 0 vaut `0x8000` : adresse nulle et **donnees nulles**.
   * On emet donc en plus `0x5555`, qui n'a aucun bit en commun avec elle, pour que l'echo
   * eventuel se voie. */
  const uint32_t t0 = HAL_GetTick();
  uint32_t n = 0U, ok = 0U;
  uint16_t rx_read = 0U, rx_pat = 0U;
  while ((HAL_GetTick() - t0) < ms) {
    uint16_t v = 0U;
    if (Drv8304_TransferRaw(0x8000U, &v)) { ok++; rx_read = v; }
    n++;
  }
  (void)Drv8304_TransferRaw(0x5555U, &rx_pat);

  Link_TxPrintf("OK reads=%lu ok=%lu tx=8000 rx=%04X tx=5555 rx=%04X ms=%lu\r\n",
                (unsigned long)n, (unsigned long)ok, rx_read, rx_pat, (unsigned long)ms);
}

/* Attente courte, comptee en cycles DWT. `HAL_Delay` a une resolution d'une milliseconde :
 * beaucoup trop grossiere pour cadencer une trame a la main, et une trame de 16 bits y
 * prendrait 50 ms. */
static void Spin(uint32_t cycles)
{
  const uint32_t t0 = DWT->CYCCNT;
  while ((DWT->CYCCNT - t0) < cycles) { }
}

/* Une trame SPI de 16 bits pilotee a la main, ~10 µs par bit, en echantillonnant `MISO`
 * aux deux fronts. C'est la verite terrain quand le peripherique materiel rend zero sans
 * qu'on sache pourquoi, et ca remplace un oscilloscope :
 *
 *   `cs` est `MISO` juste apres la descente de nCS, avant le moindre coup d'horloge. Le
 *   DRV8304 ne pilote `SDO` que pendant que nCS est bas : `cs=0` dit qu'il a pris la main,
 *   `cs=1` qu'il n'a rien vu passer.
 *   `fall` est le mot echantillonne sur les fronts descendants — c'est ce que fait le
 *   peripherique en mode 1, donc il doit valoir ce que rend `DRV.LOOP`.
 *   `rise` est le meme mot echantillonne sur les fronts montants. S'il porte une valeur
 *   sensee alors que `fall` est nul, le defaut est un demi-coup d'horloge de decalage,
 *   c'est-a-dire une erreur de mode — et non un fil.
 */
static void CmdDrvBitbang(const char *arg)
{
  const uint16_t tx = (uint16_t)((*arg != '\0') ? strtoul(arg, NULL, 16) : 0x8000UL);
  GPIO_InitTypeDef g = {0};
  uint16_t rise = 0U, fall = 0U;

  g.Mode  = GPIO_MODE_OUTPUT_PP;
  g.Pull  = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  g.Pin   = PIN_SPI_SCK | PIN_SPI_MOSI;
  HAL_GPIO_Init(GPIOB, &g);
  g.Mode = GPIO_MODE_INPUT;
  g.Pin  = PIN_SPI_MISO;
  HAL_GPIO_Init(GPIOB, &g);

  HAL_GPIO_WritePin(GPIOB, PIN_SPI_SCK, GPIO_PIN_RESET);      /* CPOL = 0 */
  HAL_GPIO_WritePin(PIN_DRV_NCS_PORT, PIN_DRV_NCS, GPIO_PIN_RESET);
  Spin(200U);
  const uint32_t at_cs = (GPIOB->IDR & PIN_SPI_MISO) != 0U ? 1U : 0U;

  for (int32_t b = 15; b >= 0; b--) {
    HAL_GPIO_WritePin(GPIOB, PIN_SPI_MOSI,
                      ((tx >> (uint32_t)b) & 1U) != 0U ? GPIO_PIN_SET : GPIO_PIN_RESET);
    Spin(200U);
    HAL_GPIO_WritePin(GPIOB, PIN_SPI_SCK, GPIO_PIN_SET);
    Spin(200U);
    rise = (uint16_t)((rise << 1) | (((GPIOB->IDR & PIN_SPI_MISO) != 0U) ? 1U : 0U));
    HAL_GPIO_WritePin(GPIOB, PIN_SPI_SCK, GPIO_PIN_RESET);
    Spin(200U);
    fall = (uint16_t)((fall << 1) | (((GPIOB->IDR & PIN_SPI_MISO) != 0U) ? 1U : 0U));
  }

  HAL_GPIO_WritePin(PIN_DRV_NCS_PORT, PIN_DRV_NCS, GPIO_PIN_SET);
  Spin(200U);
  const uint32_t at_idle = (GPIOB->IDR & PIN_SPI_MISO) != 0U ? 1U : 0U;

  g.Mode      = GPIO_MODE_AF_PP;
  g.Alternate = GPIO_AF5_SPI2;
  g.Pin       = PIN_SPI_SCK | PIN_SPI_MISO | PIN_SPI_MOSI;
  HAL_GPIO_Init(GPIOB, &g);

  Link_TxPrintf("OK tx=%04X cs=%lu rise=%04X fall=%04X idle=%lu\r\n",
                tx, (unsigned long)at_cs, rise, fall, (unsigned long)at_idle);
}

/* ------------------------------------------------------- chaine de courant (etape 4)
 *
 * `IMOT.CAL` leve la broche `CAL` du DRV pendant la campagne — entrees des amplificateurs
 * court-circuitees, donc zero vrai de la chaine — et **memorise** le resultat comme offset
 * de travail. `IMOT.NOISE` ne touche a rien et ne memorise rien : elle mesure la chaine
 * telle qu'elle travaille. L'ecart entre les deux est l'information utile.
 *
 * Bloquant le temps de la campagne, ce qui est admissible : on est dans la console, MOE est
 * coupe, et une seconde de boucle a 20 kHz suffit largement. Le watchdog de flux de
 * commandes ne s'applique pas, les sorties etant inactives. */
static void CmdImotCampaign(const char *arg, bool store, bool use_cal)
{
  uint32_t n = (*arg != '\0') ? strtoul(arg, NULL, 10) : 4000UL;
  if (n == 0UL) { n = 4000UL; }
  if (n > IMOT_CAL_MAX_SAMPLES) { n = IMOT_CAL_MAX_SAMPLES; }

  if (!Imot_StartCampaign(n, store, use_cal)) {
    Reply("ERR BUSY");
    return;
  }
  /* Deux fois la duree attendue, puis on abandonne : si l'ISR ne tourne pas, mieux vaut
   * le dire que rester bloque dans la console. */
  const uint32_t deadline = HAL_GetTick() + (n / (PWM_FREQ_HZ / 1000UL)) + 200UL;
  while (Imot_Busy() && ((int32_t)(HAL_GetTick() - deadline) < 0)) { }
  if (Imot_Busy()) {
    Reply("ERR NOISR");
    return;
  }

  Imot_Campaign_t c;
  Imot_GetCampaign(&c);
  Link_TxPrintf("OK n=%lu cal=%u mean=%u,%u,%u min=%u,%u,%u max=%u,%u,%u "
                "sigma_mcnt=%u,%u,%u\r\n",
                (unsigned long)c.samples, c.used_cal_pin ? 1U : 0U,
                c.mean[0], c.mean[1], c.mean[2], c.min[0], c.min[1], c.min[2],
                c.max[0], c.max[1], c.max[2],
                c.sigma_mcnt[0], c.sigma_mcnt[1], c.sigma_mcnt[2]);
}

static void CmdImotStatus(void)
{
  uint16_t off[3];
  bool measured = false;
  Imot_GetOffsets(off, &measured);
  Ctrl_Stats_t st;
  Ctrl_GetStats(&st);
  /* `measured=0` veut dire que l'offset est la mi-echelle theorique et non une mesure :
   * les courants centres sont alors indicatifs, pas justes. */
  uint16_t g[3];
  Imot_GetGains(g);
  uint32_t rc[3];
  Imot_GetReconstructions(rc);
  Link_TxPrintf("OK measured=%u offset=%u,%u,%u raw=%u,%u,%u centered=%d,%d,%d "
                "gain_pm=%u,%u,%u recon=%lu,%lu,%lu\r\n",
                measured ? 1U : 0U, off[0], off[1], off[2],
                st.raw_ia, st.raw_ib, st.raw_ic,
                st.cent_ia, st.cent_ib, st.cent_ic, g[0], g[1], g[2],
                (unsigned long)rc[0], (unsigned long)rc[1], (unsigned long)rc[2]);
}

static void CmdVrefRatio(void)
{
  static const struct { uint8_t ch; const char *name; } k[] = {
    { 4U, "v3v3" }, { 3U, "v5" }, { 13U, "vin" }, { 12U, "vmot" },
  };
  Link_TxPrintf("OK held=%u", AdcSync_IsHeld() ? 1U : 0U);
  for (uint32_t s = 0U; s < (sizeof(k) / sizeof(k[0])); s++) {
    uint32_t lo = 0xFFFFFFFFUL, hi = 0U, sum = 0U;

    while (((ADC1->CR | ADC2->CR) & ADC_CR_ADSTART) != 0U) { }
    MODIFY_REG(ADC1->SMPR2, 0x7UL << (3U * 8U), 6UL << (3U * 8U));   /* VREFINT, 247,5 */
    MODIFY_REG(ADC2->SMPR1, 0x7UL << (3U * k[s].ch), 6UL << (3U * k[s].ch));
    ADC1->SQR1 = (18UL << ADC_SQR1_SQ1_Pos);
    ADC2->SQR1 = ((uint32_t)k[s].ch << ADC_SQR1_SQ1_Pos);

    for (uint32_t i = 0U; i < SCAN_N; i++) {
      ADC1->ISR = ADC_ISR_EOC;
      ADC2->ISR = ADC_ISR_EOC;
      ADC1->CR |= ADC_CR_ADSTART;      /* deux cycles d'écart, sur 247,5 d'échantillonnage */
      ADC2->CR |= ADC_CR_ADSTART;
      while (((ADC1->ISR & ADC_ISR_EOC) == 0U) || ((ADC2->ISR & ADC_ISR_EOC) == 0U)) { }
      const uint32_t ref = ADC1->DR;
      const uint32_t rail = ADC2->DR;
      const uint32_t r = (ref != 0U) ? (rail * 1000UL / ref) : 0UL;
      sum += r;
      if (r < lo) { lo = r; }
      if (r > hi) { hi = r; }
    }
    Link_TxPrintf(" %s/vrefint=%lu/%lu/%lu", k[s].name, (unsigned long)lo,
                  (unsigned long)hi, (unsigned long)(sum / SCAN_N));
  }
  Link_TxPrintf("\r\n");
  Sensors_Restart();
}

static void CmdVrefScan(const char *arg)
{
  /* Quatre voies, deux convertisseurs. `Vin` est la seule qui ne sature à aucun moment de
   * l'oscillation : c'est elle qui dit si VREF+ bouge vraiment. Si VREF+ balaie, toutes
   * les voies se dispersent dans le *même* rapport, puisqu'elles sont toutes ratiométriques
   * de lui. Si seule VREFINT est dispersée, c'est sa lecture qui est mauvaise, pas la
   * référence — et la carte n'a alors qu'un problème de mesure, pas d'alimentation. */
  static const struct { ADC_TypeDef *adc; uint8_t ch; uint8_t smp; const char *name; } k[] = {
    { ADC1, 18U, 7U, "vrefint" },   /* référence interne, source à haute impédance */
    { ADC2, 13U, 6U, "vin"     },   /* PA5, diviseur ×13 — ne sature pas            */
    { ADC2, 12U, 6U, "vmot"    },   /* PB2, diviseur ×16                            */
    { ADC2,  4U, 6U, "v3v3"    },   /* PA7, diviseur ×1,68 — sature en haut         */
  };
  uint16_t raw[SCAN_N];
  uint16_t lo, hi, mean;

  s_scan_gap_us = (*arg != '\0') ? strtoul(arg, NULL, 10) : 0UL;
  Link_TxPrintf("OK held=%u gap_us=%lu", AdcSync_IsHeld() ? 1U : 0U,
                (unsigned long)s_scan_gap_us);
  for (uint32_t s = 0U; s < (sizeof(k) / sizeof(k[0])); s++) {
    ScanChannel(k[s].adc, k[s].ch, k[s].smp, raw);
    ScanStats(raw, &lo, &hi, &mean);
    /* Le rapport max/min en millièmes : c'est lui qui se compare d'une voie à l'autre. */
    Link_TxPrintf(" %s=%u/%u/%u:%lu", k[s].name, lo, hi, mean,
                  (unsigned long)((lo != 0U) ? ((uint32_t)hi * 1000UL / lo) : 0UL));
  }
  /* La séquence de VREFINT en clair : une sinusoïde repliée et un nuage aléatoire ne
   * racontent pas la même histoire. */
  ScanChannel(ADC1, 18U, 7U, raw);
  Link_TxPrintf(" seq=");
  for (uint32_t i = 0U; i < 12U; i++) {
    Link_TxPrintf("%u%s", raw[i], (i == 11U) ? "\r\n" : ",");
  }
  Sensors_Restart();
}

/* Impédance des trois entrées de courant, sans oscilloscope. Chaque broche est forcée en
 * sortie pendant 20 µs, puis relâchée en analogique et convertie tout de suite, puis 2 ms
 * plus tard. Une sortie d'amplificateur (quelques centaines d'ohms) a déjà repris la main
 * à la première conversion : les deux valeurs se ressemblent, et ne dépendent pas du sens
 * du forçage. Un nœud flottant garde la charge : première valeur collée au rail forcé,
 * seconde qui a dérivé. C'est la seule mesure ici qui ne dépend ni de VREF+ ni du DRV. */
/* Décroissance d'un nœud chargé, comparée à une broche qu'on sait reliée à rien.
 *
 * `IMOT.Z` dit qu'une entrée de courant est flottante. Elle ne dit pas *où* la chaîne est
 * coupée — côté MCU, ou plus loin. Cette mesure-là le dit, et sans oscilloscope.
 *
 * Le principe : une broche en analogique, isolée de tout, ne perd sa charge que par sa
 * propre fuite, de l'ordre du nanoampère. Sur la dizaine de picofarads d'une broche, la
 * constante de temps se compte en secondes. Reliée à une piste et à une broche de circuit
 * au bout, elle voit en plus les diodes de protection et les fuites de cet étage : la
 * décroissance s'effondre. `PA3` est marquée « no connect » au schéma, du même côté du
 * boîtier que les trois autres : c'est le témoin.
 *
 * Lecture du résultat. Les trois voies de courant s'écroulent nettement plus vite que `PA3`
 * → la piste est bonne et c'est l'étage au bout qui ne pilote pas. Elles décroissent comme
 * `PA3` → la broche du MCU ne voit rien, et la coupure est de ce côté-là.
 *
 * Chaque point est repris d'une charge neuve. Sinon le condensateur d'échantillonnage de
 * l'ADC, qui vole un peu de charge à chaque conversion, ajouterait sa propre décroissance
 * à celle qu'on mesure. */
/* Continuité d'une entrée de courant, testée depuis le MCU plutôt qu'à l'ohmmètre.
 *
 * Sur un boîtier dense, poser deux pointes de touche entre une broche du DRV et une broche
 * du MCU est pénible et faux une fois sur deux. Ici le MCU fournit le signal : il bat la
 * broche choisie en créneau à 1 kHz, et il suffit d'une seule sonde, posée sur la broche
 * correspondante de U3 — 23 pour A, 22 pour B, 21 pour C. Le créneau y est, la piste est
 * bonne ; il n'y a rien, elle est coupée, et on sait de quel côté chercher.
 *
 * Le créneau plutôt qu'un niveau continu : il se reconnaît sans ambiguïté, il ne se confond
 * pas avec une tension de repos, et il traverse une sonde en position AC.
 *
 * Le groupe injecté est figé pendant l'essai — il convertit ces mêmes broches, et une
 * conversion pendant qu'on les pilote en sortie ne mesurerait rien d'utile. `MOE` est coupé
 * d'abord : on force des broches analogiques, l'étage de puissance n'a rien à faire là. */
static void CmdImotWiggle(const char *arg)
{
  uint16_t pin;
  const char *where;

  if (strncasecmp(arg, "A", 1) == 0)      { pin = PIN_IMOTA;   where = "U3 pin 23"; }
  else if (strncasecmp(arg, "B", 1) == 0) { pin = PIN_IMOTB;   where = "U3 pin 22"; }
  else if (strncasecmp(arg, "C", 1) == 0) { pin = PIN_IMOTC;   where = "U3 pin 21"; }
  else { Reply("ERR ARG"); return; }

  while ((*arg != '\0') && (*arg != ' ')) { arg++; }
  while (*arg == ' ') { arg++; }
  uint32_t ms = (*arg != '\0') ? strtoul(arg, NULL, 10) : 5000UL;
  if (ms < 100U)   { ms = 100U; }
  if (ms > 20000U) { ms = 20000U; }

  const bool was_held = AdcSync_IsHeld();
  Pwm_Disable();
  AdcSync_SetHold(true);

  GPIO_InitTypeDef g = {0};
  g.Pin   = pin;
  g.Mode  = GPIO_MODE_OUTPUT_PP;
  g.Pull  = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOA, &g);

  const uint32_t half = (BOARD_SYSCLK_HZ / 2000U);   /* demi-période de 1 kHz, en cycles */
  const uint32_t end  = HAL_GetTick() + ms;
  while ((int32_t)(HAL_GetTick() - end) < 0) {
    HAL_GPIO_WritePin(GPIOA, pin, GPIO_PIN_SET);
    uint32_t t0 = DWT->CYCCNT;
    while ((DWT->CYCCNT - t0) < half) { }
    HAL_GPIO_WritePin(GPIOA, pin, GPIO_PIN_RESET);
    t0 = DWT->CYCCNT;
    while ((DWT->CYCCNT - t0) < half) { }
  }

  g.Mode = GPIO_MODE_ANALOG;
  HAL_GPIO_Init(GPIOA, &g);
  if (!was_held) { AdcSync_SetHold(false); }
  Sensors_Restart();

  Link_TxPrintf("OK driven=%lu ms at 1 kHz square, probe %s\r\n", (unsigned long)ms, where);
}

static void CmdImotDecay(void)
{
  static const struct { uint16_t pin; uint8_t ch; const char *name; } k[4] = {
    { PIN_IMOTA, 1U, "a" }, { PIN_IMOTB, 2U, "b" }, { PIN_IMOTC, 3U, "c" },
    { GPIO_PIN_3, 4U, "nc" },   /* PA3, sans liaison au schéma — le témoin */
  };
  static const uint32_t delay_us[5] = { 0U, 200U, 1000U, 5000U, 25000U };
  uint16_t r[4][5];

  /* Le groupe injecté convertit ces mêmes broches à 20 kHz : chaque conversion y prend de
   * la charge, et mesurerait sa propre perturbation. On le fige, et on le rend ensuite. */
  const bool was_held = AdcSync_IsHeld();
  Pwm_Disable();
  AdcSync_SetHold(true);

  for (uint32_t i = 0U; i < 4U; i++) {
    for (uint32_t d = 0U; d < 5U; d++) {
      GPIO_InitTypeDef g = {0};
      g.Pin   = k[i].pin;
      g.Mode  = GPIO_MODE_OUTPUT_PP;
      g.Pull  = GPIO_NOPULL;
      g.Speed = GPIO_SPEED_FREQ_LOW;
      HAL_GPIO_Init(GPIOA, &g);
      HAL_GPIO_WritePin(GPIOA, k[i].pin, GPIO_PIN_SET);
      uint32_t t0 = DWT->CYCCNT;
      while ((DWT->CYCCNT - t0) < (200U * (BOARD_SYSCLK_HZ / 1000000U))) { }

      g.Mode = GPIO_MODE_ANALOG;
      HAL_GPIO_Init(GPIOA, &g);
      if (delay_us[d] >= 1000U) {
        HAL_Delay(delay_us[d] / 1000U);
      } else if (delay_us[d] != 0U) {
        t0 = DWT->CYCCNT;
        while ((DWT->CYCCNT - t0) < (delay_us[d] * (BOARD_SYSCLK_HZ / 1000000U))) { }
      }
      r[i][d] = ConvertOnce(ADC1, k[i].ch, 6U);   /* 247,5 cycles */
    }
  }

  if (!was_held) { AdcSync_SetHold(false); }
  Sensors_Restart();

  Link_TxPrintf("OK charge_us=200 delays_us=0,200,1000,5000,25000");
  for (uint32_t i = 0U; i < 4U; i++) {
    Link_TxPrintf(" %s=%u,%u,%u,%u,%u%s", k[i].name,
                  r[i][0], r[i][1], r[i][2], r[i][3], r[i][4],
                  (i == 3U) ? "\r\n" : "");
  }
}

static void CmdImotZ(void)
{
  static const struct { uint16_t pin; ADC_TypeDef *adc; uint8_t ch; } k[3] = {
    { PIN_IMOTA, ADC2, 1U }, { PIN_IMOTB, ADC2, 2U }, { PIN_IMOTC, ADC1, 3U },
  };
  uint16_t r[3][2][2];   /* [voie][0 = forcé bas, 1 = forcé haut][instant] */

  for (uint32_t i = 0U; i < 3U; i++) {
    for (uint32_t lvl = 0U; lvl < 2U; lvl++) {
      GPIO_InitTypeDef g = {0};
      g.Pin   = k[i].pin;
      g.Mode  = GPIO_MODE_OUTPUT_PP;
      g.Pull  = GPIO_NOPULL;
      g.Speed = GPIO_SPEED_FREQ_LOW;
      HAL_GPIO_Init(GPIOA, &g);
      HAL_GPIO_WritePin(GPIOA, k[i].pin, (lvl != 0U) ? GPIO_PIN_SET : GPIO_PIN_RESET);
      const uint32_t t0 = DWT->CYCCNT;
      while ((DWT->CYCCNT - t0) < (20U * (BOARD_SYSCLK_HZ / 1000000U))) { }
      g.Mode = GPIO_MODE_ANALOG;
      HAL_GPIO_Init(GPIOA, &g);
      r[i][lvl][0] = ConvertOnce(k[i].adc, k[i].ch, 6U);   /* 247,5 cycles */
      HAL_Delay(2U);
      r[i][lvl][1] = ConvertOnce(k[i].adc, k[i].ch, 6U);
    }
  }
  Link_TxPrintf("OK a_lo=%u,%u a_hi=%u,%u b_lo=%u,%u b_hi=%u,%u c_lo=%u,%u c_hi=%u,%u\r\n",
                r[0][0][0], r[0][0][1], r[0][1][0], r[0][1][1],
                r[1][0][0], r[1][0][1], r[1][1][0], r[1][1][1],
                r[2][0][0], r[2][0][1], r[2][1][0], r[2][1][1]);
  Sensors_Restart();
}

void Console_ExecuteLine(const char *line)
{
  const char *arg = NULL;

  if (line[0] == '\0') {
    Reply("ERR EMPTY");
  } else if (Match(line, "PING", &arg)) {
    if (*arg != '\0') { Link_TxPrintf("OK %s\r\n", arg); } else { Reply("OK"); }
  } else if (Match(line, "INFO?", NULL)) {
    Link_TxPrintf("OK product=%s fw=%s proto=%u.%u sysclk=%lu pwm_hz=%lu arr=%lu "
                  "deadtime_ns=%lu vref_mv=%u\r\n",
                  FW_PRODUCT, FW_VERSION, FW_PROTO_MAJOR, FW_PROTO_MINOR,
                  (unsigned long)BOARD_SYSCLK_HZ, (unsigned long)PWM_FREQ_HZ,
                  (unsigned long)PWM_ARR,
                  (unsigned long)(PWM_DEADTIME_DTG * 1000UL / (BOARD_SYSCLK_HZ / 1000000UL)),
                  BOARD_VREF_MV);
  } else if (Match(line, "STATS?", NULL)) {
    CmdStats();
  } else if (Match(line, "STATS.RESET", NULL)) {
    Ctrl_ResetStats();
    Reply("OK");
  } else if (Match(line, "LINK?", NULL)) {
    Link_TxPrintf("OK tx_dropped=%lu rx_dropped=%lu long=%lu host=%u\r\n",
                  (unsigned long)Link_TxDropped(), (unsigned long)Link_RxDropped(),
                  (unsigned long)Link_LongLines(), Link_HostAttached() ? 1U : 0U);
  } else if (Match(line, "PROTO?", NULL)) {
    Link_TxPrintf("OK rx_frames=%lu rx_errors=%lu tx_dropped=%lu overflows=%lu "
                  "params=%u dict_hash=%08lX\r\n",
                  (unsigned long)Proto_RxFrames(), (unsigned long)Proto_RxErrors(),
                  (unsigned long)Proto_TxDropped(), (unsigned long)RxRouter_Overflows(),
                  Param_Count(), (unsigned long)Param_DictHash());
  } else if (Match(line, "SELFTEST", NULL)) {
    CmdSelftest();
  } else if (Match(line, "STOP", NULL)) {
    /* Coupe MOE : les six sorties passent en haute impedance, l'etage de puissance
     * ne peut plus conduire. C'est aujourd'hui deja l'etat au repos — la commande
     * existe quand meme, et des maintenant : une commande d'arret doit preexister au
     * danger, pas arriver avec lui. L'interface s'appuie dessus. */
    Safety_Disarm();
    Reply("OK");
  } else if (Match(line, "SAFETY?", NULL)) {
    SafetyStatus_t sf;
    Safety_GetStatus(&sf);
    Link_TxPrintf("OK reason=%s latched=%u outputs=%u since_cmd_ms=%lu trips=%lu host=%u "
                  "armed=%u\r\n",
                  Safety_ReasonName(sf.reason), sf.latched ? 1U : 0U,
                  sf.outputs_live ? 1U : 0U, (unsigned long)sf.since_cmd_ms,
                  (unsigned long)sf.trips, Link_HostAttached() ? 1U : 0U,
                  sf.armed ? 1U : 0U);
  } else if (Match(line, "FAULTCLR", NULL)) {
    Reply(Safety_ClearFault() ? "OK" : "ERR CAUSE");
  } else if (Match(line, "ARM", NULL)) {
    /* `AGENTS.md` §4, règle 1. N'active rien : autorise seulement ce qui suit. */
    ReplyEnable(Safety_Arm());
  } else if (Match(line, "DISARM", NULL)) {
    Safety_Disarm();
    Reply("OK");
  } else if (Match(line, "PWM?", NULL)) {
    uint16_t a, b, c;
    Pwm_GetDutyPermille(&a, &b, &c);
    uint16_t pk[3];
    Safety_GetPeaks(pk);
    Link_TxPrintf("OK enabled=%u a=%u b=%u c=%u host=%u peak=%u,%u,%u\r\n",
                  Pwm_IsEnabled() ? 1U : 0U, a, b, c, Link_HostAttached() ? 1U : 0U,
                  pk[0], pk[1], pk[2]);
  } else if (Match(line, "OL?", NULL)) {
    CmdOpenloopStatus();
  } else if (Match(line, "OL", &arg)) {
    CmdOpenloop(arg);
  } else if (Match(line, "PWM.PULSE", &arg)) {
    CmdPwmPulse(arg);
  } else if (Match(line, "PWM", &arg)) {
    CmdPwm(arg);
  } else if (Match(line, "ADC.HOLD", &arg)) {
    /* Fige le groupe injecté : plus aucune conversion synchrone, donc plus aucun appel de
     * courant sur VREF+ à 20 kHz. Coupe MOE d'abord — la boucle n'est plus servie. */
    if (strcasecmp(arg, "ON") == 0)       { Pwm_Disable(); AdcSync_SetHold(true);  Reply("OK"); }
    else if (strcasecmp(arg, "OFF") == 0) { AdcSync_SetHold(false); Reply("OK"); }
    else                                  { Reply("ERR ARG"); }
  } else if (Match(line, "VREF.FREQ", &arg)) {
    CmdVrefFreq(arg);
  } else if (Match(line, "VREF.BUF", &arg)) {
    CmdVrefBuf(arg);
  } else if (Match(line, "VREF.RATIO", NULL)) {
    CmdVrefRatio();
  } else if (Match(line, "VREF.SCAN", &arg)) {
    CmdVrefScan(arg);
  } else if (Match(line, "IMOT.WIGGLE", &arg)) {
    CmdImotWiggle(arg);
  } else if (Match(line, "IMOT.DECAY", NULL)) {
    CmdImotDecay();
  } else if (Match(line, "NVM?", NULL)) {
    Nvm_Status_t n;
    Nvm_GetStatus(&n);
    Link_TxPrintf("OK valid=%u seq=%lu page=%s entries=%u loaded=%u skipped=%u saves=%lu\r\n",
                  n.valid ? 1U : 0U, (unsigned long)n.seq,
                  (n.page == 0U) ? "A" : ((n.page == 1U) ? "B" : "-"),
                  n.entries, n.loaded, n.skipped, (unsigned long)n.saves);
  } else if (Match(line, "NVM.SAVE", NULL)) {
    uint16_t saved = 0U;
    const Nvm_Result_t r = Nvm_Save(&saved);
    if (r == NVM_OK) {
      Nvm_Status_t n;
      Nvm_GetStatus(&n);
      Link_TxPrintf("OK saved=%u seq=%lu\r\n", saved, (unsigned long)n.seq);
    } else {
      Reply((r == NVM_ERR_LIVE) ? "ERR LIVE" : "ERR NVM");
    }
  } else if (Match(line, "IMOT.CAL", &arg)) {
    CmdImotCampaign(arg, true, false);    /* zéro de fonctionnement, mémorisé */
  } else if (Match(line, "IMOT.AMP", &arg)) {
    CmdImotCampaign(arg, false, true);    /* zéro de l'ampli seul, diagnostic */
  } else if (Match(line, "IMOT.NOISE", &arg)) {
    CmdImotCampaign(arg, false, false);
  } else if (Match(line, "IMOT?", NULL)) {
    CmdImotStatus();
  } else if (Match(line, "IMOT.Z", NULL)) {
    CmdImotZ();
  } else if (Match(line, "ADC.PROBE", NULL)) {
    /* Les trois entrees de courant en entree numerique, tirees vers le bas puis vers le
     * haut : une source basse impedance impose son niveau (0,85 V lit 0 dans les deux
     * cas), un noeud flottant suit le tirage. Puis retour en analogique. */
    GPIO_InitTypeDef g = {0};
    uint32_t down = 0U, up = 0U;
    g.Pin = PIN_IMOTA | PIN_IMOTB | PIN_IMOTC;
    g.Mode = GPIO_MODE_INPUT; g.Pull = GPIO_PULLDOWN; HAL_GPIO_Init(GPIOA, &g);
    HAL_Delay(2U); down = GPIOA->IDR & g.Pin;
    g.Pull = GPIO_PULLUP; HAL_GPIO_Init(GPIOA, &g);
    HAL_Delay(2U); up = GPIOA->IDR & g.Pin;
    g.Mode = GPIO_MODE_ANALOG; g.Pull = GPIO_NOPULL; HAL_GPIO_Init(GPIOA, &g);
    Link_TxPrintf("OK pulldown=%lu,%lu,%lu pullup=%lu,%lu,%lu\r\n",
                  (unsigned long)((down & PIN_IMOTA) != 0U), (unsigned long)((down & PIN_IMOTB) != 0U),
                  (unsigned long)((down & PIN_IMOTC) != 0U), (unsigned long)((up & PIN_IMOTA) != 0U),
                  (unsigned long)((up & PIN_IMOTB) != 0U), (unsigned long)((up & PIN_IMOTC) != 0U));
  } else if (Match(line, "ADC?", NULL)) {
    /* Diagnostic brut d'ADC1 : ce que le convertisseur est configure pour faire, et ce
     * qu'il a mis dans les registres injectes au dernier JEOS. */
    Link_TxPrintf("OK jsqr=%08lX sqr1=%08lX smpr1=%08lX smpr2=%08lX cfgr=%08lX cr=%08lX "
                  "isr=%08lX jdr=%lu,%lu,%lu ccr=%08lX\r\n",
                  (unsigned long)ADC1->JSQR, (unsigned long)ADC1->SQR1,
                  (unsigned long)ADC1->SMPR1, (unsigned long)ADC1->SMPR2,
                  (unsigned long)ADC1->CFGR, (unsigned long)ADC1->CR, (unsigned long)ADC1->ISR,
                  (unsigned long)ADC1->JDR1, (unsigned long)ADC1->JDR2, (unsigned long)ADC1->JDR3,
                  (unsigned long)ADC12_COMMON->CCR);
  } else if (Match(line, "ENC?", NULL)) {
    CmdEncStatus();
  } else if (Match(line, "ENC.REG", &arg)) {
    CmdEncReg(arg);
  } else if (Match(line, "ENC.BUS", &arg)) {
    CmdEncBus(arg);
  } else if (Match(line, "ENC.RST", NULL)) {
    Encoder_ResetStats();
    Reply("OK");
  } else if (Match(line, "SENS.ALL?", NULL)) {
    Sensors_t sn;
    Sensors_Get(&sn);
    /* `vref` est mesuré, pas supposé ; les rails en millivolts en dépendent. Les entrées
     * de courant sont données brutes et en mV : un zéro brut sur les trois, avec un vref
     * plausible, désigne le signal et non l'ADC. */
    Link_TxPrintf("OK rounds=%lu vref_mv=%u vrefint_raw=%u vin_mv=%u vmot_mv=%u v5_mv=%u "
                  "v3v3_mv=%u csa_raw=%u,%u,%u csa_mv=%u,%u,%u mcu_temp_c=%d\r\n",
                  (unsigned long)sn.rounds, sn.vref_mv, sn.vrefint_raw, sn.vin_mv, sn.vmot_mv,
                  sn.v5_mv, sn.v3v3_mv, sn.csa_raw[0], sn.csa_raw[1], sn.csa_raw[2],
                  sn.csa_mv[0], sn.csa_mv[1], sn.csa_mv[2], sn.mcu_temp_c);
  } else if (Match(line, "DRV?", NULL)) {
    CmdDrvStatus();
  } else if (Match(line, "DRV.BITBANG", &arg)) {
    CmdDrvBitbang(arg);
  } else if (Match(line, "DRV.LOOP", &arg)) {
    CmdDrvLoop(arg);
  } else if (Match(line, "DRV.PINS", NULL)) {
    CmdDrvPins();
  } else if (Match(line, "DRV.NCS", NULL)) {
    CmdDrvNcs();
  } else if (Match(line, "DRV.PROBE", NULL)) {
    /* Critère de l'étape 2 : une écriture se relit. Ne laisse aucune trace dans le DRV. */
    Reply(Drv8304_Probe() ? "OK" : "ERR DRV");
  } else if (Match(line, "DRV.REG", &arg)) {
    CmdDrvReg(arg);
  } else if (Match(line, "DRV.CAL", &arg)) {
    /* CAL haut : les trois CSA court-circuitent leurs entrees et sortent leur offset seul,
     * autour de VREF/2. C'est la seule source stable tant que les transistors bas ne
     * conduisent pas — sinon le shunt n'est relie qu'a une source de MOSFET ouverte. */
    /* Refusé sorties actives : `CAL` levé aveuglerait la surveillance du courant. */
    if (strcasecmp(arg, "ON") == 0) {
      if (Pwm_IsEnabled()) { Reply("ERR LIVE"); }
      else                 { Drv8304_SetCal(true); Reply("OK"); }
    }
    else if (strcasecmp(arg, "OFF") == 0) { Drv8304_SetCal(false); Reply("OK"); }
    else                                  { Reply("ERR ARG"); }
  } else if (Match(line, "DRV.CLR", NULL)) {
    Reply(Drv8304_ClearFaults() ? "OK" : "ERR SPI");
  } else {
    Reply("ERR CMD");
  }
}
