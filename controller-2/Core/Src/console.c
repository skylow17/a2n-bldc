/**
 * @file console.c
 * @brief Console ASCII de diagnostic, ligne par ligne.
 *
 * Reprise du principe le mieux réussi du v1 : une ligne de texte, une réponse, lisible
 * depuis n'importe quel terminal série sans aucun outil. Le canal binaire viendra à côté,
 * sur le même lien, discriminé par l'octet de fin.
 *
 * Tourne dans la superloop. Rien ici n'est appelé depuis l'ISR de contrôle.
 */
#include "console.h"

#include <stdlib.h>
#include <string.h>

#include "board.h"
#include "ctrl.h"
#include "link_usb.h"
#include "pwm.h"
#include "version.h"

#define CONSOLE_LINE_MAX  96U

static char     s_line[CONSOLE_LINE_MAX];
static uint16_t s_len;
static bool     s_overflow;

void Console_Init(void)
{
  s_len      = 0U;
  s_overflow = false;
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

static void Execute(const char *line)
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
  } else if (Match(line, "PWM?", NULL)) {
    Link_TxPrintf("OK enabled=%u\r\n", Pwm_IsEnabled() ? 1U : 0U);
  } else {
    Reply("ERR CMD");
  }
}

void Console_Process(void)
{
  uint8_t chunk[64];
  uint16_t n;

  while ((n = Link_RxRead(chunk, sizeof(chunk))) > 0U) {
    for (uint16_t i = 0U; i < n; i++) {
      const char c = (char)chunk[i];

      if ((c == '\r') || (c == '\n')) {
        if (s_overflow) {
          Reply("ERR OVF");
        } else if (s_len > 0U) {
          s_line[s_len] = '\0';
          Execute(s_line);
        }
        s_len      = 0U;
        s_overflow = false;
        continue;
      }
      if (s_len >= (CONSOLE_LINE_MAX - 1U)) {
        /* On continue de consommer jusqu'au retour ligne plutôt que de couper : la
         * commande suivante ne doit pas hériter d'un reste de la précédente. */
        s_overflow = true;
        continue;
      }
      s_line[s_len++] = c;
    }
  }
}
