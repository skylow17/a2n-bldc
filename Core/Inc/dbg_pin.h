/**
 * @file dbg_pin.h
 * @brief Broche d'instrumentation pour mesurer la durée et la cadence de l'ISR.
 *
 * Sortie sur IO1 / PC14, accessible sur J7 broche 5. Voir board.h pour le pourquoi.
 * Les deux fonctions sont volontairement des écritures registre directes : elles sont
 * appelées depuis l'ISR de contrôle et ne doivent rien coûter.
 */
#ifndef DBG_PIN_H
#define DBG_PIN_H

#include "board.h"

#ifdef __cplusplus
extern "C" {
#endif

void DbgPin_Init(void);

static inline void DbgPin_High(void) { PIN_DBG_PORT->BSRR = PIN_DBG; }
static inline void DbgPin_Low(void)  { PIN_DBG_PORT->BSRR = (uint32_t)PIN_DBG << 16U; }

#ifdef __cplusplus
}
#endif
#endif /* DBG_PIN_H */
