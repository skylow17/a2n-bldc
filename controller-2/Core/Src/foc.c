/**
 * @file foc.c
 * @brief Courant dans le repère du rotor — voir `foc.h`.
 */
#include "foc.h"

#include <math.h>

#include "board.h"
#include "comm/param.h"

#define FOC_TWO_PI     6.28318531f
#define FOC_INV_SQRT3  0.57735027f
#define FOC_Q31_INV    (1.0f / 2147483648.0f)

typedef struct
{
  bool  ok;
  float offset_turns;   /* φ / 2π                                   */
  float k;              /* sens · p : tours électriques par tour méca */
  float scale_a;        /* ampères par count corrigé                 */
} Cfg_t;

static volatile Cfg_t s_cfg;
static Foc_Meas_t     s_last;
static bool           s_cordic_ok;   /* CSR tenue et auto-test passé, posé par `Foc_Init` */

/* Cosinus et sinus d'un angle en tours, [0, 1). Le CORDIC prend l'angle en Q1.31 sur
 * [−π, π) : un tour vaut 2^32, et la conversion en entier signé replie d'elle-même
 * [½, 1) sur [−½, 0). Deux arguments écrits — l'angle puis le module 1 — et deux résultats
 * lus ; la lecture de `RDATA` attend le calcul, quelques cycles. */
static void SinCos(float turns, float *c, float *s)
{
  const int32_t q = (int32_t)(uint32_t)(turns * 4294967296.0f);
  CORDIC->WDATA = (uint32_t)q;
  CORDIC->WDATA = 0x7FFFFFFFUL;
  const int32_t rc = (int32_t)CORDIC->RDATA;
  const int32_t rs = (int32_t)CORDIC->RDATA;
  *c = (float)rc * FOC_Q31_INV;
  *s = (float)rs * FOC_Q31_INV;
}

void Foc_Init(void)
{
  RCC->AHB1ENR |= RCC_AHB1ENR_CORDICEN;
  (void)RCC->AHB1ENR;
  __DSB();

  /* Fonction cosinus (0) : premier résultat m·cos θ, second m·sin θ. 32 bits en entrée et
   * en sortie, deux arguments, deux résultats.
   *
   * Écrite puis relue, jusqu'à ce qu'elle tienne. Vu sur carte le 2026-09-26 : la première
   * écriture juste après l'activation de l'horloge était perdue — malgré la relecture de RCC
   * que prescrit ST —, et CSR restait à sa valeur de reset, un seul résultat. Le « sinus » lu
   * en second valait alors toujours −1, Park tournait sur un axe figé, et Id, Iq oscillaient
   * à la fréquence électrique au lieu de rester constants. Rien ne le signalait. */
  const uint32_t csr = (0UL << CORDIC_CSR_FUNC_Pos)
                     | ((uint32_t)FOC_CORDIC_PRECISION << CORDIC_CSR_PRECISION_Pos)
                     | CORDIC_CSR_NRES
                     | CORDIC_CSR_NARGS;
  for (uint32_t i = 0U; (i < 8U) && (CORDIC->CSR != csr); i++) {
    CORDIC->CSR = csr;
    __DSB();
  }

  /* Puis un calcul connu : un quart de tour doit donner (0, 1). Un CORDIC qui ne passe pas
   * rend la mesure invalide, jamais fausse — `Foc_ConfigOk` le reflète. */
  float c, s;
  SinCos(0.25f, &c, &s);
  s_cordic_ok = (CORDIC->CSR == csr) && (fabsf(c) < 1e-4f) && (fabsf(s - 1.0f) < 1e-4f);

  Foc_Process();
}

void Foc_Process(void)
{
  Param_Motor_t m;
  Param_GetMotor(&m);

  Cfg_t c;
  c.ok = s_cordic_ok
      && (m.pole_pairs >= 1U) && (m.pole_pairs <= 64U)
      && ((m.direction == 1) || (m.direction == -1))
      && (m.imot_scale_a > 0.0f) && isfinite(m.imot_scale_a)
      && isfinite(m.elec_offset_rad);
  c.offset_turns = c.ok ? (m.elec_offset_rad / FOC_TWO_PI) : 0.0f;
  c.k            = c.ok ? ((float)m.direction * (float)m.pole_pairs) : 0.0f;
  c.scale_a      = c.ok ? m.imot_scale_a : 0.0f;

  /* On ne masque les interruptions que si quelque chose a changé : ce passage a lieu à
   * chaque tour de superloop, et l'ISR n'a pas à en payer la gigue pour rien. */
  if ((c.ok != s_cfg.ok) || (c.offset_turns != s_cfg.offset_turns) || (c.k != s_cfg.k)
      || (c.scale_a != s_cfg.scale_a)) {
    __disable_irq();
    s_cfg.ok           = c.ok;
    s_cfg.offset_turns = c.offset_turns;
    s_cfg.k            = c.k;
    s_cfg.scale_a      = c.scale_a;
    __enable_irq();
  }
}

void Foc_OnControlTick(int16_t ia, int16_t ib, int16_t ic, bool enc_ok, float turn,
                       Foc_Meas_t *out)
{
  const bool  ok      = s_cfg.ok;
  const float offset  = s_cfg.offset_turns;
  const float k       = s_cfg.k;
  const float scale_a = s_cfg.scale_a;

  if (!ok || !enc_ok) {
    out->valid       = false;
    out->theta_e_rad = 0.0f;
    out->id_a        = 0.0f;
    out->iq_a        = 0.0f;
    s_last = *out;
    return;
  }

  /* Angle électrique en tours, ramené dans [0, 1) sans `floorf` : la partie entière est
   * petite (|k| ≤ 64, `turn` voisin de [0, 1)), la troncature et un ajustement suffisent. */
  const float x = offset + (k * turn);
  int32_t n = (int32_t)x;
  if (x < (float)n) {
    n--;
  }
  float e = x - (float)n;
  if (e >= 1.0f) {
    e = 0.0f;
  }

  float c, s;
  SinCos(e, &c, &s);

  /* Clarke à amplitude conservée : un courant sinusoïdal d'amplitude I donne un vecteur de
   * module I. Les trois phases servent, pas deux : la somme n'est pas exactement nulle sur
   * cette carte (4,5 % à l'étape 5), et l'erreur se répartit au lieu de tomber sur une voie. */
  const float a = (float)ia * scale_a;
  const float b = (float)ib * scale_a;
  const float d = (float)ic * scale_a;
  const float alpha = ((2.0f * a) - b - d) * (1.0f / 3.0f);
  const float beta  = (b - d) * FOC_INV_SQRT3;

  out->valid       = true;
  out->theta_e_rad = e * FOC_TWO_PI;
  out->id_a        = (alpha * c) + (beta * s);
  out->iq_a        = (beta * c) - (alpha * s);
  s_last = *out;
}

void Foc_GetMeas(Foc_Meas_t *out)
{
  __disable_irq();
  *out = s_last;
  __enable_irq();
}

bool Foc_ConfigOk(void)
{
  return s_cfg.ok;
}
