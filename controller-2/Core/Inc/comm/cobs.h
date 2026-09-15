/**
 * @file cobs.h
 * @brief COBS — Consistent Overhead Byte Stuffing (Cheshire & Baker, 1999).
 *
 * L'encodage retire tous les 0x00 du corps de la trame, ce qui libere cet octet comme
 * delimiteur sans ambiguite. Interet ici : c'est ce qui permet de faire cohabiter le canal
 * binaire et la console ASCII sur le meme lien (docs/protocol.md §1). Un flux binaire encode
 * ne contient jamais de 0x00 ailleurs qu'au delimiteur, et une ligne ASCII n'en contient pas
 * du tout — le premier terminateur rencontre suffit donc a router la trame.
 *
 * Deuxieme propriete, decisive apres une coupure de cable ou un reset : la resynchronisation
 * est immediate. On jette tout jusqu'au prochain 0x00 et on repart, sans etat a reconstruire.
 *
 * Le surcout est de 1 octet, plus 1 par tranche de 254 octets sans zero — d'ou COBS_MAX_ENCODED.
 */
#ifndef COMM_COBS_H
#define COMM_COBS_H

#include <stddef.h>
#include <stdint.h>

/** Taille encodee maximale pour `n` octets bruts, delimiteur non compris. */
#define COBS_MAX_ENCODED(n)  ((n) + ((n) / 254U) + 1U)

/**
 * Encode `len` octets. N'ecrit pas le delimiteur final : c'est l'appelant qui l'ajoute,
 * parce que la couche liaison peut vouloir grouper plusieurs trames en une ecriture.
 *
 * @param dst     destination, au moins COBS_MAX_ENCODED(len) octets
 * @param dst_cap capacite de `dst`
 * @return nombre d'octets ecrits, ou 0 si la capacite est insuffisante.
 */
size_t Cobs_Encode(const uint8_t *src, size_t len, uint8_t *dst, size_t dst_cap);

/**
 * Decode une trame, delimiteur exclu (`src` ne doit contenir aucun 0x00).
 *
 * @return nombre d'octets ecrits, ou 0 si l'entree est malformee ou la capacite insuffisante.
 *         Une entree vide rend 0 : une trame vide n'existe pas dans ce protocole.
 */
size_t Cobs_Decode(const uint8_t *src, size_t len, uint8_t *dst, size_t dst_cap);

#endif /* COMM_COBS_H */
