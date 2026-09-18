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
    if (!Link_HostAttached()) {
      Reply("ERR LINK");
      return;
    }
    Pwm_Enable();
    Reply("OK");
    return;
  }
  if (strcasecmp(arg, "OFF") == 0) {
    Pwm_Disable();
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
                  (unsigned long)(PWM_DEADTIME_DTG * 1000000000UL / BOARD_SYSCLK_HZ),
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
    Pwm_Disable();
    Reply("OK");
  } else if (Match(line, "PWM?", NULL)) {
    uint16_t a, b, c;
    Pwm_GetDutyPermille(&a, &b, &c);
    Link_TxPrintf("OK enabled=%u a=%u b=%u c=%u host=%u\r\n", Pwm_IsEnabled() ? 1U : 0U,
                  a, b, c, Link_HostAttached() ? 1U : 0U);
  } else if (Match(line, "PWM", &arg)) {
    CmdPwm(arg);
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
