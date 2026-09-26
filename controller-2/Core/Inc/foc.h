/**
 * @file foc.h
 * @brief Courant dans le repère du rotor — M3, étape 11, premier point.
 *
 * La mesure seule : angle électrique tiré de l'encodeur et des paramètres moteur, puis Clarke
 * et Park sur les trois courants corrigés. Rien ici ne commande l'étage de puissance ; les
 * régulateurs viendront s'appuyer sur cette mesure une fois qu'elle aura été vérifiée en
 * boucle ouverte, là où le vecteur appliqué est connu.
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

#ifdef __cplusplus
extern "C" {
#endif

/** Précision du CORDIC : 4 × 6 = 24 itérations, erreur de l'ordre de 2^-20, bien sous le
 *  bruit des courants. Une précision plus haute ne coûterait que quelques cycles. */
#define FOC_CORDIC_PRECISION  6U

typedef struct
{
  bool  valid;       /**< angle valide et paramètres moteur plausibles                */
  float theta_e_rad; /**< angle électrique mesuré, [0, 2π)                             */
  float id_a;        /**< courant d'axe d, en ampères à ±15 %                          */
  float iq_a;        /**< courant d'axe q                                               */
} Foc_Meas_t;

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

/** Dernière mesure de l'ISR, copiée d'un bloc. */
void Foc_GetMeas(Foc_Meas_t *out);

/** Vrai quand le CORDIC a passé son auto-test et que les paramètres moteur sont plausibles. */
bool Foc_ConfigOk(void);

#ifdef __cplusplus
}
#endif

#endif /* FOC_H */
