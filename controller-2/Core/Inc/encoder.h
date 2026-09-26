/**
 * @file encoder.h
 * @brief Capteur de position AS5600 sur I2C4, lu en DMA, sans jamais bloquer.
 *
 * C'est la marche que le v1 avait ratée, et il faut la nommer pour ne pas la refaire :
 * là-bas, l'angle était lu en I2C **bloquant** depuis la superloop, à 100 kHz, ce qui
 * plafonnait l'ensemble du firmware à environ 1,5 kHz avec de la gigue. Ici, rien
 * n'attend : le transfert se relance tout seul depuis son propre interruption de fin,
 * l'ISR de contrôle ne fait que lire deux mots déjà écrits, et l'interruption I2C est à
 * une priorité inférieure à celle de la boucle et à celle de la coupure sur faute
 * driver. La boucle 20 kHz ne peut donc pas être retardée par le capteur.
 *
 * ### Les trois retards, parce que le critère de l'étape 6 demande de les mesurer
 *
 * 1. **Le capteur lui-même.** L'AS5600 échantillonne toutes les 150 µs, puis filtre. Le
 *    temps d'établissement dépend du champ `SF` du registre `CONF` — et le réglage par
 *    défaut est le pire : 2,2 ms, soit **44 périodes** de la boucle de contrôle. À
 *    3000 tr/min, c'est 40° de rotation mécanique : inutilisable pour orienter un champ.
 *    `Encoder_Init` écrit donc `SF = 11` (0,286 ms) à chaque démarrage. Le bruit passe de
 *    0,015° à 0,043° RMS, ce qui reste très en dessous du pas de quantification de 12 bits
 *    (0,088°) : on ne perd rien de réel, on gagne un facteur 7,7 sur le retard.
 * 2. **Le transport.** Durée du transfert I2C, mesurée (`xfer_us`).
 * 3. **L'âge de l'échantillon.** Temps écoulé depuis la fin du dernier transfert quand
 *    l'ISR demande l'angle, mesuré (`age_us`).
 *
 * L'extrapolation par la vitesse annule (3) et une partie de (2). Elle **n'annule pas**
 * (1) : le retard de groupe du filtre interne reste, et se compense en avançant la
 * prédiction de `ENC_LAG_COMP_US`. Ce nombre est nommé et documenté plutôt que fondu dans
 * un calcul, parce que c'est un choix, pas une mesure.
 */
#ifndef ENCODER_H
#define ENCODER_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Résolution du capteur : 4096 pas sur un tour mécanique. */
#define ENC_COUNTS_PER_REV  4096

/* Magnitude minimale pour déclarer l'angle exploitable. Mesuré sur cette carte le
 * 2026-09-26 : **4 sans aimant**, **1818 avec l'aimant monté** — et ce même aimant met le
 * gain automatique en butée (`AGC` = 128, le maximum en 3,3 V), donc fait lever `ML`.
 * Les bits de `STATUS` ne séparent pas ces deux cas ici : le 2026-09-21, `MD` valait 0
 * pendant que l'angle suivait l'arbre. La magnitude les sépare d'un facteur 450. Le seuil
 * se place à 64 fois le bruit sans aimant et 7 fois sous le plus faible aimant mesuré. */
#define ENC_MAGNITUDE_MIN   256U

typedef struct
{
  bool     present;        /**< le capteur a répondu au moins une fois depuis le reset  */
  bool     magnet_ok;      /**< `magnitude` au-dessus de `ENC_MAGNITUDE_MIN`            */
  uint8_t  status_raw;     /**< registre `STATUS` (0x0B) brut, relu périodiquement      */
  uint16_t magnitude;      /**< `MAGNITUDE` (0x1B), 12 bits, relu périodiquement        */
  uint16_t raw_angle;      /**< `RAW_ANGLE` (0x0C), 12 bits, non filtré ni recadré      */
  float    pos_rad;        /**< angle mécanique extrapolé au moment de l'appel          */
  float    vel_rad_s;      /**< vitesse mécanique estimée, filtrée                      */
  int32_t  turns;          /**< tours mécaniques accumulés, signés                      */
  uint32_t reads_ok;       /**< transferts terminés sans erreur                         */
  uint32_t reads_err;      /**< erreurs I2C (NACK, bus, arbitrage) depuis le reset      */
  uint32_t bus_hz;         /**< fréquence SCL effectivement programmée                  */
  uint16_t xfer_us;        /**< durée du dernier transfert, µs                          */
  uint16_t period_us;      /**< intervalle entre les deux derniers échantillons, µs     */
  uint16_t age_max_us;     /**< pire âge vu par l'ISR depuis la dernière remise à zéro  */
} Encoder_t;

/**
 * Configure I2C4 + DMA, règle le filtre du capteur, et lance la lecture continue.
 * Ne bloque pas au-delà de la poignée de transferts synchrones de configuration, qui
 * ont lieu avant que la boucle de contrôle ne serve à quelque chose.
 */
void Encoder_Init(void);

/** Reprise après erreur et relance si la chaîne s'est arrêtée. Depuis la superloop. */
void Encoder_Process(void);

/**
 * Angle et vitesse à l'instant de l'appel, extrapolés. Conçu pour l'ISR 20 kHz :
 * aucune attente, aucune division, et une lecture déchirée est détectée puis remplacée
 * par le dernier instantané cohérent — jamais par une valeur inventée.
 *
 * @return false tant qu'aucun échantillon valide n'a été publié, **ou tant que le capteur
 *         ne voit pas d'aimant** (`magnet_ok`). Dans ce second cas position et vitesse
 *         valent zéro et `age_us` reste renseigné. Un appelant qui asservit doit tenir
 *         compte du faux : l'angle rendu n'est alors pas une mesure.
 *
 * `pos_rad` compte les tours et reste congru à `RAW_ANGLE` : modulo 2π, c'est l'angle
 * absolu du capteur. `turn` est ce même angle absolu en fraction de tour, [0, 1) à
 * l'extrapolation près — celui dont la commutation a besoin.
 */
bool Encoder_Sample(float *pos_rad, float *vel_rad_s, float *turn, uint16_t *age_us);

void Encoder_Get(Encoder_t *out);

/** Remet à zéro `age_max_us` et les compteurs de transfert. */
void Encoder_ResetStats(void);

/**
 * Change la fréquence du bus. 100, 400 ou 1000 kHz — rien d'autre n'est accepté.
 * Le défaut est 1 MHz, mesuré bon sur cette carte malgré des tirages de 4k7 annotés
 * « TBC » au schéma. La commande existe pour redescendre si une autre carte, ou un
 * câblage plus long, ne tient pas le Fast-mode Plus — et pour pouvoir le vérifier plutôt
 * que d'en décider d'avance.
 */
bool Encoder_SetBusHz(uint32_t hz);

/** Lecture ponctuelle d'un registre du capteur, pour la console. Prend le bus. */
bool Encoder_ReadReg(uint8_t reg, uint8_t *out, uint8_t len);

/** Écriture ponctuelle d'un registre volatile du capteur. Ne grave rien en OTP. */
bool Encoder_WriteReg(uint8_t reg, uint8_t value);

/* Relais depuis `stm32g4xx_it.c`, qui reste le seul endroit où vivent les vecteurs. Les
 * poignées HAL restent privées à `encoder.c`. */
void Encoder_IrqDma(void);
void Encoder_IrqEv(void);
void Encoder_IrqEr(void);

#ifdef __cplusplus
}
#endif
#endif /* ENCODER_H */
