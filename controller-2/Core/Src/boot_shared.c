/**
 * @file boot_shared.c
 * @brief Côté application de la poignée de main SRAM. Voir boot_shared.h.
 */
#include "boot_shared.h"

#ifndef BOOT_SHARED_HOSTTEST
#include "board.h"
#include "ctrl.h"
#include "pwm.h"
#endif

/* ---------------------------------------------------------------- decision
 *
 * Seule partie testable hors cible, et la seule qui décide quoi que ce soit. Elle est
 * délibérément au-dessus du reste du fichier : le code matériel plus bas ne fait que lui
 * fournir des mesures et exécuter son verdict.
 */

bool BootShared_ShouldConfirm(uint32_t elapsed_ms, uint32_t ticks_advanced, bool pwm_enabled)
{
  /* Le pont doit être au repos. Un candidat qui a déjà mis de la puissance sur le moteur n'a
   * pas atteint « une initialisation sûre » : il en est sorti. Refuser ici laisse l'IWDG
   * faire le rollback, ce qui est le comportement voulu. */
  if (pwm_enabled) {
    return false;
  }
  /* La boucle temps réel doit avoir réellement tourné. Compter les ticks plutôt que le temps
   * distingue une ISR vivante d'une ISR jamais appelée — le défaut central du firmware v1,
   * où la boucle de contrôle n'était simplement pas invoquée. */
  if (ticks_advanced < BOOT_TRIAL_CONFIRM_TICKS) {
    return false;
  }
  /* Et la superloop doit avoir vécu : l'appel vient d'elle, mais on exige en plus une durée
   * plancher pour ne pas confirmer sur un unique passage chanceux. */
  return elapsed_ms >= BOOT_TRIAL_CONFIRM_MS;
}

/* ---------------------------------------------------------------- zone partagee */

#ifndef BOOT_SHARED_HOSTTEST

typedef struct
{
  uint32_t magic;
  uint32_t magic_inv;
} BootShared_t;

/* `volatile` : le contenu est écrit par l'autre image et survit au reset. Le compilateur
 * n'a aucune raison de le deviner, et il ne doit ni supposer ni réordonner. */
static volatile BootShared_t *const s_shared = (volatile BootShared_t *)BOOT_SHARED_BASE;

static uint32_t Read(void)
{
  const uint32_t magic = s_shared->magic;
  /* Le complément est le seul garde-fou contre de la SRAM résiduelle après coupure : sans
   * lui, un motif quelconque pourrait se faire passer pour une demande. */
  return (s_shared->magic_inv == ~magic) ? magic : 0U;
}

static void Write(uint32_t magic)
{
  s_shared->magic     = magic;
  s_shared->magic_inv = ~magic;
  __DSB();
}

static void Clear(void)
{
  s_shared->magic     = 0U;
  s_shared->magic_inv = 0U;
  __DSB();
}

/* ---------------------------------------------------------------- etat */

static bool     s_trial;
static bool     s_confirmed;
static uint32_t s_start_ms;
static uint32_t s_start_ticks;

void BootShared_Init(void)
{
  const uint32_t magic = Read();

  /* Consommer avant toute autre chose. Si la suite du démarrage échoue et que la carte
   * redémarre, le message ne doit pas se rejouer indéfiniment. */
  Clear();

  s_trial     = (magic == BOOT_SHARED_TRIAL);
  s_confirmed = false;
  s_start_ms  = HAL_GetTick();

  Ctrl_Stats_t stats;
  Ctrl_GetStats(&stats);
  s_start_ticks = stats.ticks;
}

bool BootShared_IsTrial(void)
{
  return s_trial;
}

void BootShared_Process(void)
{
  if (!s_trial || s_confirmed) {
    return;
  }

  Ctrl_Stats_t stats;
  Ctrl_GetStats(&stats);

  /* Soustractions non signées : elles restent justes au débordement du compteur de ticks
   * comme à celui de HAL_GetTick(). */
  const uint32_t elapsed_ms = HAL_GetTick() - s_start_ms;
  const uint32_t advanced   = stats.ticks - s_start_ticks;

  if (!BootShared_ShouldConfirm(elapsed_ms, advanced, Pwm_IsEnabled())) {
    return;
  }

  /* Le pont d'abord, la confirmation ensuite : le reset qui suit ne doit pas laisser une
   * sortie active pendant la reprise du bootloader. */
  Pwm_Disable();
  s_confirmed = true;
  Write(BOOT_SHARED_CONFIRM);
  NVIC_SystemReset();
}

void BootShared_RequestEnter(void)
{
  Pwm_Disable();
  Write(BOOT_SHARED_ENTER);
  NVIC_SystemReset();
}

#endif /* BOOT_SHARED_HOSTTEST */
