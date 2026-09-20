/**
 * @file safety.c
 * @brief Implémentation de la barrière — voir `safety.h` pour les règles appliquées.
 */
#include "safety.h"

#include "stm32g4xx_hal.h"

#include "link_usb.h"
#include "pwm.h"

/* Délai maximal entre deux messages tant que les sorties sont actives.
 *
 * Le choix se tient entre deux bornes. Trop court, une rafale USB retardée coupe un essai
 * légitime — une trame CDC peut glisser de quelques dizaines de millisecondes quand l'hôte
 * est chargé. Trop long, la masse en rotation continue d'être entraînée pendant que
 * personne ne regarde. 250 ms laisse passer un hôte qui rafraîchit à 10 Hz avec une marge
 * de deux périodes, et borne l'emballement à un quart de tour à vitesse modeste.
 *
 * Ce n'est pas un réglage : c'est une limite. Elle deviendra un paramètre avec M3, avec un
 * plafond dur — élargir une limite pour faire passer un essai est interdit (`AGENTS.md` §4). */
#define SAFETY_CMD_TIMEOUT_MS   250U

static volatile SafetyReason_t s_reason;
static volatile bool           s_latched;
static volatile uint32_t       s_last_cmd_ms;
static volatile uint32_t       s_trips;

void Safety_Init(void)
{
  s_reason      = SAFETY_OK;
  s_latched     = false;
  s_last_cmd_ms = HAL_GetTick();
  s_trips       = 0U;
}

void Safety_NoteCommand(void)
{
  s_last_cmd_ms = HAL_GetTick();
}

void Safety_Cut(SafetyReason_t reason)
{
  Pwm_Disable();
  s_reason = reason;
  /* Un arrêt demandé n'est pas une faute : il n'a rien à acquitter. Toutes les autres
   * causes latchent, y compris si les sorties étaient déjà coupées — savoir que l'hôte a
   * disparu pendant qu'on était au repos reste une information. */
  if (reason != SAFETY_REQUESTED) {
    s_latched = true;
  }
}

void Safety_Process(void)
{
  if (!Pwm_IsEnabled()) {
    /* Au repos, le compteur ne sert à rien et ne doit pas accumuler : sinon la première
     * activation après un long silence se couperait aussitôt. */
    s_last_cmd_ms = HAL_GetTick();
    return;
  }

  /* Hôte franchement parti : port refermé, câble arraché, bus suspendu. */
  if (!Link_HostAttached()) {
    Safety_Cut(SAFETY_HOST_GONE);
    s_trips++;
    return;
  }

  /* Hôte présent mais muet. Soustraction signée : le compteur de ticks déborde au bout de
   * 49 jours, et un banc peut rester allumé plus longtemps que ça. */
  if ((int32_t)(HAL_GetTick() - s_last_cmd_ms) >= (int32_t)SAFETY_CMD_TIMEOUT_MS) {
    Safety_Cut(SAFETY_CMD_TIMEOUT);
    s_trips++;
  }
}

bool Safety_EnableOutputs(void)
{
  if (s_latched) {
    return false;
  }
  if (!Link_HostAttached()) {
    return false;
  }
  /* Le compteur repart d'ici : entre la dernière commande reçue et cette activation, il a
   * pu s'écouler plus que le délai, et couper immédiatement ce qu'on vient d'autoriser
   * serait faux. */
  s_last_cmd_ms = HAL_GetTick();
  s_reason      = SAFETY_OK;
  Pwm_Enable();
  return true;
}

bool Safety_ClearFault(void)
{
  if (!s_latched) {
    return true;
  }
  /* Acquitter ne veut pas dire ignorer : si l'hôte n'est toujours pas là, la cause tient
   * encore et l'acquittement échoue. Les autres causes sont par nature passées au moment
   * où quelqu'un arrive à envoyer cette commande. */
  if (!Link_HostAttached()) {
    return false;
  }
  s_latched     = false;
  s_reason      = SAFETY_OK;
  s_last_cmd_ms = HAL_GetTick();
  return true;
}

void Safety_GetStatus(SafetyStatus_t *out)
{
  __disable_irq();
  out->reason       = s_reason;
  out->latched      = s_latched;
  out->outputs_live = Pwm_IsEnabled();
  out->since_cmd_ms = (uint32_t)(HAL_GetTick() - s_last_cmd_ms);
  out->trips        = s_trips;
  __enable_irq();
}

const char *Safety_ReasonName(SafetyReason_t reason)
{
  switch (reason) {
    case SAFETY_HOST_GONE:   return "host_gone";
    case SAFETY_CMD_TIMEOUT: return "cmd_timeout";
    case SAFETY_DRV_FAULT:   return "drv_fault";
    case SAFETY_REQUESTED:   return "requested";
    case SAFETY_OK:
    default:                 return "ok";
  }
}
