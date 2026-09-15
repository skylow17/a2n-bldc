/**
 * @file rx_router.h
 * @brief Demultiplexeur de reception : une trame binaire ou une ligne de console ?
 *
 * Les deux canaux partagent le meme lien (docs/protocol.md §1). La discrimination repose sur
 * une propriete de COBS : un flux binaire encode ne contient aucun 0x00 ailleurs qu'au
 * delimiteur, et une ligne de texte n'en contient pas du tout. On accumule donc les octets
 * jusqu'au premier terminateur, et c'est lui qui designe le canal :
 *
 *   0x00        -> ce qui precede est une trame COBS
 *   \r ou \n    -> ce qui precede est une ligne ASCII
 *
 * Aucune sequence d'echappement, aucun mode a memoriser : apres n'importe quel incident, la
 * resynchronisation se fait au terminateur suivant.
 */
#ifndef COMM_RX_ROUTER_H
#define COMM_RX_ROUTER_H

#include <stdint.h>

void RxRouter_Init(void);

/** A appeler dans la superloop. Consomme ce que la liaison a recu et aiguille. */
void RxRouter_Process(void);

/** Nombre de messages abandonnes parce qu'ils depassaient le tampon d'accumulation. */
uint32_t RxRouter_Overflows(void);

#endif /* COMM_RX_ROUTER_H */
