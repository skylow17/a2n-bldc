/**
 * @file selftest.h
 * @brief Verification du codec sur la cible, sur les vecteurs de reference partages.
 *
 * Pourquoi sur la cible plutot que sur la machine de developpement : il n'y a pas de
 * compilateur hote sur ce poste, mais surtout un test hote ne prouverait rien de ce qui
 * compte ici. Ce qu'on veut verifier, c'est le codec tel que le produit arm-none-eabi-gcc,
 * avec l'alignement, la taille des types et l'endianness du Cortex-M4 — pas une compilation
 * x86 du meme source.
 *
 * Les vecteurs viennent de docs/protocol-vectors.json, produit par une troisieme
 * implementation en Python et verifie par ailleurs cote TypeScript. Les trois doivent
 * s'accorder sur les memes octets.
 */
#ifndef COMM_SELFTEST_H
#define COMM_SELFTEST_H

#include <stdbool.h>
#include <stdint.h>

typedef struct
{
  uint16_t total;
  uint16_t failed;
  uint16_t crc16_failed;
  uint16_t cobs_encode_failed;
  uint16_t cobs_decode_failed;
  uint16_t frame_failed;
  bool     dict_hash_ok;
  uint32_t dict_hash;
} SelftestResult_t;

/** Execute tous les vecteurs. Ne touche a aucun peripherique : appelable a tout moment. */
void Selftest_Run(SelftestResult_t *out);

#endif /* COMM_SELFTEST_H */
