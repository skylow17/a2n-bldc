/**
 * @file crc16.h
 * @brief CRC-16/CCITT-FALSE — polynome 0x1021, init 0xFFFF, sans reflexion, xorout 0x0000.
 *
 * C'est la variante retenue par docs/protocol.md §2. Attention au nom : plusieurs CRC-16
 * differents circulent sous l'etiquette "CCITT", avec des init et des reflexions distinctes.
 * Le seul arbitre est le vecteur de reference : CRC16("123456789") == 0x29B1.
 */
#ifndef COMM_CRC16_H
#define COMM_CRC16_H

#include <stddef.h>
#include <stdint.h>

#define CRC16_INIT  0xFFFFU

/** CRC d'un bloc complet. */
uint16_t Crc16(const void *data, size_t len);

/** Variante incrementale, pour cumuler sur plusieurs blocs non contigus. */
uint16_t Crc16Update(uint16_t crc, const void *data, size_t len);

#endif /* COMM_CRC16_H */
