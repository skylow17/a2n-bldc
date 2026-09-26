/**
 * @file ctrl.h
 * @brief Boucle de contrôle temps réel, appelée à 20 kHz depuis l'ISR de fin de
 *        conversion injectée de l'ADC1.
 *
 * Étape M0 : la boucle ne calcule rien. Elle sert à établir et à mesurer le squelette
 * temps réel — c'est exactement ce qui manquait au firmware v1, où la FOC n'était même
 * pas appelée et où tout tournait dans une superloop bloquante.
 */
#ifndef CTRL_H
#define CTRL_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct
{
  uint32_t ticks;          /**< nombre d'appels de l'ISR depuis le démarrage        */
  uint32_t cycles_last;    /**< durée du dernier passage, en cycles DWT (144 MHz)   */
  uint32_t cycles_max;     /**< pire cas observé, remis à zéro par Ctrl_ResetStats  */
  uint16_t raw_ia;         /**< brut ADC phase A, instantané                        */
  uint16_t raw_ib;
  uint16_t raw_ic;
  int16_t  cent_ia;        /**< courant phase A centre sur l'offset, en counts       */
  int16_t  cent_ib;
  int16_t  cent_ic;
  float    pos_rad;        /**< angle mecanique extrapole au dernier tour d'ISR     */
  float    vel_rad_s;      /**< vitesse mecanique estimee                           */
  uint16_t enc_age_us;     /**< age de l'echantillon d'angle a ce tour d'ISR        */
  uint8_t  enc_valid;      /**< 0 tant qu'aucun angle coherent n'a ete publie       */
  float    theta_e_rad;    /**< angle électrique mesuré, [0, 2π)                    */
  float    id_a;           /**< courant d'axe d, ampères à ±15 %                    */
  float    iq_a;           /**< courant d'axe q                                     */
  float    ol_theta_rad;   /**< angle commandé par la boucle ouverte, 0 hors rotation */
  uint8_t  foc_valid;      /**< 1 quand les trois précédents sont une mesure        */
} Ctrl_Stats_t;

void Ctrl_Init(void);

/** Corps de l'ISR 20 kHz. Appelé uniquement depuis ADC1_2_IRQHandler. */
void Ctrl_Isr(void);

void Ctrl_GetStats(Ctrl_Stats_t *out);
void Ctrl_ResetStats(void);

#ifdef __cplusplus
}
#endif
#endif /* CTRL_H */
