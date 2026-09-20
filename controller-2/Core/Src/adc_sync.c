/**
 * @file adc_sync.c
 * @brief ADC1 — groupe injecté de 3 voies, déclenché par TIM1_TRGO.
 */
#include "adc_sync.h"
#include "board.h"

static ADC_HandleTypeDef s_adc1;

void AdcSync_Init(void)
{
  ADC_InjectionConfTypeDef inj = {0};

  s_adc1.Instance                   = ADC1;
  /* PLLP = 72 MHz, prédiviseur asynchrone /2 → 36 MHz, sous les 60 MHz admis. */
  s_adc1.Init.ClockPrescaler        = ADC_CLOCK_ASYNC_DIV2;
  s_adc1.Init.Resolution            = ADC_RESOLUTION_12B;
  s_adc1.Init.DataAlign             = ADC_DATAALIGN_RIGHT;
  s_adc1.Init.GainCompensation      = 0U;
  /* ADC_SCAN_ENABLE, et pas DISABLE : pour le HAL, « scan désactivé » veut dire « rang 1
   * seulement », groupe injecté compris — `InjectedNbrOfConversion = 3` est alors ignoré
   * en silence et JSQR ne porte qu'une voie. C'est resté invisible de M0 à M2 : la phase A
   * convertissait, B et C lisaient zéro, et zéro ressemblait à un étage de puissance
   * éteint. Trouvé en relisant JSQR sur la carte (`ADC?`). Le mot « scan » n'a aucun effet
   * matériel sur cette famille ; c'est un alignement logiciel entre séries STM32. */
  s_adc1.Init.ScanConvMode          = ADC_SCAN_ENABLE;
  s_adc1.Init.EOCSelection          = ADC_EOC_SINGLE_CONV;
  s_adc1.Init.LowPowerAutoWait      = DISABLE;
  /* Jamais de conversion continue : chaque salve est déclenchée par le timer. */
  s_adc1.Init.ContinuousConvMode    = DISABLE;
  s_adc1.Init.NbrOfConversion       = 1U;
  s_adc1.Init.DiscontinuousConvMode = DISABLE;
  s_adc1.Init.ExternalTrigConv      = ADC_SOFTWARE_START;
  s_adc1.Init.ExternalTrigConvEdge  = ADC_EXTERNALTRIGCONVEDGE_NONE;
  s_adc1.Init.DMAContinuousRequests = DISABLE;
  s_adc1.Init.Overrun               = ADC_OVR_DATA_OVERWRITTEN;
  s_adc1.Init.OversamplingMode      = DISABLE;
  if (HAL_ADC_Init(&s_adc1) != HAL_OK) {
    Board_FatalError("adc");
  }

  /* La calibration se fait impérativement avant d'armer les conversions, ADC allumé
   * mais à l'arrêt. En single-ended : les trois sorties du DRV8304 sont référencées
   * à VREF/2, pas différentielles. */
  if (HAL_ADCEx_Calibration_Start(&s_adc1, ADC_SINGLE_ENDED) != HAL_OK) {
    Board_FatalError("adc");
  }

  /* Trois voies injectées, déclenchées ensemble par le front montant de TIM1_TRGO.
   * 6.5 cycles d'échantillonnage + 12.5 de conversion = 19 cycles à 36 MHz ≈ 528 ns
   * par voie, soit ≈ 1.6 µs pour les trois. La fenêtre de conduction des transistors
   * bas vaut 25 µs à 50 % de rapport cyclique : confortable, mais elle se referme à
   * fort rapport cyclique. Le passage en double ADC simultané sera nécessaire plus
   * tard — c'est noté, pas fait. */
  inj.InjectedSamplingTime           = ADC_IMOT_SAMPLETIME;
  inj.InjectedSingleDiff             = ADC_SINGLE_ENDED;
  inj.InjectedOffsetNumber           = ADC_OFFSET_NONE;
  inj.InjectedOffset                 = 0U;
  inj.InjectedNbrOfConversion        = 3U;
  inj.InjectedDiscontinuousConvMode  = DISABLE;
  inj.AutoInjectedConv               = DISABLE;
  inj.QueueInjectedContext           = DISABLE;
  inj.ExternalTrigInjecConv          = ADC_EXTERNALTRIGINJEC_T1_TRGO;
  inj.ExternalTrigInjecConvEdge      = ADC_EXTERNALTRIGINJECCONV_EDGE_RISING;

  inj.InjectedChannel = ADC_CH_IMOTA;  inj.InjectedRank = ADC_INJECTED_RANK_1;
  if (HAL_ADCEx_InjectedConfigChannel(&s_adc1, &inj) != HAL_OK) { Board_FatalError("adc"); }
  inj.InjectedChannel = ADC_CH_IMOTB;  inj.InjectedRank = ADC_INJECTED_RANK_2;
  if (HAL_ADCEx_InjectedConfigChannel(&s_adc1, &inj) != HAL_OK) { Board_FatalError("adc"); }
  inj.InjectedChannel = ADC_CH_IMOTC;  inj.InjectedRank = ADC_INJECTED_RANK_3;
  if (HAL_ADCEx_InjectedConfigChannel(&s_adc1, &inj) != HAL_OK) { Board_FatalError("adc"); }

  /* Les conversions sont armées sans l'habillage interruption du HAL : à 20 kHz, l'ISR
   * ne doit pas traverser HAL_ADC_IRQHandler et sa cascade de tests de drapeaux.
   * On arme le convertisseur, puis on active nous-mêmes la seule interruption utile —
   * fin de séquence injectée — et on écrit le vecteur à la main dans stm32g4xx_it.c. */
  if (HAL_ADCEx_InjectedStart(&s_adc1) != HAL_OK) {
    Board_FatalError("adc");
  }

  ADC1->ISR  = ADC_ISR_JEOS;        /* w1c : on part d'un drapeau propre */
  ADC1->IER |= ADC_IER_JEOSIE;

  /* Priorité la plus haute : c'est la seule interruption temps réel du système. */
  HAL_NVIC_SetPriority(ADC1_2_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(ADC1_2_IRQn);
}

/* ------------------------------------------------------------------ gel de diagnostic */

static bool s_held;

void AdcSync_SetHold(bool hold)
{
  if (hold == s_held) {
    return;
  }
  if (hold) {
    ADC1->IER &= ~ADC_IER_JEOSIE;
    ADC1->CR  |= ADC_CR_JADSTP;
    while ((ADC1->CR & ADC_CR_JADSTP) != 0U) { }
    s_held = true;
  } else {
    ADC1->ISR  = ADC_ISR_JEOS;
    ADC1->CR  |= ADC_CR_JADSTART;
    ADC1->IER |= ADC_IER_JEOSIE;
    s_held = false;
  }
}

bool AdcSync_IsHeld(void)
{
  return s_held;
}
