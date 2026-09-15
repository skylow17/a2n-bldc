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
    Link_TxPrintf("OK tx_dropped=%lu rx_dropped=%lu\r\n",
                  (unsigned long)Link_TxDropped(), (unsigned long)Link_RxDropped());
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
    Link_TxPrintf("OK enabled=%u\r\n", Pwm_IsEnabled() ? 1U : 0U);
  } else {
    Reply("ERR CMD");
  }
}
