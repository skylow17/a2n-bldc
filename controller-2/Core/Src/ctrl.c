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
#include "encoder.h"
#include "pwm.h"
#include "comm/scope.h"

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

  /* L'angle ne se lit pas ici : il est déjà là. La chaîne I2C tourne toute seule en DMA
   * et publie ; l'ISR ne fait qu'extrapoler depuis le dernier échantillon publié et son
   * horodatage. C'est la différence exacte avec le v1, où cette ligne était une lecture
   * I2C bloquante qui plafonnait tout le firmware à 1,5 kHz. */
  float pos_rad = 0.0f, vel_rad_s = 0.0f;
  uint16_t enc_age_us = 0U;
  const bool enc_ok = Encoder_Sample(&pos_rad, &vel_rad_s, &enc_age_us);

  /* --- M1 à M3 viendront se greffer ici : Clarke/Park, régulateurs, SVPWM. --- */

  /* Publie aussi vers la superloop : c'est `Ctrl_Stats_t` qui sert d'instantane au
   * streaming de telemetrie. Sans ces quatre champs, `enc.pos_rad` partait a zero sur le
   * flux souscrit alors que la console donnait la bonne valeur — le genre d'ecart qui se
   * remarque une fois la courbe tracee, c'est-a-dire trop tard. */
  s_stats.pos_rad    = pos_rad;
  s_stats.vel_rad_s  = vel_rad_s;
  s_stats.enc_age_us = enc_age_us;
  s_stats.enc_valid  = enc_ok ? 1U : 0U;

  s_stats.raw_ia = ia;
  s_stats.raw_ib = ib;
  s_stats.raw_ic = ic;
  s_stats.ticks++;

  /* Le scope est le seul consommateur autorisé dans l'ISR. Il ne transmet rien ici :
   * il copie au plus quatre f32 dans son buffer RAM, puis la superloop dumpe la capture. */
  const Signal_Snapshot_t snapshot = {
    .ticks = s_stats.ticks,
    .cycles_last = s_stats.cycles_last,
    .cycles_max = s_stats.cycles_max,
    .raw_ia = ia,
    .raw_ib = ib,
    .raw_ic = ic,
    .pos_rad = pos_rad,
    .vel_rad_s = vel_rad_s,
    .enc_age_us = enc_age_us,
    .enc_valid = enc_ok ? 1U : 0U,
  };
  Scope_OnControlTick(&snapshot);

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
