/**
 * @file imot.h
 * @brief Chaîne de mesure de courant — offsets, bruit, et passage en counts centrés.
 *
 * Étape 4 du bring-up (`AGENTS.md` §5) : « offsets stables moteur à l'arrêt, bruit mesuré
 * et documenté ». C'est la première étape que la retouche de la référence du 2026-09-21 a
 * rendue faisable — avant, les trois amplificateurs de shunt n'étaient pas alimentés.
 *
 * ### Ce qu'on mesure, et pourquoi en deux fois
 *
 * Les sorties `SOx` du DRV8304 sont polarisées à `VREF/2` en mode bidirectionnel. Le zéro
 * de courant devrait donc tomber à la moitié de l'échelle de l'ADC — 2048 counts depuis que
 * la référence du DRV et celle du MCU sont la même. Il n'y tombe jamais exactement : il
 * reste l'offset d'entrée de l'amplificateur, celui de l'ADC, et la dissymétrie des pistes.
 * Cet écart doit être mesuré puis soustrait, sinon il devient un couple parasite constant.
 *
 * Deux campagnes, parce qu'elles ne disent pas la même chose :
 *
 *  - **`IMOT.CAL`** lève la broche `CAL` du DRV, qui court-circuite les entrées des
 *    amplificateurs. Ce qui sort est alors le zéro vrai de la chaîne, indépendamment de ce
 *    qui traverse les shunts. C'est ce zéro-là qu'on mémorise.
 *  - **`IMOT.NOISE`** ne touche à rien et mesure la chaîne telle qu'elle travaille. L'écart
 *    entre les deux campagnes est l'information utile : si elles donnent le même zéro, les
 *    shunts ne voient effectivement aucun courant ; si elles divergent, quelque chose passe.
 *
 * ### Le bruit
 *
 * L'écart-type est rendu en **milli-counts** pour qu'un bruit inférieur au pas de
 * quantification reste lisible. Il se compare à une référence simple : un count vaut
 * `VREF / 4096`, soit 0,806 mV, c'est-à-dire 4 mA sur un shunt de 10 mΩ avec le gain de
 * 20 V/V par défaut. Un bruit de quelques counts est donc de l'ordre de la dizaine de
 * milliampères, et c'est lui qui fixera le plancher de la boucle de courant.
 */
#ifndef IMOT_H
#define IMOT_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Plafond d'une campagne : 20 000 échantillons, soit une seconde de boucle à 20 kHz. */
#define IMOT_CAL_MAX_SAMPLES  20000UL

/* Campagne lancée au démarrage : 4000 échantillons, soit 200 ms de boucle, écoulés pendant
 * que l'USB s'énumère. C'est la valeur par défaut d'`IMOT.CAL`, dont la répétabilité est
 * mesurée à ±1 count sur quatre campagnes (STATUS.md, étape 4). */
#define IMOT_BOOT_SAMPLES     4000UL

/* Écart maximal à la mi-échelle pour qu'une moyenne soit acceptée comme zéro. Les offsets
 * mesurés sur cette carte valent 1 à 11 counts ; 150 counts, soit ~120 mV, laissent large
 * au composant et à la température, et refusent ce que la carte donnait avant la retouche
 * de `VREF` — 2126, 1650 et 80 — qu'une calibration aveugle aurait pris pour un zéro. */
#define IMOT_ZERO_TOL_COUNTS  150U

typedef struct
{
  uint16_t mean[3];        /**< moyenne par phase, en counts                          */
  uint16_t min[3];
  uint16_t max[3];
  uint16_t sigma_mcnt[3];  /**< écart-type en **milli**-counts                        */
  uint32_t samples;        /**< échantillons de la dernière campagne                  */
  bool     used_cal_pin;   /**< la broche `CAL` du DRV était-elle levée               */
} Imot_Campaign_t;

void Imot_Init(void);

/**
 * Lance une campagne. Ne bloque pas : c'est l'ISR qui accumule, la superloop qui attend.
 * @param store        mémorise la moyenne comme offset de travail à la fin de la campagne.
 * @param use_cal_pin  lève la broche `CAL` du DRV pendant toute la campagne, ce qui
 *                     court-circuite les entrées des amplificateurs et donne le zéro vrai
 *                     de la chaîne. Le module la relève et la rabaisse lui-même : c'est
 *                     lui qui connaît la procédure, pas l'appelant.
 * @return false si une campagne est déjà en cours ou si `samples` sort des bornes.
 */
bool Imot_StartCampaign(uint32_t samples, bool store, bool use_cal_pin);

bool Imot_Busy(void);

/**
 * Clôt une campagne terminée, depuis la superloop. Sans cet appel, une campagne lancée par
 * le firmware lui-même — celle du démarrage — attendrait qu'une commande console vienne
 * la relever, avec la broche `CAL` levée entre-temps.
 */
void Imot_Process(void);

/** Dernière campagne terminée. */
void Imot_GetCampaign(Imot_Campaign_t *out);

/**
 * Offsets de travail, et s'ils ont été mesurés ou seulement supposés. Une campagne dont
 * une moyenne s'écarte de plus de `IMOT_ZERO_TOL_COUNTS` de la mi-échelle n'est pas
 * mémorisée : `measured` reste faux, et le résultat reste lisible par `Imot_GetCampaign`.
 */
void Imot_GetOffsets(uint16_t out[3], bool *measured);

/**
 * Accumulation, appelée depuis l'ISR de contrôle juste après la lecture du groupe injecté.
 * Hors campagne elle ne coûte qu'une comparaison.
 */
void Imot_OnSample(uint16_t a, uint16_t b, uint16_t c);

/**
 * Courants centrés, en counts signés : le brut moins l'offset. Positif = le courant entre
 * dans la phase. Toujours en counts, jamais en ampères — la conversion en ampères demande
 * le gain de l'amplificateur, qui se règle par SPI, et l'étape 5 pour la vérifier.
 */
void Imot_Apply(uint16_t a, uint16_t b, uint16_t c, int16_t *ia, int16_t *ib, int16_t *ic);

#ifdef __cplusplus
}
#endif
#endif /* IMOT_H */
