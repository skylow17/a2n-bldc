/**
 * @file foc.c
 * @brief Courant dans le repère du rotor, et sa régulation — voir `foc.h`.
 */
#include "foc.h"

#include <math.h>

#include "board.h"
#include "openloop.h"
#include "pwm.h"
#include "sensors.h"
#include "comm/param.h"

#define FOC_TWO_PI     6.28318531f
#define FOC_INV_SQRT3  0.57735027f
#define FOC_SQRT3_2    0.86602540f
#define FOC_Q31_INV    (1.0f / 2147483648.0f)
#define FOC_TS_S       (1.0f / (float)PWM_FREQ_HZ)

/* La limite de tension est celle de la boucle ouverte, et pour la même raison : l'écart entre
 * deux bras vaut au plus l'amplitude × √3, que `openloop.c` garde sous la limite de la PWM
 * d'essai par une assertion statique. Une seule constante, pas deux qui pourraient diverger. */
#define FOC_MAX_AMP    ((float)OL_MAX_AMP_PM / 1000.0f)

typedef struct
{
  bool  ok;             /* mesure possible : CORDIC et p, φ, sens, échelle plausibles */
  bool  gains_ok;       /* régulation possible : R et L plausibles aussi              */
  float offset_turns;   /* φ / 2π                                                    */
  float k;              /* sens · p : tours électriques par tour méca                 */
  float scale_a;        /* ampères par count corrigé                                  */
  float kp;             /* V/A                                                        */
  float ki_ts;          /* V/A par passage : Ki · Ts                                   */
  float vbus;           /* V, rail moteur mesuré ; 0 tant qu'il n'est pas plausible    */
} Cfg_t;

static volatile Cfg_t s_cfg;
static Foc_Meas_t     s_last;
static bool           s_cordic_ok;   /* CSR tenue et auto-test passé, posé par `Foc_Init` */

/* Boucle de courant. Consignes et état n'appartiennent qu'à l'ISR une fois `s_cl_active`
 * levé ; la superloop ne les écrit qu'avant de le lever. */
static volatile bool s_cl_active;
static float    s_id_ref, s_iq_ref;
static float    s_int_d, s_int_q;
static float    s_sum_id, s_sum_iq;
static uint32_t s_cl_ticks, s_sat_ticks;
static float    s_vd, s_vq;

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

/* Racine carrée par l'instruction du FPU. `sqrtf` de la bibliothèque, en flash, garde un
 * chemin d'appel pour `errno` ; ici l'argument est une somme de carrés, jamais négatif. */
static inline float Sqrt(float x)
{
  float r;
  __asm volatile ("vsqrt.f32 %0, %1" : "=t"(r) : "t"(x));
  return r;
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
  Sensors_t sn;
  Sensors_Get(&sn);

  Cfg_t c;
  c.ok = s_cordic_ok
      && (m.pole_pairs >= 1U) && (m.pole_pairs <= 64U)
      && ((m.direction == 1) || (m.direction == -1))
      && (m.imot_scale_a > 0.0f) && isfinite(m.imot_scale_a)
      && isfinite(m.elec_offset_rad);
  c.gains_ok = c.ok
      && (m.r_ohm >= FOC_R_MIN_OHM) && (m.r_ohm <= FOC_R_MAX_OHM)
      && (m.l_h >= FOC_L_MIN_H) && (m.l_h <= FOC_L_MAX_H);
  c.offset_turns = c.ok ? (m.elec_offset_rad / FOC_TWO_PI) : 0.0f;
  c.k            = c.ok ? ((float)m.direction * (float)m.pole_pairs) : 0.0f;
  c.scale_a      = c.ok ? m.imot_scale_a : 0.0f;

  /* Compensation du pôle électrique : le zéro du PI, Ki/Kp = R/L, tombe sur le pôle du
   * moteur, et la boucle fermée devient un premier ordre de bande passante ωc. */
  const float wc = FOC_TWO_PI * FOC_CL_BW_HZ;
  c.kp    = c.gains_ok ? (m.l_h * wc) : 0.0f;
  c.ki_ts = c.gains_ok ? (m.r_ohm * wc * FOC_TS_S) : 0.0f;

  const float vbus = (float)sn.vmot_mv * 1e-3f;
  c.vbus = (vbus >= FOC_VBUS_MIN_V) ? vbus : 0.0f;

  /* On ne masque les interruptions que si quelque chose a changé : ce passage a lieu à
   * chaque tour de superloop, et l'ISR n'a pas à en payer la gigue pour rien. Le rail change
   * à chaque mesure, mais d'un bloc : l'ISR ne voit jamais un jeu à moitié écrit. */
  if ((c.ok != s_cfg.ok) || (c.gains_ok != s_cfg.gains_ok)
      || (c.offset_turns != s_cfg.offset_turns) || (c.k != s_cfg.k)
      || (c.scale_a != s_cfg.scale_a) || (c.kp != s_cfg.kp) || (c.ki_ts != s_cfg.ki_ts)
      || (c.vbus != s_cfg.vbus)) {
    __disable_irq();
    s_cfg.ok           = c.ok;
    s_cfg.gains_ok     = c.gains_ok;
    s_cfg.offset_turns = c.offset_turns;
    s_cfg.k            = c.k;
    s_cfg.scale_a      = c.scale_a;
    s_cfg.kp           = c.kp;
    s_cfg.ki_ts        = c.ki_ts;
    s_cfg.vbus         = c.vbus;
    __enable_irq();
  }
}

/* Un passage de régulation : PI par axe, limite de tension en module, puis Park inverse et
 * modulation sinusoïdale autour de 50 %. Les rapports posés ici valent pour la période
 * suivante — les CCR sont préchargés. */
static void Regulate(float c, float s, float id, float iq)
{
  const float kp = s_cfg.kp;
  const float ki_ts = s_cfg.ki_ts;
  const float vbus = s_cfg.vbus;
  const float vmax = FOC_MAX_AMP * vbus;

  const float ed = s_id_ref - id;
  const float eq = s_iq_ref - iq;
  const float int_d = s_int_d + (ki_ts * ed);
  const float int_q = s_int_q + (ki_ts * eq);
  float vd = (kp * ed) + int_d;
  float vq = (kp * eq) + int_q;

  /* Limite en module, direction conservée. Quand elle mord, l'intégrateur n'avance pas :
   * sinon il continuerait d'accumuler une erreur que la tension ne peut plus corriger, et
   * relâcherait tout d'un coup une fois la saturation levée. */
  const float m2 = (vd * vd) + (vq * vq);
  if (m2 > (vmax * vmax)) {
    const float g = vmax / Sqrt(m2);
    vd *= g;
    vq *= g;
    s_sat_ticks++;
  } else {
    s_int_d = int_d;
    s_int_q = int_q;
  }
  s_vd = vd;
  s_vq = vq;

  /* Park inverse, puis rapport au rail : une tension de phase v donne un rapport ½ + v/Vbus
   * en modulation sinusoïdale, la même que la boucle ouverte. */
  const float inv = (vbus > 0.0f) ? (1.0f / vbus) : 0.0f;
  const float na = ((vd * c) - (vq * s)) * inv;
  const float nb = ((vd * s) + (vq * c)) * inv;
  const float h  = FOC_SQRT3_2 * nb;
  const float arr1 = (float)(PWM_ARR + 1UL);
  const float da = 0.5f + na;
  const float db = 0.5f + ((-0.5f * na) + h);
  const float dc = 0.5f + ((-0.5f * na) - h);
  Pwm_SetDutyRaw((uint16_t)(da * arr1), (uint16_t)(db * arr1), (uint16_t)(dc * arr1));
}

void Foc_OnControlTick(int16_t ia, int16_t ib, int16_t ic, bool enc_ok, float turn,
                       Foc_Meas_t *out)
{
  const bool  ok      = s_cfg.ok;
  const float offset  = s_cfg.offset_turns;
  const float k       = s_cfg.k;
  const float scale_a = s_cfg.scale_a;

  out->vd_v = 0.0f;
  out->vq_v = 0.0f;

  if (!ok || !enc_ok) {
    out->valid       = false;
    out->theta_e_rad = 0.0f;
    out->id_a        = 0.0f;
    out->iq_a        = 0.0f;
    s_last = *out;
    /* Sans angle, la boucle commuterait à l'aveugle : elle coupe, et c'est une faute. */
    if (s_cl_active) {
      s_cl_active = false;
      Safety_Cut(SAFETY_ANGLE_LOST);
    }
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

  if (s_cl_active) {
    /* Les sorties ont pu tomber pour n'importe quelle raison — terme atteint, surintensité,
     * watchdog, `STOP`. La boucle s'arrête avec elles, et ne repartira pas seule. */
    if (!Pwm_IsEnabled()) {
      s_cl_active = false;
    } else {
      Regulate(c, s, out->id_a, out->iq_a);
      s_sum_id += out->id_a;
      s_sum_iq += out->iq_a;
      s_cl_ticks++;
      out->vd_v = s_vd;
      out->vq_v = s_vq;
    }
  }
  s_last = *out;
}

Foc_ClResult_t Foc_ClStart(int32_t id_ma, int32_t iq_ma, uint32_t ms, SafetyEnable_t *enable)
{
  if (ms == 0UL) {
    return FOC_CL_ERR_ARG;
  }
  if ((id_ma > FOC_CL_MAX_MA) || (id_ma < -FOC_CL_MAX_MA) || (iq_ma > FOC_CL_MAX_MA)
      || (iq_ma < -FOC_CL_MAX_MA) || (ms > FOC_CL_MAX_MS)) {
    return FOC_CL_ERR_LIMIT;
  }
  if (Pwm_IsEnabled()) {
    return FOC_CL_ERR_BUSY;
  }
  if (!s_cfg.gains_ok) {
    return FOC_CL_ERR_CFG;
  }
  if (s_cfg.vbus <= 0.0f) {
    return FOC_CL_ERR_VBUS;
  }
  if (!s_last.valid) {
    return FOC_CL_ERR_ANGLE;
  }

  s_id_ref    = (float)id_ma * 1e-3f;
  s_iq_ref    = (float)iq_ma * 1e-3f;
  s_int_d     = 0.0f;
  s_int_q     = 0.0f;
  s_sum_id    = 0.0f;
  s_sum_iq    = 0.0f;
  s_cl_ticks  = 0U;
  s_sat_ticks = 0U;
  s_vd        = 0.0f;
  s_vq        = 0.0f;
  /* Tension nulle au départ : 50 % sur les trois bras. Les CCR sont préchargés, posés avant
   * `MOE` ; le premier passage de l'ISR après l'activation prend la main. */
  const uint16_t half = (uint16_t)((PWM_ARR + 1UL) / 2UL);
  Pwm_SetDutyRaw(half, half, half);

  const SafetyEnable_t r = Safety_EnableOutputs(ms);
  if (r != SAFETY_EN_OK) {
    if (enable != NULL) {
      *enable = r;
    }
    return FOC_CL_ERR_ENABLE;
  }
  s_cl_active = true;
  return FOC_CL_OK;
}

void Foc_ClStop(void)
{
  s_cl_active = false;
  Safety_Cut(SAFETY_REQUESTED);    /* coupe sans désarmer : un arrêt voulu, pas une faute */
}

void Foc_ClGetStatus(Foc_ClStatus_t *out)
{
  __disable_irq();
  out->active    = s_cl_active;
  out->id_ref    = s_id_ref;
  out->iq_ref    = s_iq_ref;
  out->id_avg    = (s_cl_ticks > 0U) ? (s_sum_id / (float)s_cl_ticks) : 0.0f;
  out->iq_avg    = (s_cl_ticks > 0U) ? (s_sum_iq / (float)s_cl_ticks) : 0.0f;
  out->vd        = s_vd;
  out->vq        = s_vq;
  out->ticks     = s_cl_ticks;
  out->sat_ticks = s_sat_ticks;
  out->kp        = s_cfg.kp;
  out->ki        = s_cfg.ki_ts * (float)PWM_FREQ_HZ;
  __enable_irq();
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
