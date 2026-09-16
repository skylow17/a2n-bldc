/**
 * @file boot_flash.h
 * @brief Géométrie flash, métadonnées A/B et règles de validation du bootloader.
 *
 * Ce module porte les décisions qui peuvent briquer une carte : quel slot est actif, quelle
 * image est exécutable, quelle écriture est acceptable. Le matériel n'en est qu'une petite
 * partie — effacer une page, programmer un double-mot — et cette partie-là est isolée en fin
 * de fichier derrière `BootFlash_Erase()` / `BootFlash_Program()`.
 *
 * Tout le reste est pur, et testé hors cible (`tools/hosttest/`). Ce n'est pas un luxe :
 * l'erreur qui compte ici ne se voit pas à l'exécution, elle se voit une fois la carte morte
 * ou le rollback inopérant.
 *
 * Découpage — voir `../../AGENTS.md` §4 :
 * ```
 *   0x08000000  bootloader     32 ko   banque 1
 *   0x08008000  slot A (app)  224 ko   banque 1
 *   0x08040000  slot B (dl)   224 ko   banque 2
 *   0x08078000  nvm params     16 ko
 *   0x0807C000  metadata       16 ko
 * ```
 * Le bootloader s'exécute depuis la banque 1 ; écrire le slot B ne stalle donc pas ses
 * propres lectures. Écrire le slot A pendant qu'il tourne fonctionne aussi, parce que le
 * bootloader n'exécute jamais de code applicatif — mais un slot actif ne s'efface pas, et
 * c'est `BootFlash_CheckErase()` qui le refuse.
 */
#ifndef BOOT_FLASH_H
#define BOOT_FLASH_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "boot_shared.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ------------------------------------------------------------------ géométrie */

#define FLASH_BASE_ADDR        0x08000000UL
#define FLASH_TOTAL_SIZE       (512UL * 1024UL)
/* Préfixée : le HAL définit son propre `FLASH_PAGE_SIZE`, avec la même valeur. Reprendre
 * le nom marcherait aujourd'hui et casserait le jour où l'un des deux changerait, sans
 * que rien ne le signale ailleurs qu'en avertissement. */
#define BOOT_FLASH_PAGE_SIZE   2048UL

#define BOOT_SLOT_A_ADDR       0x08008000UL
#define BOOT_SLOT_B_ADDR       0x08040000UL
#define BOOT_SLOT_CAPACITY     (224UL * 1024UL)

#define BOOT_META_ADDR         0x0807C000UL
#define BOOT_META_SIZE         (16UL * 1024UL)

/** Les deux enregistrements alternés vivent chacun sur leur page. */
#define BOOT_META_PAGE_A       BOOT_META_ADDR
#define BOOT_META_PAGE_B       (BOOT_META_ADDR + BOOT_FLASH_PAGE_SIZE)

/** Identifiants de slot, tels qu'ils voyagent sur le fil (`../../../docs/protocol.md` §8). */
#define BOOT_SLOT_A            0U
#define BOOT_SLOT_B            1U
#define BOOT_SLOT_NONE         0xFFU

/** Largeur d'un champ de version, en octets, sur le fil comme en flash. */
#define BOOT_VERSION_LEN       16U

/** Taille d'une description de slot sur le fil. */
#define BOOT_WIRE_SLOT_LEN     36U
/** Taille de la réponse `BOOT_INFO`. */
#define BOOT_WIRE_INFO_LEN     94U

/* ------------------------------------------------------------------ métadonnées */

/**
 * @brief Ce que la flash retient d'un slot.
 *
 * `valid` n'est posé que par `BOOT_VERIFY`, après contrôle du CRC et des vecteurs. Une image
 * n'est jamais déclarée valide sur la seule foi de ce qu'on lit à son adresse.
 */
typedef struct {
  uint32_t image_size;
  uint32_t crc32;
  uint8_t  valid;
  uint8_t  reserved[3];
  char     version[BOOT_VERSION_LEN];
} BootSlotMeta_t;

/**
 * @brief L'enregistrement complet, tel qu'il est écrit en flash.
 *
 * 72 octets, multiple de 8 : le G4 ne programme qu'en double-mots. Le champ `generation`
 * départage les deux pages, `crc32` protège l'ensemble. Une coupure pendant l'écriture d'une
 * page laisse l'autre lisible — c'est toute la raison d'en avoir deux.
 */
typedef struct {
  uint32_t       magic;
  uint32_t       generation;
  uint8_t        active_slot;
  uint8_t        candidate_slot;
  uint8_t        candidate_attempted;
  uint8_t        reserved;
  BootSlotMeta_t slot[2];
  uint32_t       crc32;
} BootMeta_t;

#define BOOT_META_MAGIC        0xA2B00001UL
#define BOOT_META_RECORD_LEN   72U

/* ------------------------------------------------------------------ CRC */

/** CRC-32/ISO-HDLC, celui de zlib. Vecteur d'arbitrage : CRC32("123456789") == 0xCBF43926. */
uint32_t BootFlash_Crc32(const void *data, size_t len);

/* ------------------------------------------------------------------ logique pure */

/** Adresse de base d'un slot, ou 0 si `slot` n'en désigne aucun. */
uint32_t BootFlash_SlotAddr(uint8_t slot);

/**
 * @brief Sérialise un enregistrement vers ses 72 octets, CRC compris.
 *
 * Le CRC est calculé ici sur les 68 premiers octets : le sérialiseur est le seul endroit qui
 * connaisse la disposition exacte, et laisser l'appelant le calculer inviterait la divergence.
 */
void BootMeta_Encode(const BootMeta_t *meta, uint8_t *dst);

/**
 * @brief Relit un enregistrement. Faux si le magic ou le CRC ne collent pas.
 *
 * Une page vierge (`0xff` partout) échoue sur le magic, donc sans cas particulier.
 */
bool BootMeta_Decode(const uint8_t *src, BootMeta_t *out);

/**
 * @brief Choisit l'enregistrement courant entre les deux pages.
 *
 * La génération la plus haute gagne, l'arithmétique modulaire gérant le rebouclage. Si une
 * seule page est lisible, c'est elle ; si aucune ne l'est, faux — et l'appelant repartira
 * d'un état vierge.
 */
bool BootMeta_Pick(const BootMeta_t *a, bool a_ok, const BootMeta_t *b, bool b_ok,
                   BootMeta_t *out, bool *out_from_a);

/**
 * @brief Enregistrement d'une flash sans métadonnées lisibles.
 *
 * Slot A actif par défaut, mais **jamais** marqué valide : la validité vient d'un CRC vérifié,
 * pas d'une convention. Le bootloader sautera quand même sur A si ses vecteurs sont plausibles,
 * ce qui est le seul moyen de démarrer une carte fraîchement programmée par SWD.
 */
void BootMeta_Blank(BootMeta_t *out);

/**
 * @brief Les deux premiers mots d'une image ressemblent-ils à un vecteur Cortex-M ?
 *
 * Contrôle faible et assumé : le pointeur de pile doit tomber dans la SRAM, le point d'entrée
 * dans le slot et porter le bit Thumb. Ça écarte une flash vierge et une image écrite au
 * mauvais endroit, pas une image corrompue — c'est le rôle du CRC.
 */
bool BootFlash_VectorsPlausible(uint32_t initial_sp, uint32_t reset_pc, uint32_t slot_addr);

/**
 * @brief Décide si un slot peut être effacé. Rend 0 ou un `PROTO_ERR_*`.
 *
 * Refuse le slot actif : l'effacer rendrait la carte non démarrable dès que le candidat
 * échouerait, ce qui est exactement la situation que le rollback doit couvrir.
 */
uint8_t BootFlash_CheckErase(const BootMeta_t *meta, uint8_t slot);

/** État d'une session de mise à jour. Volatile : un reset annule tout. */
typedef struct {
  bool     erased[2];      /**< un `BOOT_ERASE` a réussi dans cette session */
  uint32_t written_max[2]; /**< offset+len le plus haut écrit, pour un contrôle de bon sens */
} BootSession_t;

/** Paramètres d'un `BOOT_WRITE`, déjà désérialisés. */
typedef struct {
  uint8_t  slot;
  uint16_t data_len;
  uint32_t offset;
} BootWriteReq_t;

/**
 * @brief Décide si une écriture est acceptable. Rend 0 ou un `PROTO_ERR_*`.
 *
 * Exige un effacement réussi dans la session courante. Sans cette règle, une écriture sur une
 * page déjà programmée échouerait silencieusement au niveau du bit — la flash ne sait que
 * passer un 1 à 0 — et produirait une image corrompue dont le CRC ne serait découvert qu'au
 * `BOOT_VERIFY`, ou pire, jamais.
 */
uint8_t BootFlash_CheckWrite(const BootMeta_t *meta, const BootSession_t *session,
                             const BootWriteReq_t *req);

/** Paramètres d'un `BOOT_VERIFY`, déjà désérialisés. */
typedef struct {
  uint8_t  slot;
  uint32_t image_size;
  uint32_t expected_crc32;
} BootVerifyReq_t;

/**
 * @brief Contrôles de `BOOT_VERIFY` qui ne demandent pas de lire la flash. Rend 0 ou `PROTO_ERR_*`.
 *
 * Le CRC et les vecteurs sont vérifiés ensuite par `BootFlash_Verify()`, qui a besoin du
 * contenu ; séparer les deux permet de tester ici tout ce qui est décidable sans matériel.
 */
uint8_t BootFlash_CheckVerify(const BootMeta_t *meta, const BootSession_t *session,
                              const BootVerifyReq_t *req);

/**
 * @brief Applique un `BOOT_VERIFY` réussi à l'enregistrement : le slot devient candidat.
 *
 * Ne touche pas au slot actif. C'est le reset suivant qui tente le candidat, et la
 * confirmation qui le promeut.
 */
void BootMeta_SetCandidate(BootMeta_t *meta, uint8_t slot, uint32_t image_size, uint32_t crc32,
                           const char *version);

/**
 * @brief Promeut le candidat au rang de slot actif, après confirmation.
 *
 * Faux s'il n'y a pas de candidat, ou s'il n'est pas valide — la confirmation seule ne rend
 * jamais exécutable une image qui n'a pas passé son CRC.
 */
bool BootMeta_PromoteCandidate(BootMeta_t *meta);

/**
 * @brief Annule le candidat en attente. Faux s'il n'y en a pas — `BOOT_ROLLBACK` répond
 *        alors `ERR_STATE`.
 *
 * Le slot reste valide en flash : seule sa candidature disparaît. Un rollback ne détruit rien,
 * il choisit.
 */
bool BootMeta_ClearCandidate(BootMeta_t *meta);

/**
 * @brief Quel slot démarrer, et faut-il le mettre en probation ?
 *
 * Le cœur de la séquence A/B. Un candidat déjà essayé et non confirmé est abandonné —
 * c'est le rollback automatique : l'essai a eu lieu, il n'a pas confirmé, on n'y revient pas.
 *
 * @param meta         enregistrement courant, modifié : le candidat est marqué essayé, ou effacé
 * @param[out] trial   vrai si le slot rendu est en probation (IWDG armé, confirmation attendue)
 * @param[out] changed vrai si `meta` doit être réécrit en flash avant le saut
 * @return             slot à démarrer, ou `BOOT_SLOT_NONE`
 */
uint8_t BootFlash_SelectBoot(BootMeta_t *meta, bool *trial, bool *changed);

/** Sérialise la réponse `BOOT_INFO` (94 octets). */
void BootFlash_EncodeInfo(const BootMeta_t *meta, const char *bl_version, uint8_t *dst);

/* ------------------------------------------------------------------ matériel */

#ifndef BOOT_FLASH_HOSTTEST

/** Charge les métadonnées au démarrage. Repart d'un état vierge si les deux pages sont illisibles. */
void BootFlash_Init(void);

/** Enregistrement courant. */
const BootMeta_t *BootFlash_Meta(void);

/**
 * @brief Réécrit les métadonnées sur la page inutilisée, génération incrémentée.
 *
 * L'alternance est ce qui rend le changement atomique : l'ancienne page reste intacte jusqu'à
 * ce que la nouvelle soit complète et son CRC juste.
 */
bool BootFlash_CommitMeta(const BootMeta_t *meta);

/** Efface les pages d'un slot. Ne contrôle rien : voir `BootFlash_CheckErase()`. */
bool BootFlash_Erase(uint8_t slot);

/** Programme `len` octets (multiple de 8) à `offset` dans `slot`. */
bool BootFlash_Program(uint8_t slot, uint32_t offset, const uint8_t *data, uint16_t len);

/** Relit le slot et contrôle CRC et vecteurs. */
bool BootFlash_Verify(uint8_t slot, uint32_t image_size, uint32_t expected_crc32);

#endif /* BOOT_FLASH_HOSTTEST */

#ifdef __cplusplus
}
#endif
#endif /* BOOT_FLASH_H */
