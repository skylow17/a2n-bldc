/**
 * @file safety.c
 * @brief Implémentation de la barrière — voir `safety.h` pour les règles appliquées.
 */
#include "safety.h"

#include "stm32g4xx_hal.h"

#include "board.h"
#include "drv8304.h"
#include "imot.h"
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
static volatile bool           s_armed;         /* rien ne s'active sans lui          */
static volatile uint32_t       s_pulse_ticks;   /* passages restants, 0 = sans terme  */
static volatile uint16_t       s_peak[3];       /* depuis la dernière activation      */

void Safety_Init(void)
{
  s_reason      = SAFETY_OK;
  s_latched     = false;
  s_last_cmd_ms = HAL_GetTick();
  s_trips       = 0U;
  s_armed       = false;   /* un reset ramène toujours à l'état désarmé */
}

void Safety_NoteCommand(void)
{
  s_last_cmd_ms = HAL_GetTick();
}

void Safety_Cut(SafetyReason_t reason)
{
  Pwm_Disable();
  s_pulse_ticks = 0U;     /* une impulsion coupée ne doit pas écourter la suivante */
  /* Tant qu'une faute est latchée, sa cause reste celle qu'on lit. Un `STOP` envoyé ensuite
   * l'écrasait par `requested` : la carte restait bloquée sans plus dire pourquoi — vu sur
   * carte le 2026-09-26, après une coupure par le watchdog. */
  if (!s_latched) {
    s_reason = reason;
  }
  /* Un arrêt demandé n'est pas une faute : il n'a rien à acquitter. Toutes les autres
   * causes latchent, y compris si les sorties étaient déjà coupées — savoir que l'hôte a
   * disparu pendant qu'on était au repos reste une information. */
  if (reason != SAFETY_REQUESTED) {
    s_latched = true;
    s_armed   = false;     /* une faute désarme ; la reprise est une décision, `ARM` */
  }
}

SafetyEnable_t Safety_Arm(void)
{
  if (s_latched) {
    return SAFETY_EN_LATCHED;
  }
  if (!Link_HostAttached()) {
    return SAFETY_EN_LINK;
  }
  s_armed = true;
  return SAFETY_EN_OK;
}

void Safety_Disarm(void)
{
  Safety_Cut(SAFETY_REQUESTED);
  s_armed = false;
}

bool Safety_IsArmed(void)
{
  return s_armed;
}

uint32_t Safety_PulseLeftMs(void)
{
  return s_pulse_ticks / (PWM_FREQ_HZ / 1000UL);
}

void Safety_Process(void)
{
  /* La perte de liaison désarme toujours, sorties actives ou non : un hôte qui revient ne
   * doit pas retrouver une carte armée par quelqu'un d'autre, ou par lui-même avant sa chute. */
  if (!Link_HostAttached()) {
    s_armed = false;
  }

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

SafetyEnable_t Safety_EnableOutputs(uint32_t pulse_ms)
{
  if (!s_armed) {
    return SAFETY_EN_DISARMED;
  }
  if (s_latched) {
    return SAFETY_EN_LATCHED;
  }
  if (!Link_HostAttached()) {
    return SAFETY_EN_LINK;
  }
  /* La surveillance du courant compare à l'offset mesuré : sans lui elle ne vaut rien. */
  uint16_t off[3];
  bool measured = false;
  Imot_GetOffsets(off, &measured);
  if (!measured) {
    return SAFETY_EN_NOZERO;
  }
  /* `CAL` levé court-circuite les entrées des amplis : les courants lus valent zéro quoi
   * qu'il passe dans les shunts, et la limite ne verrait rien. */
  if (Imot_Busy() || Drv8304_CalActive()) {
    return SAFETY_EN_CAL;
  }
  /* La limite est en counts ; elle ne vaut des ampères que pour 20 V/V, `VREF_DIV` à 1 et
   * `SPI_CAL` à 0. Relu à chaque fois : un `DRV.REG` a pu passer entre-temps. */
  if (!Drv8304_CsaConfigOk()) {
    return SAFETY_EN_CSA;
  }

  /* Le compteur repart d'ici : entre la dernière commande reçue et cette activation, il a
   * pu s'écouler plus que le délai, et couper immédiatement ce qu'on vient d'autoriser
   * serait faux. */
  s_last_cmd_ms = HAL_GetTick();
  s_reason      = SAFETY_OK;
  s_peak[0] = 0U;
  s_peak[1] = 0U;
  s_peak[2] = 0U;
  /* Le terme est posé **avant** `MOE`, et l'ISR ne décompte que sorties actives : un
   * passage qui tomberait entre les deux ne peut ni couper trop tôt ni laisser filer. */
  s_pulse_ticks = pulse_ms * (PWM_FREQ_HZ / 1000UL);
  __DMB();
  Pwm_Enable();
  return SAFETY_EN_OK;
}

static uint16_t Abs16(int16_t v)
{
  return (uint16_t)((v < 0) ? -(int32_t)v : (int32_t)v);
}

void Safety_OnControlTick(int16_t ia, int16_t ib, int16_t ic)
{
  if (!Pwm_IsEnabled()) {
    return;                         /* le cas courant : une comparaison, rien d'autre */
  }
  const uint16_t a[3] = { Abs16(ia), Abs16(ib), Abs16(ic) };
  bool over = false;
  for (uint32_t i = 0U; i < 3U; i++) {
    if (a[i] > s_peak[i]) {
      s_peak[i] = a[i];
    }
    if (a[i] > (uint16_t)SAFETY_OC_LIMIT_COUNTS) {
      over = true;
    }
  }
  if (over) {
    Safety_Cut(SAFETY_OVERCURRENT);
    s_trips++;
    return;
  }
  if (s_pulse_ticks != 0U) {
    s_pulse_ticks--;
    if (s_pulse_ticks == 0U) {
      Safety_Cut(SAFETY_REQUESTED);  /* fin d'impulsion : un arrêt voulu, pas une faute */
    }
  }
}

void Safety_GetPeaks(uint16_t out[3])
{
  out[0] = s_peak[0];
  out[1] = s_peak[1];
  out[2] = s_peak[2];
}

bool Safety_ClearFault(void)
{
  if (!s_latched) {
    return true;
  }
  /* Acquitter ne veut pas dire ignorer : si la cause tient encore, l'acquittement échoue.
   * L'hôte absent en est une ; `nFAULT` encore basse en est une autre — jusqu'au
   * 2026-09-26 elle passait, `FAULTCLR` répondait `OK` pendant que le DRV signalait
   * toujours sa faute. Une surintensité, elle, est passée : les sorties sont coupées. */
  if (!Link_HostAttached()) {
    return false;
  }
  if (s_reason == SAFETY_DRV_FAULT) {
    Drv8304_Status_t st;
    Drv8304_GetStatus(&st);
    if (st.nfault_low) {
      return false;
    }
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
  out->armed        = s_armed;
  __enable_irq();
}

const char *Safety_ReasonName(SafetyReason_t reason)
{
  switch (reason) {
    case SAFETY_HOST_GONE:   return "host_gone";
    case SAFETY_CMD_TIMEOUT: return "cmd_timeout";
    case SAFETY_DRV_FAULT:   return "drv_fault";
    case SAFETY_REQUESTED:   return "requested";
    case SAFETY_OVERCURRENT: return "overcurrent";
    case SAFETY_ANGLE_LOST:  return "angle_lost";
    case SAFETY_OK:
    default:                 return "ok";
  }
}
