/**
 * @file wdg.c
 * @brief Chien de garde matériel de l'application — voir `wdg.h`.
 */
#include "wdg.h"

#include "board.h"

static Wdg_Cause_t s_cause = WDG_CAUSE_OTHER;
static bool        s_running;

void Wdg_CaptureCause(void)
{
  const uint32_t csr = RCC->CSR;
  /* L'ordre compte : un reset par l'IWDG pose aussi `PINRSTF`, la broche NRST étant tirée par
   * le reset interne. La cause la plus spécifique d'abord. */
  if ((csr & RCC_CSR_IWDGRSTF) != 0U) {
    s_cause = WDG_CAUSE_IWDG;
  } else if ((csr & RCC_CSR_WWDGRSTF) != 0U) {
    s_cause = WDG_CAUSE_WWDG;
  } else if ((csr & RCC_CSR_LPWRRSTF) != 0U) {
    s_cause = WDG_CAUSE_LOWPOWER;
  } else if ((csr & RCC_CSR_OBLRSTF) != 0U) {
    s_cause = WDG_CAUSE_OPTION;
  } else if ((csr & RCC_CSR_SFTRSTF) != 0U) {
    s_cause = WDG_CAUSE_SOFTWARE;
  } else if ((csr & RCC_CSR_BORRSTF) != 0U) {
    s_cause = WDG_CAUSE_POWER;
  } else if ((csr & RCC_CSR_PINRSTF) != 0U) {
    s_cause = WDG_CAUSE_PIN;
  } else {
    /* Aucun drapeau. Derrière le bootloader, c'est le cas ordinaire : `HAL_RCC_DeInit` efface
     * tout avant le saut. Le dire, plutôt que « autre », qui laisserait croire à une cause
     * inconnue. */
    s_cause = WDG_CAUSE_CLEARED;
  }
  RCC->CSR |= RCC_CSR_RMVF;   /* sinon les drapeaux s'accumulent d'un reset à l'autre */
}

Wdg_Cause_t Wdg_Cause(void)
{
  return s_cause;
}

const char *Wdg_CauseName(Wdg_Cause_t c)
{
  switch (c) {
    case WDG_CAUSE_POWER:    return "power";
    case WDG_CAUSE_PIN:      return "pin";
    case WDG_CAUSE_SOFTWARE: return "software";
    case WDG_CAUSE_IWDG:     return "iwdg";
    case WDG_CAUSE_WWDG:     return "wwdg";
    case WDG_CAUSE_LOWPOWER: return "lowpower";
    case WDG_CAUSE_OPTION:   return "option";
    case WDG_CAUSE_CLEARED:  return "cleared";
    case WDG_CAUSE_OTHER:
    default:                 return "other";
  }
}

void Wdg_Start(bool in_trial)
{
  if (in_trial || s_running) {
    return;
  }
  /* Le chien s'arrête avec le cœur quand un débogueur le suspend : sans cela, chaque point
   * d'arrêt se solderait par un reset. Sans effet hors débogage. */
  DBGMCU->APB1FZR1 |= DBGMCU_APB1FZR1_DBG_IWDG_STOP;

  /* Écritures directes, comme dans le bootloader : le module HAL n'est pas lié. LSI ≈ 32 kHz,
   * prédiviseur /32 → un tick ≈ 1 ms. */
  IWDG->KR  = 0x0000CCCCU;          /* démarrage                    */
  IWDG->KR  = 0x00005555U;          /* déverrouillage des registres */
  IWDG->PR  = 3U;                   /* /32                          */
  IWDG->RLR = WDG_TIMEOUT_MS;
  while (IWDG->SR != 0U) {
    /* Attendre la prise en compte : recharger avant que PR et RLR soient appliqués
     * laisserait le chien sur ses valeurs par défaut. */
  }
  IWDG->KR  = 0x0000AAAAU;
  s_running = true;
}

void Wdg_Kick(void)
{
  if (s_running) {
    IWDG->KR = 0x0000AAAAU;
  }
}

bool Wdg_Running(void)
{
  return s_running;
}
