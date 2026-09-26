/**
 * @file foc.h
 * @brief Courant dans le repère du rotor, et sa régulation — M3, étape 11.
 *
 * La mesure : angle électrique tiré de l'encodeur et des paramètres moteur, puis Clarke et
 * Park sur les trois courants corrigés. Vérifiée d'abord en boucle ouverte, là où le vecteur
 * appliqué est connu. Puis la régulation : deux PI, un par axe, réglés dans le firmware par
 * compensation du pôle électrique à partir de R et L, tension bornée comme en boucle ouverte.
 *
 * Convention d'angle, celle de l'étape 8 : θe = φ + sens · p · θméca, avec θméca l'angle
 * absolu de l'AS5600. Un champ commandé à θe aligne le rotor à θe.
 *
 * Le sinus et le cosinus viennent du CORDIC du G473, en matériel : `cosf` et `sinf`, restés
 * en flash, portaient l'ISR à 10,5 µs en boucle ouverte. Le CORDIC n'a qu'un utilisateur,
 * l'ISR de contrôle ; un second, en superloop, devrait se coordonner avec elle.
 */
#ifndef FOC_H
#define FOC_H

#include <stdbool.h>
#include <stdint.h>

#include "safety.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Précision du CORDIC : 4 × 6 = 24 itérations, erreur de l'ordre de 2^-20, bien sous le
 *  bruit des courants. Une précision plus haute ne coûterait que quelques cycles. */
#define FOC_CORDIC_PRECISION  6U

/* Boucle de courant. Bande passante visée : 500 Hz, soit ≈ 76° de marge de phase avec le
 * retard d'une période et demie qu'imposent l'échantillonnage et la PWM préchargée. Assez
 * lent pour un premier essai ; rien n'empêchera de monter une fois la réponse relevée. */
#define FOC_CL_BW_HZ      500.0f
#define FOC_CL_MAX_MA     300L       /**< consigne par axe, en valeur absolue            */
#define FOC_CL_MAX_MS     10000UL
#define FOC_VBUS_MIN_V    8.0f       /**< en dessous, la modulation n'a plus de sens     */
#define FOC_R_MIN_OHM     0.1f
#define FOC_R_MAX_OHM     100.0f
#define FOC_L_MIN_H       1e-5f
#define FOC_L_MAX_H       0.1f

typedef struct
{
  bool  valid;       /**< angle valide et paramètres moteur plausibles                */
  float theta_e_rad; /**< angle électrique mesuré, [0, 2π)                             */
  float id_a;        /**< courant d'axe d, en ampères à ±15 %                          */
  float iq_a;        /**< courant d'axe q                                               */
  float vd_v;        /**< tension d'axe d demandée, 0 hors boucle de courant            */
  float vq_v;        /**< tension d'axe q demandée                                      */
} Foc_Meas_t;

typedef enum
{
  FOC_CL_OK = 0,
  FOC_CL_ERR_ARG,     /**< durée nulle                                                    */
  FOC_CL_ERR_LIMIT,   /**< consigne ou durée au-delà des limites                          */
  FOC_CL_ERR_BUSY,    /**< sorties déjà actives                                           */
  FOC_CL_ERR_CFG,     /**< paramètres moteur non plausibles, ou CORDIC en échec           */
  FOC_CL_ERR_VBUS,    /**< rail moteur absent ou trop bas                                 */
  FOC_CL_ERR_ANGLE,   /**< pas d'angle valide au départ                                   */
  FOC_CL_ERR_ENABLE,  /**< la barrière a refusé : voir `enable`                           */
} Foc_ClResult_t;

typedef struct
{
  bool     active;
  float    id_ref, iq_ref;   /**< A */
  float    id_avg, iq_avg;   /**< moyennes depuis le départ, A */
  float    vd, vq;           /**< dernière tension demandée, V */
  uint32_t ticks;            /**< passages régulés */
  uint32_t sat_ticks;        /**< dont passages où la limite de tension a mordu */
  float    kp;               /**< V/A */
  float    ki;               /**< V/(A·s) */
} Foc_ClStatus_t;

/** Horloge et configuration du CORDIC, vérifiées par un calcul connu, puis première lecture
 *  des paramètres. */
void Foc_Init(void);

/** Superloop : recopie p, φ, le sens et l'échelle de courant pour l'ISR. Ces paramètres ne
 *  changent que sorties coupées (`requires_disarm`), mais l'ISR ne lit jamais le
 *  dictionnaire directement : elle ne voit qu'un jeu cohérent, posé d'un seul coup. */
void Foc_Process(void);

/** ISR 20 kHz. Courants en counts corrigés, `turn` l'angle mécanique absolu en tours. */
void Foc_OnControlTick(int16_t ia, int16_t ib, int16_t ic, bool enc_ok, float turn,
                       Foc_Meas_t *out);

/** Lance la boucle de courant. Depuis la superloop, mêmes barrières que la boucle ouverte.
 *  @param enable rempli avec le refus de la barrière quand le résultat est `FOC_CL_ERR_ENABLE`. */
Foc_ClResult_t Foc_ClStart(int32_t id_ma, int32_t iq_ma, uint32_t ms, SafetyEnable_t *enable);

/** Arrête la boucle et coupe les sorties, sans désarmer. */
void Foc_ClStop(void);

void Foc_ClGetStatus(Foc_ClStatus_t *out);

/** Dernière mesure de l'ISR, copiée d'un bloc. */
void Foc_GetMeas(Foc_Meas_t *out);

/** Vrai quand le CORDIC a passé son auto-test et que les paramètres moteur sont plausibles. */
bool Foc_ConfigOk(void);

#ifdef __cplusplus
}
#endif

#endif /* FOC_H */
