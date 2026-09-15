/**
 * @file adc_sync.h
 * @brief ADC1 — groupe injecté, déclenché par TIM1, jamais en conversion continue.
 *
 * Le v1 laissait l'ADC tourner en roue libre avec un DMA circulaire : sur des shunts
 * low-side, cela revient à mesurer le courant à un instant arbitraire du cycle PWM,
 * donc à ne rien mesurer du tout. Ici chaque conversion est calée sur TIM1.
 */
#ifndef ADC_SYNC_H
#define ADC_SYNC_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Calibre puis arme l'ADC1. À appeler après Pwm_Init(), avant de lancer la boucle. */
void AdcSync_Init(void);

/** Lecture des trois résultats injectés. Appelé depuis l'ISR, doit rester trivial. */
static inline void AdcSync_Read(uint16_t *ia, uint16_t *ib, uint16_t *ic);

#ifdef __cplusplus
}
#endif

#include "stm32g4xx_hal.h"

static inline void AdcSync_Read(uint16_t *ia, uint16_t *ib, uint16_t *ic)
{
  *ia = (uint16_t)ADC1->JDR1;
  *ib = (uint16_t)ADC1->JDR2;
  *ic = (uint16_t)ADC1->JDR3;
}

#endif /* ADC_SYNC_H */
