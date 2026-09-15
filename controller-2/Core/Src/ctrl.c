/**
 * @file ctrl.c
 * @brief Boucle de contrôle temps réel à 20 kHz.
 *
 * Étape M0 : la boucle ne régule rien. Elle lit les trois courants, mesure sa propre
 * durée et bascule la broche d'instrumentation. L'objectif est de prouver, à
 * l'oscilloscope, que le squelette temps réel est correct avant d'écrire la moindre
 * ligne de régulateur — la marche que le v1 avait sautée.
 */
#include "ctrl.h"
#include "adc_sync.h"
#include "dbg_pin.h"
#include "pwm.h"

/* Compteur de cycles du cœur : 1 cycle = 1 / 144 MHz ≈ 6.94 ns. C'est la seule mesure
 * de durée disponible qui ne coûte rien à l'intérieur de l'ISR. */
static void Dwt_Init(void)
{
  CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
  DWT->CYCCNT       = 0U;
  DWT->CTRL        |= DWT_CTRL_CYCCNTENA_Msk;
}

static volatile Ctrl_Stats_t s_stats;

void Ctrl_Init(void)
{
  Dwt_Init();
  s_stats.ticks       = 0U;
  s_stats.cycles_last = 0U;
  s_stats.cycles_max  = 0U;
}

void Ctrl_Isr(void)
{
  const uint32_t t0 = DWT->CYCCNT;

  DbgPin_High();

  uint16_t ia, ib, ic;
  AdcSync_Read(&ia, &ib, &ic);

  /* --- M1 à M3 viendront se greffer ici : Clarke/Park, régulateurs, SVPWM. --- */

  s_stats.raw_ia = ia;
  s_stats.raw_ib = ib;
  s_stats.raw_ic = ic;
  s_stats.ticks++;

  DbgPin_Low();

  const uint32_t dt = DWT->CYCCNT - t0;
  s_stats.cycles_last = dt;
  if (dt > s_stats.cycles_max) {
    s_stats.cycles_max = dt;
  }
}

void Ctrl_GetStats(Ctrl_Stats_t *out)
{
  /* Lecture depuis la boucle principale pendant que l'ISR écrit. Masquer l'interruption
   * le temps de la copie coûte moins de 20 cycles et garantit un instantané cohérent. */
  __disable_irq();
  *out = *(const Ctrl_Stats_t *)&s_stats;
  __enable_irq();
}

void Ctrl_ResetStats(void)
{
  __disable_irq();
  s_stats.cycles_max = 0U;
  __enable_irq();
}
