/**
 * @file openloop.h
 * @brief Boucle ouverte — M3, étape 10 : le champ tourne, l'arbre suit.
 *
 * Un vecteur de tension d'amplitude fixe tourne à une fréquence électrique donnée, atteinte
 * par une rampe. Aucune mesure n'intervient dans la commande : c'est l'essai qui précède toute
 * boucle fermée, et il répond à une seule question — le moteur suit-il un champ tournant, sans
 * décrocher, avec un courant maîtrisé ?
 *
 * La commande passe par la même barrière que `PWM ON` (`Safety_EnableOutputs`) : armement,
 * surintensité, watchdog de flux, et une durée décomptée dans l'ISR. Les limites propres à la
 * boucle ouverte sont ci-dessous ; elles sont dans le firmware, pas dans l'hôte.
 */
#ifndef OPENLOOP_H
#define OPENLOOP_H

#include <stdbool.h>
#include <stdint.h>

#include "safety.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Amplitude maximale autour de 500 ‰. L'écart entre deux bras vaut au plus l'amplitude × √3 :
 * 57 ‰ en donnent 98,7, sous la limite de 100 ‰ de la PWM d'essai (`pwm.h`) à tout angle. */
#define OL_MAX_AMP_PM        57U

/* Fréquence électrique maximale, en valeur absolue. Avec 7 paires de pôles, ≈ 2,9 tr/s
 * mécaniques : de quoi voir le moteur suivre, pas de quoi emballer une masse. */
#define OL_MAX_ELEC_HZ       20.0f

/* Rampe de fréquence : le rotor ne suit pas un saut de fréquence, il suit une rampe. */
#define OL_RAMP_HZ_PER_S     20.0f

/* Durée maximale d'une rotation. Au-delà de 250 ms, le watchdog de flux exige que l'hôte parle. */
#define OL_MAX_MS            10000UL

typedef enum
{
  OL_OK = 0,
  OL_ERR_ARG,          /**< durée nulle ou valeur illisible                              */
  OL_ERR_LIMIT,        /**< amplitude ou fréquence au-delà des limites ci-dessus         */
  OL_ERR_BUSY,         /**< sorties déjà actives                                          */
  OL_ERR_ENABLE,       /**< la barrière a refusé : voir `enable`                          */
} Openloop_Result_t;

typedef struct
{
  bool     active;
  uint16_t amp_pm;
  float    hz_target;
  float    hz;           /**< fréquence atteinte par la rampe                              */
  float    theta_rad;    /**< angle électrique commandé, [0, 2π)                          */
} Openloop_Status_t;

/**
 * Lance la rotation. Depuis la superloop. L'angle part de 0 — la position où l'étape 8 a
 * aligné le rotor — et la fréquence part de 0.
 * @param enable rempli avec le refus de la barrière quand le résultat est `OL_ERR_ENABLE`.
 */
Openloop_Result_t Openloop_Start(uint16_t amp_pm, float elec_hz, uint32_t ms,
                                 SafetyEnable_t *enable);

/** Arrête la rotation et coupe les sorties, sans désarmer. */
void Openloop_Stop(void);

/** Depuis l'ISR de contrôle, après la surveillance du courant. */
void Openloop_OnControlTick(void);

void Openloop_GetStatus(Openloop_Status_t *out);

#ifdef __cplusplus
}
#endif

#endif /* OPENLOOP_H */
