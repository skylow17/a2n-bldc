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
    /* Seule voie d'activation : la barrière connaît l'hôte et la faute latchée, et
     * repart d'un délai de watchdog neuf. */
    if (!Safety_EnableOutputs()) {
      SafetyStatus_t sf;
      Safety_GetStatus(&sf);
      Link_TxPrintf("ERR %s\r\n", sf.latched ? "LATCHED" : "LINK");
      return;
    }
    Reply("OK");
    return;
  }
  if (strcasecmp(arg, "OFF") == 0) {
    Safety_Cut(SAFETY_REQUESTED);
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
  Pwm_SetDutyPermille((uint16_t)d[0], (uint16_t)d[1], (uint16_t)d[2]);
  Reply("OK");
}

/* `DRV.REG <addr>` lit, `DRV.REG <addr> <value>` écrit puis relit. Hexadécimal libre. */
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
static void CmdVrefBuf(const char *arg)
{
  if (strcasecmp(arg, "ON") == 0) {
    __HAL_RCC_SYSCFG_CLK_ENABLE();
    MODIFY_REG(VREFBUF->CSR, VREFBUF_CSR_VRS | VREFBUF_CSR_HIZ, 0U);   /* 2,048 V, pilote */
    SET_BIT(VREFBUF->CSR, VREFBUF_CSR_ENVR);
    uint32_t guard = 0U;
    while (((VREFBUF->CSR & VREFBUF_CSR_VRR) == 0U) && (guard < 100000U)) { guard++; }
    Link_TxPrintf("OK csr=%08lX ready=%u\r\n", (unsigned long)VREFBUF->CSR,
                  ((VREFBUF->CSR & VREFBUF_CSR_VRR) != 0U) ? 1U : 0U);
  } else if (strcasecmp(arg, "OFF") == 0) {
    VREFBUF->CSR = VREFBUF_CSR_HIZ;     /* tampon coupé, broche rendue à l'extérieur */
    Link_TxPrintf("OK csr=%08lX ready=0\r\n", (unsigned long)VREFBUF->CSR);
  } else {
    Reply("ERR ARG");
  }
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
    Link_TxPrintf("OK tx_dropped=%lu rx_dropped=%lu host=%u\r\n",
                  (unsigned long)Link_TxDropped(), (unsigned long)Link_RxDropped(),
                  Link_HostAttached() ? 1U : 0U);
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
    Safety_Cut(SAFETY_REQUESTED);
    Reply("OK");
  } else if (Match(line, "SAFETY?", NULL)) {
    SafetyStatus_t sf;
    Safety_GetStatus(&sf);
    Link_TxPrintf("OK reason=%s latched=%u outputs=%u since_cmd_ms=%lu trips=%lu host=%u\r\n",
                  Safety_ReasonName(sf.reason), sf.latched ? 1U : 0U,
                  sf.outputs_live ? 1U : 0U, (unsigned long)sf.since_cmd_ms,
                  (unsigned long)sf.trips, Link_HostAttached() ? 1U : 0U);
  } else if (Match(line, "FAULTCLR", NULL)) {
    Reply(Safety_ClearFault() ? "OK" : "ERR CAUSE");
  } else if (Match(line, "PWM?", NULL)) {
    uint16_t a, b, c;
    Pwm_GetDutyPermille(&a, &b, &c);
    Link_TxPrintf("OK enabled=%u a=%u b=%u c=%u host=%u\r\n", Pwm_IsEnabled() ? 1U : 0U,
                  a, b, c, Link_HostAttached() ? 1U : 0U);
  } else if (Match(line, "PWM", &arg)) {
    CmdPwm(arg);
  } else if (Match(line, "ADC.HOLD", &arg)) {
    /* Fige le groupe injecté : plus aucune conversion synchrone, donc plus aucun appel de
     * courant sur VREF+ à 20 kHz. Coupe MOE d'abord — la boucle n'est plus servie. */
    if (strcasecmp(arg, "ON") == 0)       { Pwm_Disable(); AdcSync_SetHold(true);  Reply("OK"); }
    else if (strcasecmp(arg, "OFF") == 0) { AdcSync_SetHold(false); Reply("OK"); }
    else                                  { Reply("ERR ARG"); }
  } else if (Match(line, "VREF.BUF", &arg)) {
    CmdVrefBuf(arg);
  } else if (Match(line, "VREF.RATIO", NULL)) {
    CmdVrefRatio();
  } else if (Match(line, "VREF.SCAN", &arg)) {
    CmdVrefScan(arg);
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
  } else if (Match(line, "SENS.ALL?", NULL)) {
    Sensors_t sn;
    Sensors_Get(&sn);
    /* `vref` est mesuré, pas supposé ; les rails en millivolts en dépendent. Les entrées
     * de courant sont données brutes et en mV : un zéro brut sur les trois, avec un vref
     * plausible, désigne le signal et non l'ADC. */
    Link_TxPrintf("OK rounds=%lu vref_mv=%u vrefint_raw=%u vin_mv=%u vmot_mv=%u v5_mv=%u "
                  "v3v3_mv=%u csa_raw=%u,%u,%u csa_mv=%u,%u,%u\r\n",
                  (unsigned long)sn.rounds, sn.vref_mv, sn.vrefint_raw, sn.vin_mv, sn.vmot_mv,
                  sn.v5_mv, sn.v3v3_mv, sn.csa_raw[0], sn.csa_raw[1], sn.csa_raw[2],
                  sn.csa_mv[0], sn.csa_mv[1], sn.csa_mv[2]);
  } else if (Match(line, "DRV?", NULL)) {
    CmdDrvStatus();
  } else if (Match(line, "DRV.PROBE", NULL)) {
    /* Critère de l'étape 2 : une écriture se relit. Ne laisse aucune trace dans le DRV. */
    Reply(Drv8304_Probe() ? "OK" : "ERR DRV");
  } else if (Match(line, "DRV.REG", &arg)) {
    CmdDrvReg(arg);
  } else if (Match(line, "DRV.CAL", &arg)) {
    /* CAL haut : les trois CSA court-circuitent leurs entrees et sortent leur offset seul,
     * autour de VREF/2. C'est la seule source stable tant que les transistors bas ne
     * conduisent pas — sinon le shunt n'est relie qu'a une source de MOSFET ouverte. */
    if (strcasecmp(arg, "ON") == 0)       { Drv8304_SetCal(true);  Reply("OK"); }
    else if (strcasecmp(arg, "OFF") == 0) { Drv8304_SetCal(false); Reply("OK"); }
    else                                  { Reply("ERR ARG"); }
  } else if (Match(line, "DRV.CLR", NULL)) {
    Reply(Drv8304_ClearFaults() ? "OK" : "ERR SPI");
  } else {
    Reply("ERR CMD");
  }
}
