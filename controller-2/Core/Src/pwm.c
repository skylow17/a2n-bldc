/**
 * @file pwm.c
 * @brief TIM1 — PWM 3 phases complémentaire, comptage centré, 20 kHz.
 */
#include "pwm.h"
#include "board.h"

/* Les constantes de timing sont derivees de BOARD_SYSCLK_HZ : on verifie ici qu'elles
 * retombent bien sur ce qu'on croit, plutot que de le verifier une fois a la main.
 * Toute modification de l'horloge systeme ou de la frequence PWM casse le build si la
 * division ne tombe plus juste. */
_Static_assert(BOARD_SYSCLK_HZ / (2UL * (PWM_ARR + 1UL)) == PWM_FREQ_HZ,
               "ARR ne produit pas exactement PWM_FREQ_HZ en comptage centre");
_Static_assert(PWM_ARR <= 0xFFFFUL, "ARR depasse la largeur du compteur TIM1");
_Static_assert(PWM_TRIG_CCR4 < PWM_ARR,
               "l'instant de declenchement ADC doit tomber avant le sommet du comptage");
_Static_assert(PWM_DEADTIME_DTG < 128U,
               "DTG >= 128 change de plage d'encodage : le temps mort ne serait plus DTG x tDTS");

static TIM_HandleTypeDef s_tim1;
static bool              s_enabled;

void Pwm_Init(void)
{
  TIM_ClockConfigTypeDef       clk  = {0};
  TIM_MasterConfigTypeDef      mst  = {0};
  TIM_OC_InitTypeDef           oc   = {0};
  TIM_BreakDeadTimeConfigTypeDef bdt = {0};

  s_enabled = false;

  s_tim1.Instance               = PWM_TIM;
  s_tim1.Init.Prescaler         = 0U;
  s_tim1.Init.CounterMode       = TIM_COUNTERMODE_CENTERALIGNED1;
  s_tim1.Init.Period            = PWM_ARR;
  s_tim1.Init.ClockDivision     = TIM_CLOCKDIVISION_DIV1;   /* tDTS = 1 / 144 MHz */
  s_tim1.Init.RepetitionCounter = 0U;
  s_tim1.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(&s_tim1) != HAL_OK) {
    Board_FatalError("pwm");
  }

  clk.ClockSource = TIM_CLOCKSOURCE_INTERNAL;
  if (HAL_TIM_ConfigClockSource(&s_tim1, &clk) != HAL_OK) {
    Board_FatalError("pwm");
  }

  /* TRGO = OC4REF : c'est CH4 qui définit l'instant de déclenchement de l'ADC.
   * Le mode « reset » de TRGO2 n'est pas utilisé, l'ADC se cale sur TRGO. */
  mst.MasterOutputTrigger  = TIM_TRGO_OC4REF;
  mst.MasterOutputTrigger2 = TIM_TRGO2_RESET;
  mst.MasterSlaveMode      = TIM_MASTERSLAVEMODE_DISABLE;
  if (HAL_TIMEx_MasterConfigSynchronization(&s_tim1, &mst) != HAL_OK) {
    Board_FatalError("pwm");
  }

  /* Phases A, B, C. PWM mode 1 : sortie haute tant que CNT < CCR, donc rapport cyclique
   * nul au démarrage = transistor haut toujours ouvert. */
  oc.OCMode       = TIM_OCMODE_PWM1;
  oc.Pulse        = 0U;
  oc.OCPolarity   = TIM_OCPOLARITY_HIGH;
  oc.OCNPolarity  = TIM_OCNPOLARITY_HIGH;
  oc.OCFastMode   = TIM_OCFAST_DISABLE;
  oc.OCIdleState  = TIM_OCIDLESTATE_RESET;
  oc.OCNIdleState = TIM_OCNIDLESTATE_RESET;
  for (uint32_t ch = TIM_CHANNEL_1; ch <= TIM_CHANNEL_3; ch += 4U) {
    if (HAL_TIM_PWM_ConfigChannel(&s_tim1, &oc, ch) != HAL_OK) {
      Board_FatalError("pwm");
    }
  }

  /* CH4 ne sort sur aucune broche : il ne sert qu'à produire TRGO.
   * PWM mode 2 → OC4REF monte quand CNT ≥ CCR4, soit une fois par période PWM, juste
   * avant le sommet du comptage — au milieu de la conduction des transistors bas. */
  oc.OCMode = TIM_OCMODE_PWM2;
  oc.Pulse  = PWM_TRIG_CCR4;
  if (HAL_TIM_PWM_ConfigChannel(&s_tim1, &oc, TIM_CHANNEL_4) != HAL_OK) {
    Board_FatalError("pwm");
  }

  /* OSSI/OSSR désactivés : quand MOE tombe, les sorties repassent en haute impédance
   * au lieu d'être forcées à un état inactif piloté. C'est ce qu'on veut sur un pont
   * triphasé — le moteur se met en roue libre. */
  bdt.OffStateRunMode  = TIM_OSSR_DISABLE;
  bdt.OffStateIDLEMode = TIM_OSSI_DISABLE;
  bdt.LockLevel        = TIM_LOCKLEVEL_OFF;
  bdt.DeadTime         = PWM_DEADTIME_DTG;
  bdt.BreakState       = TIM_BREAK_DISABLE;   /* DRV_nFAULT n'est pas sur un TIM1_BKIN */
  bdt.BreakPolarity    = TIM_BREAKPOLARITY_HIGH;
  bdt.BreakFilter      = 0U;
  bdt.Break2State      = TIM_BREAK2_DISABLE;
  bdt.Break2Polarity   = TIM_BREAK2POLARITY_HIGH;
  bdt.Break2Filter     = 0U;
  bdt.AutomaticOutput  = TIM_AUTOMATICOUTPUT_DISABLE;
  if (HAL_TIMEx_ConfigBreakDeadTime(&s_tim1, &bdt) != HAL_OK) {
    Board_FatalError("pwm");
  }

  /* Les comparateurs tournent — donc TRGO et l'ADC aussi — mais MOE reste à zéro :
   * aucun transistor n'est piloté tant que Pwm_Enable() n'a pas été appelé.
   * Le squelette temps réel peut ainsi être mesuré moteur totalement au repos. */
  for (uint32_t ch = TIM_CHANNEL_1; ch <= TIM_CHANNEL_4; ch += 4U) {
    if (HAL_TIM_PWM_Start(&s_tim1, ch) != HAL_OK) {
      Board_FatalError("pwm");
    }
  }
  /* Les sorties complémentaires ont leur propre bit d'activation (CCxNE), que
   * HAL_TIM_PWM_Start ne touche pas. Sans lui, OCxN n'est pas piloté du tout — la broche
   * reste en l'air et ne montre que la diaphonie du P. Vu à l'oscilloscope à l'étape 3 :
   * les trois P propres à 20 kHz, les trois N muets. Le squelette M0 n'a jamais eu de bas. */
  for (uint32_t ch = TIM_CHANNEL_1; ch <= TIM_CHANNEL_3; ch += 4U) {
    if (HAL_TIMEx_PWMN_Start(&s_tim1, ch) != HAL_OK) {
      Board_FatalError("pwm");
    }
  }
  PWM_TIM->BDTR &= ~TIM_BDTR_MOE;
}

void Pwm_Enable(void)
{
  PWM_TIM->BDTR |= TIM_BDTR_MOE;
  s_enabled = true;
}

void Pwm_Disable(void)
{
  PWM_TIM->BDTR &= ~TIM_BDTR_MOE;
  s_enabled = false;
}

bool Pwm_IsEnabled(void)
{
  return s_enabled;
}

void Pwm_SetDutyRaw(uint16_t a, uint16_t b, uint16_t c)
{
  PWM_TIM->CCR1 = a;
  PWM_TIM->CCR2 = b;
  PWM_TIM->CCR3 = c;
}

/* En comptage centré, CCR = ARR + 1 donne 100 % et 0 donne 0 %. Les trois écritures sont
 * préchargées : elles prennent effet ensemble à l'événement de mise à jour suivant. */
static uint16_t PermilleToCcr(uint16_t pm)
{
  if (pm > 1000U) { pm = 1000U; }
  return (uint16_t)(((uint32_t)pm * (PWM_ARR + 1UL)) / 1000UL);
}

static uint16_t CcrToPermille(uint32_t ccr)
{
  return (uint16_t)((ccr * 1000UL + (PWM_ARR + 1UL) / 2UL) / (PWM_ARR + 1UL));
}

bool Pwm_TestDutyOk(uint16_t a, uint16_t b, uint16_t c)
{
  if ((a > PWM_TEST_MAX_PM) || (b > PWM_TEST_MAX_PM) || (c > PWM_TEST_MAX_PM)) {
    return false;
  }
  const uint16_t hi = (a > b) ? ((a > c) ? a : c) : ((b > c) ? b : c);
  const uint16_t lo = (a < b) ? ((a < c) ? a : c) : ((b < c) ? b : c);
  return (uint16_t)(hi - lo) <= PWM_TEST_MAX_SPREAD_PM;
}

void Pwm_SetDutyPermille(uint16_t a, uint16_t b, uint16_t c)
{
  Pwm_SetDutyRaw(PermilleToCcr(a), PermilleToCcr(b), PermilleToCcr(c));
}

void Pwm_GetDutyPermille(uint16_t *a, uint16_t *b, uint16_t *c)
{
  *a = CcrToPermille(PWM_TIM->CCR1);
  *b = CcrToPermille(PWM_TIM->CCR2);
  *c = CcrToPermille(PWM_TIM->CCR3);
}
