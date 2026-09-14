/**
 * @file pwm.h
 * @brief TIM1 — PWM 3 phases complémentaire, comptage centré, 20 kHz.
 *
 * Différences assumées avec le v1 :
 *  - comptage centré au lieu du comptage montant, pour que l'échantillonnage du courant
 *    tombe naturellement au milieu du vecteur nul (shunts low-side) ;
 *  - TRGO issu de OC4REF, donc un instant de déclenchement ADC explicite et réglable ;
 *  - sorties en haute impédance tant que Pwm_Enable() n'a pas été appelé.
 */
#ifndef PWM_H
#define PWM_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Configure TIM1 et démarre le compteur. Les sorties restent inactives (MOE = 0). */
void Pwm_Init(void);

/** Active les sorties. Ne fait rien tant que les rapports cycliques ne sont pas posés. */
void Pwm_Enable(void);

/** Coupe les sorties immédiatement : MOE = 0, les six transistors passent en haute
 *  impédance. Sûr à appeler depuis n'importe quel contexte, y compris une ISR. */
void Pwm_Disable(void);

bool Pwm_IsEnabled(void);

/** Rapports cycliques bruts, 0..PWM_ARR. Écriture directe des CCR, sans mise en forme. */
void Pwm_SetDutyRaw(uint16_t a, uint16_t b, uint16_t c);

#ifdef __cplusplus
}
#endif
#endif /* PWM_H */
