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

/* Limites des rapports cycliques des commandes d'essai (étape 5), en pour mille.
 * `PWM_TEST_MAX_PM` garde au transistor bas une conduction d'au moins 5 µs **après** le
 * sommet du comptage : la troisième voie injectée finit d'échantillonner 4,5 µs après lui
 * (`ADC_IMOT_SAMPLETIME`, `board.h`), et avant lui la conduction a commencé assez tôt pour
 * que l'ampli se soit établi (1,55 µs, fiche technique). Au-delà, le courant de la phase la
 * plus chargée serait lu transistor bas ouvert — plus mesuré, donc plus surveillé. Était
 * 900 ‰ avec un échantillonnage de 180 ns ; abaissé à 800 ‰ avec celui de 1,32 µs.
 * `PWM_TEST_MAX_SPREAD_PM` borne l'écart entre bras, c'est-à-dire la tension aux bornes du
 * bobinage : 100 ‰ font 1,5 V sous 15 V. Des limites, pas des réglages (`AGENTS.md` §4). */
#define PWM_TEST_MAX_PM         800U
#define PWM_TEST_MAX_SPREAD_PM  100U

/** Vrai si le triplet respecte les limites d'essai ci-dessus. */
bool Pwm_TestDutyOk(uint16_t a, uint16_t b, uint16_t c);

/** Rapports cycliques bruts, 0..PWM_ARR. Écriture directe des CCR, sans mise en forme. */
void Pwm_SetDutyRaw(uint16_t a, uint16_t b, uint16_t c);

/** Rapports cycliques en pour mille, 0..1000, pour les essais à vide de M2. */
void Pwm_SetDutyPermille(uint16_t a, uint16_t b, uint16_t c);
void Pwm_GetDutyPermille(uint16_t *a, uint16_t *b, uint16_t *c);

#ifdef __cplusplus
}
#endif
#endif /* PWM_H */
