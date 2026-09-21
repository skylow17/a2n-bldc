/**
 * @file imot.c
 * @brief Offsets et bruit de la chaîne de mesure de courant. Voir `imot.h` pour le pourquoi.
 *
 * Deux décisions méritent d'être expliquées.
 *
 * **L'accumulation vit dans l'ISR, la statistique dans la superloop.** L'ISR n'additionne
 * que des entiers — somme, somme des carrés, minimum, maximum — et hors campagne elle ne
 * fait qu'une comparaison. La racine carrée, la division et le flottant attendent que la
 * campagne soit finie : rien de tout ça n'a sa place dans un budget de 50 µs.
 *
 * **Le zéro n'est jamais supposé.** Tant qu'aucune campagne n'a tourné, l'offset vaut la
 * mi-échelle théorique et `measured` est faux. C'est une valeur de repli explicite, pas une
 * mesure : afficher un courant centré sur un zéro supposé serait exactement le genre de
 * chiffre qui a l'air juste et ne l'est pas.
 */
#include "imot.h"

#include "board.h"
#include "drv8304.h"
#include "stm32g4xx_hal.h"

#include <math.h>
#include <string.h>

/* Mi-échelle théorique : les sorties `SOx` reposent à `VREF/2`, et la pleine échelle de
 * l'ADC vaut `VREF`. Depuis que les deux sont la même tension, le zéro tombe donc au milieu
 * de l'échelle — 2048 — sans que la valeur de `VREF` intervienne. C'est la propriété
 * ratiométrique gagnée par la retouche du 2026-09-21. */
#define IMOT_MIDSCALE  2048U

static volatile uint32_t s_left;              /* échantillons restants, 0 = au repos */
static volatile uint32_t s_sum[3];
static volatile uint64_t s_sumsq[3];
static volatile uint16_t s_min[3];
static volatile uint16_t s_max[3];
static volatile uint32_t s_total;
static volatile bool     s_store;
static volatile bool     s_cal_pin;

static Imot_Campaign_t s_last;
static uint16_t        s_offset[3] = { IMOT_MIDSCALE, IMOT_MIDSCALE, IMOT_MIDSCALE };
static bool            s_measured;

void Imot_Init(void)
{
  s_left = 0U;
  s_measured = false;
  memset(&s_last, 0, sizeof(s_last));
  for (uint32_t i = 0U; i < 3U; i++) {
    s_offset[i] = IMOT_MIDSCALE;
  }
}

bool Imot_StartCampaign(uint32_t samples, bool store, bool use_cal_pin)
{
  if ((samples == 0UL) || (samples > IMOT_CAL_MAX_SAMPLES) || (s_left != 0U)) {
    return false;
  }
  s_cal_pin = use_cal_pin;
  if (use_cal_pin) {
    /* Le temps d'établissement de l'amplificateur après un changement d'entrée est de
     * 1,55 µs au pire gain (fiche technique DRV8304, `tSET`). Une milliseconde est trois
     * ordres de grandeur au-dessus, et on est dans la superloop : ça ne coûte rien. */
    Drv8304_SetCal(true);
    HAL_Delay(1U);
  }
  for (uint32_t i = 0U; i < 3U; i++) {
    s_sum[i]   = 0U;
    s_sumsq[i] = 0U;
    s_min[i]   = 0xFFFFU;
    s_max[i]   = 0U;
  }
  s_total = samples;
  s_store = store;
  __DMB();
  s_left = samples;      /* en dernier : c'est lui qui arme l'ISR */
  return true;
}

bool Imot_Busy(void) { return s_left != 0U; }

void Imot_OnSample(uint16_t a, uint16_t b, uint16_t c)
{
  if (s_left == 0U) {
    return;                       /* le cas courant : une comparaison, rien d'autre */
  }
  const uint16_t v[3] = { a, b, c };
  for (uint32_t i = 0U; i < 3U; i++) {
    s_sum[i]   += v[i];
    s_sumsq[i] += (uint64_t)v[i] * (uint64_t)v[i];
    if (v[i] < s_min[i]) { s_min[i] = v[i]; }
    if (v[i] > s_max[i]) { s_max[i] = v[i]; }
  }
  s_left--;
}

/** Clôture une campagne terminée. Appelée depuis la superloop, via `Imot_GetCampaign`. */
static void Finish(void)
{
  const uint32_t n = s_total;
  if (n == 0U) {
    return;                       /* rien en attente : `s_total` est remis à zéro ici */
  }
  if (s_cal_pin) {
    Drv8304_SetCal(false);
  }
  for (uint32_t i = 0U; i < 3U; i++) {
    const double mean = (double)s_sum[i] / (double)n;
    /* Variance par la forme brute E[x²] − E[x]². Le biais numérique qu'on lui reproche
     * d'ordinaire suppose une moyenne grande devant l'écart-type ; ici la moyenne vaut
     * ~2048 et l'écart-type quelques counts, et les sommes sont exactes en entier, donc
     * la soustraction reste largement dans la précision du double. */
    double var = ((double)s_sumsq[i] / (double)n) - (mean * mean);
    if (var < 0.0) { var = 0.0; }
    s_last.mean[i]       = (uint16_t)(mean + 0.5);
    s_last.min[i]        = s_min[i];
    s_last.max[i]        = s_max[i];
    s_last.sigma_mcnt[i] = (uint16_t)((sqrt(var) * 1000.0) + 0.5);
  }
  s_last.samples      = n;
  s_last.used_cal_pin = s_cal_pin;
  s_total = 0U;

  if (s_store) {
    for (uint32_t i = 0U; i < 3U; i++) {
      s_offset[i] = s_last.mean[i];
    }
    s_measured = true;
  }
}

void Imot_GetCampaign(Imot_Campaign_t *out)
{
  if (s_left == 0U) {
    Finish();
  }
  *out = s_last;
}

void Imot_GetOffsets(uint16_t out[3], bool *measured)
{
  for (uint32_t i = 0U; i < 3U; i++) {
    out[i] = s_offset[i];
  }
  if (measured != NULL) {
    *measured = s_measured;
  }
}

void Imot_Apply(uint16_t a, uint16_t b, uint16_t c, int16_t *ia, int16_t *ib, int16_t *ic)
{
  *ia = (int16_t)((int32_t)a - (int32_t)s_offset[0]);
  *ib = (int16_t)((int32_t)b - (int32_t)s_offset[1]);
  *ic = (int16_t)((int32_t)c - (int32_t)s_offset[2]);
}
