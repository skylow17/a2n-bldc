/**
 * @file cobs.c
 * @brief Implementation COBS. Voir comm/cobs.h pour le pourquoi.
 *
 * L'encodage suit la forme canonique de l'article d'origine, y compris sur le cas limite du
 * groupe plein qui tombe exactement en fin de donnees : aucun octet de code supplementaire
 * n'est emis. Ce detail n'a aucune importance pour le decodeur — les deux formes se decodent
 * identiquement — mais il en a une pour nous : les deux implementations, C et TypeScript,
 * doivent produire exactement les memes octets, sinon les vecteurs de test partages divergent
 * sur ce seul cas et la panne se revele le jour ou une trame fait pile 254 octets sans zero.
 */
#include "comm/cobs.h"

size_t Cobs_Encode(const uint8_t *src, size_t len, uint8_t *dst, size_t dst_cap)
{
  if ((src == NULL) || (dst == NULL)) {
    return 0U;
  }
  if (dst_cap < COBS_MAX_ENCODED(len)) {
    return 0U;
  }

  size_t  out      = 1U;   /* la place du premier octet de code est reservee d'emblee */
  size_t  code_pos = 0U;   /* ou ecrire le code du groupe en cours */
  uint8_t code     = 1U;   /* nombre d'octets du groupe, octet de code compris */

  for (size_t i = 0U; i < len; i++) {
    if (src[i] != 0U) {
      dst[out++] = src[i];
      code++;
    }

    /* Un groupe se ferme sur un zero — que le code remplace — ou parce qu'il est plein. */
    if ((src[i] == 0U) || (code == 0xFFU)) {
      dst[code_pos] = code;
      code     = 1U;
      code_pos = out;

      /* On ne reserve un octet de code pour le groupe suivant que s'il portera quelque
       * chose : soit le zero qu'on vient de consommer avait un successeur, soit il reste
       * des donnees. Sinon le code final ecrit ci-dessous tombe hors de la longueur
       * rendue, et c'est exactement ce qu'on veut. */
      if ((src[i] == 0U) || ((i + 1U) < len)) {
        out++;
      }
    }
  }

  dst[code_pos] = code;
  return out;
}

size_t Cobs_Decode(const uint8_t *src, size_t len, uint8_t *dst, size_t dst_cap)
{
  if ((src == NULL) || (dst == NULL) || (len == 0U)) {
    return 0U;
  }

  size_t in  = 0U;
  size_t out = 0U;

  while (in < len) {
    const uint8_t code = src[in];

    /* Un code nul est impossible dans un flux COBS valide : 0x00 est le delimiteur, il ne
     * doit jamais parvenir jusqu'ici. Le rencontrer signale un flux corrompu. */
    if (code == 0U) {
      return 0U;
    }
    /* Le groupe annonce code-1 octets litteraux : ils doivent tenir dans l'entree. */
    if ((in + (size_t)code) > len) {
      return 0U;
    }
    in++;

    for (uint8_t k = 1U; k < code; k++) {
      if (out >= dst_cap) {
        return 0U;
      }
      dst[out++] = src[in++];
    }

    /* Zero implicite en fin de groupe, sauf si le groupe etait plein (0xFF, aucun zero a
     * restituer) et sauf en toute fin d'entree, ou il n'y a plus rien a separer. */
    if ((code != 0xFFU) && (in < len)) {
      if (out >= dst_cap) {
        return 0U;
      }
      dst[out++] = 0U;
    }
  }

  return out;
}
