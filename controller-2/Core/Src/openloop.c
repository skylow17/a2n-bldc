/**
 * @file openloop.c
 * @brief Boucle ouverte — voir `openloop.h`.
 */
#include "openloop.h"

#include <math.h>

#include "board.h"
#include "pwm.h"

/* √3 ≈ 17321/10000, en entiers : une assertion statique veut une expression constante. */
_Static_assert((OL_MAX_AMP_PM * 17321UL) < (PWM_TEST_MAX_SPREAD_PM * 10000UL),
               "l'amplitude maximale depasserait l'ecart autorise entre bras");
_Static_assert(500U + OL_MAX_AMP_PM <= PWM_TEST_MAX_PM,
               "l'amplitude maximale depasserait le plafond de rapport cyclique");

#define TWO_PI  6.28318531f

static volatile bool s_active;
static float         s_amp;        /* fraction de la période, 0,057 au plus */
static float         s_hz_target;
static float         s_hz;
static float         s_theta;

/* Rapports cycliques bruts d'un angle, même convention que les étapes 8 et 9 :
 * d_k = 1/2 + a·cos(θ − k·2π/3), k = 0, 1, 2 pour A, B, C.
 *
 * Un cosinus et un sinus, pas trois cosinus : cos(θ ∓ 2π/3) = −½·cos θ ± (√3/2)·sin θ. Avec
 * trois `cosf`, l'ISR passait de 3,6 à 6,4 µs, 15 µs au pire — mesuré sur carte. */
static void Apply(float theta)
{
  const float arr1 = (float)(PWM_ARR + 1UL);
  const float c = cosf(theta);
  const float s = sinf(theta);
  const float h = 0.86602540f * s;          /* (√3/2)·sin θ */
  const float da = 0.5f + (s_amp * c);
  const float db = 0.5f + (s_amp * ((-0.5f * c) + h));
  const float dc = 0.5f + (s_amp * ((-0.5f * c) - h));
  Pwm_SetDutyRaw((uint16_t)(da * arr1), (uint16_t)(db * arr1), (uint16_t)(dc * arr1));
}

Openloop_Result_t Openloop_Start(uint16_t amp_pm, float elec_hz, uint32_t ms,
                                 SafetyEnable_t *enable)
{
  if ((ms == 0UL) || isnan(elec_hz)) {
    return OL_ERR_ARG;
  }
  if ((amp_pm > OL_MAX_AMP_PM) || (fabsf(elec_hz) > OL_MAX_ELEC_HZ) || (ms > OL_MAX_MS)) {
    return OL_ERR_LIMIT;
  }
  if (Pwm_IsEnabled()) {
    return OL_ERR_BUSY;
  }

  s_amp       = (float)amp_pm / 1000.0f;
  s_hz_target = elec_hz;
  s_hz        = 0.0f;
  s_theta     = 0.0f;
  /* Les CCR sont préchargés : l'angle de départ est posé avant `MOE`, et l'ISR prend le
   * relais au passage suivant. */
  Apply(0.0f);

  const SafetyEnable_t r = Safety_EnableOutputs(ms);
  if (r != SAFETY_EN_OK) {
    if (enable != NULL) {
      *enable = r;
    }
    return OL_ERR_ENABLE;
  }
  s_active = true;
  return OL_OK;
}

void Openloop_Stop(void)
{
  s_active = false;
  Safety_Cut(SAFETY_REQUESTED);    /* coupe sans désarmer : un arrêt voulu, pas une faute */
}

void Openloop_OnControlTick(void)
{
  if (!s_active) {
    return;
  }
  /* Les sorties ont pu tomber pour n'importe quelle raison — terme atteint, surintensité,
   * watchdog, faute du DRV. La rotation s'arrête avec elles, et ne repartira pas seule. */
  if (!Pwm_IsEnabled()) {
    s_active = false;
    return;
  }

  const float dhz = OL_RAMP_HZ_PER_S / (float)PWM_FREQ_HZ;
  if (s_hz < s_hz_target) {
    s_hz = ((s_hz + dhz) > s_hz_target) ? s_hz_target : (s_hz + dhz);
  } else if (s_hz > s_hz_target) {
    s_hz = ((s_hz - dhz) < s_hz_target) ? s_hz_target : (s_hz - dhz);
  }

  s_theta += (TWO_PI * s_hz) / (float)PWM_FREQ_HZ;
  if (s_theta >= TWO_PI) { s_theta -= TWO_PI; }
  if (s_theta < 0.0f)    { s_theta += TWO_PI; }
  Apply(s_theta);
}

void Openloop_GetStatus(Openloop_Status_t *out)
{
  out->active    = s_active;
  out->amp_pm    = (uint16_t)((s_amp * 1000.0f) + 0.5f);
  out->hz_target = s_hz_target;
  out->hz        = s_hz;
  out->theta_rad = s_theta;
}
