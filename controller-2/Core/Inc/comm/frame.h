/**
 * @file frame.h
 * @brief Trame binaire du protocole v2 — docs/protocol.md §2.
 *
 *   +--------+-------+-----+---------------+--------+
 *   | msg_id | flags | seq | payload       | crc16  |
 *   | u16 LE |  u8   | u8  | 0..512 octets | u16 LE |
 *   +--------+-------+-----+---------------+--------+
 *
 * Le tout est encode en COBS puis suivi d'un 0x00 delimiteur. Le CRC couvre msg_id jusqu'a la
 * fin du payload, avant encodage.
 *
 * Les entiers sont little-endian, ce qui est l'ordre natif du Cortex-M4 comme celui du PC :
 * aucune conversion des deux cotes. On serialise malgre tout octet par octet plutot que par
 * memcpy d'une struct, pour ne dependre ni du padding ni de l'alignement choisi par le
 * compilateur — la trame est un format de fichier, pas une image memoire.
 */
#ifndef COMM_FRAME_H
#define COMM_FRAME_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "comm/cobs.h"

#define FRAME_PAYLOAD_MAX   512U
#define FRAME_HEADER_LEN    4U                     /* msg_id, flags, seq */
#define FRAME_CRC_LEN       2U
#define FRAME_RAW_MAX       (FRAME_HEADER_LEN + FRAME_PAYLOAD_MAX + FRAME_CRC_LEN)
#define FRAME_RAW_MIN       (FRAME_HEADER_LEN + FRAME_CRC_LEN)

/** Taille du tampon d'emission : trame encodee + delimiteur, plus un octet de marge que
 *  l'encodeur COBS peut ecrire sans le compter (cas du groupe plein en fin de donnees). */
#define FRAME_ENCODED_MAX   (COBS_MAX_ENCODED(FRAME_RAW_MAX) + 2U)

/* Bits de `flags` — docs/protocol.md §2. */
#define FRAME_FLAG_RESPONSE  0x01U
#define FRAME_FLAG_ERROR     0x02U
#define FRAME_FLAG_PUSH      0x04U
#define FRAME_FLAG_MORE      0x08U

typedef struct
{
  uint16_t       msg_id;
  uint8_t        flags;
  uint8_t        seq;
  const uint8_t *payload;      /* pointe dans le tampon de decodage de l'appelant */
  uint16_t       payload_len;
} Frame_t;

/** Diagnostic de decodage. Distinguer les causes sert au compteur d'erreurs de liaison :
 *  un CRC faux accuse le cable, une longueur fausse accuse l'emetteur. */
typedef enum
{
  FRAME_OK = 0,
  FRAME_ERR_COBS,      /* encodage invalide, ou tampon de sortie trop petit */
  FRAME_ERR_LEN,       /* trop courte pour un entete + CRC, ou payload hors limite */
  FRAME_ERR_CRC,
} FrameStatus_t;

/**
 * Serialise et encode une trame complete, delimiteur 0x00 compris : le resultat part tel quel
 * sur la liaison.
 *
 * @param dst     au moins FRAME_ENCODED_MAX octets
 * @return longueur ecrite, ou 0 si le payload depasse FRAME_PAYLOAD_MAX ou dst est trop petit.
 */
size_t Frame_Encode(uint16_t msg_id, uint8_t flags, uint8_t seq,
                    const void *payload, uint16_t payload_len,
                    uint8_t *dst, size_t dst_cap);

/**
 * Decode une trame recue, delimiteur exclu, et verifie son CRC.
 *
 * @param scratch tampon de travail d'au moins FRAME_RAW_MAX octets ; `out->payload` y pointe
 *                apres l'appel et reste valide tant que l'appelant ne le reutilise pas.
 */
FrameStatus_t Frame_Decode(const uint8_t *src, size_t len,
                           uint8_t *scratch, size_t scratch_cap,
                           Frame_t *out);

/* Acces little-endian aux payloads. Ecriture et lecture non alignees, sans hypothese sur
 * l'alignement du tampon : un payload peut commencer a n'importe quel offset. */
static inline uint16_t Frame_GetU16(const uint8_t *p)
{
  return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static inline uint32_t Frame_GetU32(const uint8_t *p)
{
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static inline void Frame_PutU16(uint8_t *p, uint16_t v)
{
  p[0] = (uint8_t)(v & 0xFFU);
  p[1] = (uint8_t)(v >> 8);
}

static inline void Frame_PutU32(uint8_t *p, uint32_t v)
{
  p[0] = (uint8_t)(v & 0xFFU);
  p[1] = (uint8_t)((v >> 8) & 0xFFU);
  p[2] = (uint8_t)((v >> 16) & 0xFFU);
  p[3] = (uint8_t)((v >> 24) & 0xFFU);
}

/* f32 : on passe par un u32 plutot que par un cast de pointeur, qui violerait l'aliasing
 * strict et que GCC est en droit d'optimiser de travers a -O2. */
static inline float Frame_GetF32(const uint8_t *p)
{
  union { uint32_t u; float f; } c;
  c.u = Frame_GetU32(p);
  return c.f;
}

static inline void Frame_PutF32(uint8_t *p, float v)
{
  union { uint32_t u; float f; } c;
  c.f = v;
  Frame_PutU32(p, c.u);
}

#endif /* COMM_FRAME_H */
