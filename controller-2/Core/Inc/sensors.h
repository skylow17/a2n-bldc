/**
 * @file sensors.h
 * @brief Mesures lentes : rails d'alimentation, référence interne, et relecture lente des
 *        trois entrées de courant.
 *
 * Tout ici est hors temps réel : un tourniquet d'une conversion par passage de superloop,
 * jamais bloquant, jamais dans l'ISR. Les courants « vrais » restent ceux du groupe injecté
 * (`adc_sync.c`) ; la relecture lente des mêmes broches sert au diagnostic — comparer les
 * deux dit si un zéro vient de l'entrée ou de l'acquisition synchrone.
 *
 * VREF+ n'est pas supposé : il est mesuré à chaque tour via VREFINT et la valeur d'usine.
 * Le schéma dit 2,048 V (MCP1501) ; la carte dira ce qu'il en est.
 */
#ifndef SENSORS_H
#define SENSORS_H

#include <stdbool.h>
#include <stdint.h>

typedef struct
{
  uint16_t vref_mv;       /**< VREF+ réel, déduit de VREFINT. 0 tant que non mesuré.     */
  uint16_t vin_mv;        /**< Entrée d'alimentation, après diviseur ×13.                  */
  uint16_t vmot_mv;       /**< Rail moteur, ×16.                                           */
  uint16_t v5_mv;         /**< Rail 5 V, ×2,5.                                             */
  uint16_t v3v3_mv;       /**< Rail 3,3 V, ×1,68.                                          */
  uint16_t csa_raw[3];    /**< Entrées de courant A/B/C, échantillonnage long, counts.     */
  uint16_t csa_mv[3];     /**< Les mêmes en millivolts, avec le VREF+ mesuré.              */
  uint16_t vrefint_raw;   /**< Brut, pour vérifier le calcul.                              */
  int16_t  mcu_temp_c;    /**< Jonction du MCU, en degrés, capteur interne et calibration. */
  uint32_t rounds;        /**< Tours de tourniquet complets depuis le reset.               */
} Sensors_t;

void Sensors_Init(void);

/** Une conversion par appel au plus. À appeler depuis la superloop. */
void Sensors_Process(void);

/** Dernier tour complet. Cohérent : copié sous masquage. */
void Sensors_Get(Sensors_t *out);

/**
 * Repart d'un tour neuf. À appeler par tout code qui a lancé une conversion régulière de
 * son côté : lire `DR` efface `EOC`, donc une conversion volée au tourniquet le laisse
 * attendre un drapeau qui ne reviendra jamais, et les mesures se figent sur le dernier
 * tour publié. Le diagnostic de `console.c` est le seul cas aujourd'hui.
 */
void Sensors_Restart(void);

#endif /* SENSORS_H */
