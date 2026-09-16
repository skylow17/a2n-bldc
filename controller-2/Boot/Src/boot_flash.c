/**
 * @file boot_flash.c
 * @brief Métadonnées A/B, règles de validation, et le peu de flash qu'il faut toucher.
 *
 * L'ordre du fichier suit l'ordre de confiance : d'abord ce qui est pur et testé hors cible,
 * ensuite seulement ce qui parle au contrôleur de flash. `BOOT_FLASH_HOSTTEST` coupe la
 * seconde moitié — elle a besoin du HAL, la première n'a besoin de rien.
 */

#include "boot_flash.h"

#include <string.h>

#include "comm/frame.h"
#include "comm/proto.h"

/* ------------------------------------------------------------------ CRC-32 */

/* Même implémentation que `Core/Src/comm/param.c`, et volontairement recopiée : le
 * bootloader ne lie pas le module de paramètres, et une dépendance ajoutée pour vingt lignes
 * ferait entrer tout le dictionnaire dans une image de 32 ko. Calcul bit à bit, sans table :
 * il tourne sur 224 ko une fois par vérification, ce qui reste sous la dizaine de
 * millisecondes. */
uint32_t BootFlash_Crc32(const void *data, size_t len)
{
  const uint8_t *p = (const uint8_t *)data;
  uint32_t crc = 0xFFFFFFFFU;

  for (size_t i = 0U; i < len; i++) {
    crc ^= p[i];
    for (uint8_t b = 0U; b < 8U; b++) {
      const uint32_t mask = (uint32_t)-(int32_t)(crc & 1U);
      crc = (crc >> 1) ^ (0xEDB88320U & mask);
    }
  }
  return crc ^ 0xFFFFFFFFU;
}

/* ------------------------------------------------------------------ géométrie */

uint32_t BootFlash_SlotAddr(uint8_t slot)
{
  if (slot == BOOT_SLOT_A) {
    return BOOT_SLOT_A_ADDR;
  }
  if (slot == BOOT_SLOT_B) {
    return BOOT_SLOT_B_ADDR;
  }
  return 0U;
}

/** Vrai si `slot` désigne bien A ou B. `BOOT_SLOT_NONE` n'est pas un slot. */
static bool SlotValid(uint8_t slot)
{
  return (slot == BOOT_SLOT_A) || (slot == BOOT_SLOT_B);
}

/* ------------------------------------------------------------------ sérialisation */

/* Copie une chaîne dans un champ de largeur fixe, complété par des zéros. Une chaîne qui
 * remplit exactement le champ n'est pas terminée : le lecteur traite le champ comme borné. */
static void PutFixedString(char *dst, size_t width, const char *src)
{
  (void)memset(dst, 0, width);
  if (src == NULL) {
    return;
  }
  const size_t n = strlen(src);
  (void)memcpy(dst, src, (n < width) ? n : width);
}

/** Écrit les 68 octets utiles d'un enregistrement. Le CRC vient après, et le lit. */
static size_t EncodeBody(const BootMeta_t *meta, uint8_t *dst)
{
  size_t o = 0U;

  Frame_PutU32(&dst[o], meta->magic);       o += 4U;
  Frame_PutU32(&dst[o], meta->generation);  o += 4U;
  dst[o++] = meta->active_slot;
  dst[o++] = meta->candidate_slot;
  dst[o++] = meta->candidate_attempted;
  dst[o++] = 0U;

  for (uint8_t s = 0U; s < 2U; s++) {
    const BootSlotMeta_t *m = &meta->slot[s];
    Frame_PutU32(&dst[o], m->image_size);  o += 4U;
    Frame_PutU32(&dst[o], m->crc32);       o += 4U;
    dst[o++] = m->valid;
    dst[o++] = 0U;
    dst[o++] = 0U;
    dst[o++] = 0U;
    (void)memcpy(&dst[o], m->version, BOOT_VERSION_LEN);
    o += BOOT_VERSION_LEN;
  }
  return o;
}

void BootMeta_Encode(const BootMeta_t *meta, uint8_t *dst)
{
  const size_t body = EncodeBody(meta, dst);
  Frame_PutU32(&dst[body], BootFlash_Crc32(dst, body));
}

bool BootMeta_Decode(const uint8_t *src, BootMeta_t *out)
{
  if ((src == NULL) || (out == NULL)) {
    return false;
  }
  if (Frame_GetU32(&src[0]) != BOOT_META_MAGIC) {
    return false;
  }

  const size_t body = BOOT_META_RECORD_LEN - 4U;
  if (Frame_GetU32(&src[body]) != BootFlash_Crc32(src, body)) {
    return false;
  }

  size_t o = 0U;
  out->magic = Frame_GetU32(&src[o]);       o += 4U;
  out->generation = Frame_GetU32(&src[o]);  o += 4U;
  out->active_slot = src[o++];
  out->candidate_slot = src[o++];
  out->candidate_attempted = src[o++];
  out->reserved = 0U;
  o++;

  for (uint8_t s = 0U; s < 2U; s++) {
    BootSlotMeta_t *m = &out->slot[s];
    m->image_size = Frame_GetU32(&src[o]);  o += 4U;
    m->crc32 = Frame_GetU32(&src[o]);       o += 4U;
    m->valid = src[o++];
    m->reserved[0] = 0U;
    m->reserved[1] = 0U;
    m->reserved[2] = 0U;
    o += 3U;
    (void)memcpy(m->version, &src[o], BOOT_VERSION_LEN);
    o += BOOT_VERSION_LEN;
  }
  out->crc32 = Frame_GetU32(&src[o]);

  /* Un enregistrement dont les champs de slot sont hors géométrie a un CRC juste mais un
   * contenu impossible : plutôt qu'un fallback silencieux, on le rejette et la carte repart
   * sur l'autre page, ou sur un état vierge. */
  if ((out->slot[0].image_size > BOOT_SLOT_CAPACITY) ||
      (out->slot[1].image_size > BOOT_SLOT_CAPACITY)) {
    return false;
  }
  if ((out->active_slot != BOOT_SLOT_NONE) && !SlotValid(out->active_slot)) {
    return false;
  }
  if ((out->candidate_slot != BOOT_SLOT_NONE) && !SlotValid(out->candidate_slot)) {
    return false;
  }
  return true;
}

bool BootMeta_Pick(const BootMeta_t *a, bool a_ok, const BootMeta_t *b, bool b_ok,
                   BootMeta_t *out, bool *out_from_a)
{
  if (a_ok && b_ok) {
    /* Différence signée : la génération finira par reboucler, et `a->g > b->g` déciderait
     * alors à l'envers. Une carte flashée des dizaines de fois par jour mettrait des siècles
     * à y arriver, mais le coût de le faire juste est d'un cast. */
    const bool a_newer = ((int32_t)(a->generation - b->generation) > 0);
    *out = a_newer ? *a : *b;
    *out_from_a = a_newer;
    return true;
  }
  if (a_ok) {
    *out = *a;
    *out_from_a = true;
    return true;
  }
  if (b_ok) {
    *out = *b;
    *out_from_a = false;
    return true;
  }
  return false;
}

void BootMeta_Blank(BootMeta_t *out)
{
  (void)memset(out, 0, sizeof(*out));
  out->magic = BOOT_META_MAGIC;
  out->generation = 1U;
  out->active_slot = BOOT_SLOT_A;
  out->candidate_slot = BOOT_SLOT_NONE;
  /* `valid` reste à zéro pour les deux slots : rien n'a été vérifié. */
}

/* ------------------------------------------------------------------ validation */

bool BootFlash_VectorsPlausible(uint32_t initial_sp, uint32_t reset_pc, uint32_t slot_addr)
{
  /* Le pointeur de pile initial pointe la fin de la pile, donc le haut de la SRAM. On accepte
   * la borne supérieure : `_estack` vaut exactement `ORIGIN + LENGTH`, adresse valide comme
   * pile descendante. */
  if ((initial_sp < 0x20000000UL) || (initial_sp > 0x20020000UL)) {
    return false;
  }
  if ((initial_sp & 0x7U) != 0U) {
    return false;
  }
  /* Bit 0 à 1 : le Cortex-M n'exécute que du Thumb, et un vecteur de reset pair provoque une
   * UsageFault immédiate — c'est la panne la plus opaque qu'un bootloader puisse produire. */
  if ((reset_pc & 1U) == 0U) {
    return false;
  }
  const uint32_t pc = reset_pc & ~1U;
  if ((pc < slot_addr) || (pc >= (slot_addr + BOOT_SLOT_CAPACITY))) {
    return false;
  }
  return true;
}

/* Les codes d'erreur ci-dessous suivent `interface/src/shared/simulator.ts`, et le tableau de
 * `../../../docs/protocol.md` §8 fige maintenant la correspondance. La spécification ne les
 * fixait pas ; la conséquence aurait été un `boot-check` vert sur simulateur et rouge sur
 * carte, pour un firmware par ailleurs juste. C'est le genre d'écart qui coûte une séance de
 * débogage entière parce qu'on cherche la panne du mauvais côté.
 *
 * `ERR_LEN` couvre donc tout ce qui rend la demande mal formée — longueur, alignement — et
 * `ERR_STATE` tout ce que l'état de la carte refuse : slot inexistant, slot actif, slot non
 * effacé, dépassement de capacité. */

uint8_t BootFlash_CheckErase(const BootMeta_t *meta, uint8_t slot)
{
  if (!SlotValid(slot) || (slot == meta->active_slot)) {
    return PROTO_ERR_STATE;
  }
  return 0U;
}

uint8_t BootFlash_CheckWrite(const BootMeta_t *meta, const BootSession_t *session,
                             const BootWriteReq_t *req)
{
  /* Bornes de `data_len` fixées par la spec : 8..504, multiple de 8. 504 est ce qui reste
   * d'un payload de 512 une fois l'en-tête de huit octets retiré. L'alignement de l'offset
   * est du même ordre : une demande mal formée, pas un état refusé. */
  if ((req->data_len < 8U) || (req->data_len > 504U) || ((req->data_len % 8U) != 0U) ||
      ((req->offset % 8U) != 0U)) {
    return PROTO_ERR_LEN;
  }
  if (!SlotValid(req->slot) || (req->slot == meta->active_slot)) {
    return PROTO_ERR_STATE;
  }
  /* Somme calculée en 64 bits : `offset + data_len` déborderait sur un offset proche de
   * 2^32, et le contrôle passerait alors qu'il devrait refuser. */
  if (((uint64_t)req->offset + (uint64_t)req->data_len) > (uint64_t)BOOT_SLOT_CAPACITY) {
    return PROTO_ERR_STATE;
  }
  if (!session->erased[req->slot]) {
    return PROTO_ERR_STATE;
  }
  return 0U;
}

uint8_t BootFlash_CheckVerify(const BootMeta_t *meta, const BootSession_t *session,
                              const BootVerifyReq_t *req)
{
  if (!SlotValid(req->slot) || (req->slot == meta->active_slot)) {
    return PROTO_ERR_STATE;
  }
  /* Une image doit au minimum porter son vecteur initial. */
  if ((req->image_size < 8U) || (req->image_size > BOOT_SLOT_CAPACITY)) {
    return PROTO_ERR_STATE;
  }
  if (!session->erased[req->slot]) {
    return PROTO_ERR_STATE;
  }
  /* Vérifier au-delà de ce qui a été écrit relirait de la flash vierge et produirait un CRC
   * faux sans qu'on sache dire pourquoi. Le dire explicitement vaut mieux. */
  if (req->image_size > session->written_max[req->slot]) {
    return PROTO_ERR_STATE;
  }
  return 0U;
}

void BootMeta_SetCandidate(BootMeta_t *meta, uint8_t slot, uint32_t image_size, uint32_t crc32,
                           const char *version)
{
  BootSlotMeta_t *m = &meta->slot[slot];
  m->image_size = image_size;
  m->crc32 = crc32;
  m->valid = 1U;
  PutFixedString(m->version, BOOT_VERSION_LEN, version);

  meta->candidate_slot = slot;
  meta->candidate_attempted = 0U;
}

bool BootMeta_PromoteCandidate(BootMeta_t *meta)
{
  const uint8_t c = meta->candidate_slot;
  if (!SlotValid(c)) {
    return false;
  }
  if (meta->slot[c].valid == 0U) {
    return false;
  }
  meta->active_slot = c;
  meta->candidate_slot = BOOT_SLOT_NONE;
  meta->candidate_attempted = 0U;
  return true;
}

bool BootMeta_ClearCandidate(BootMeta_t *meta)
{
  if (!SlotValid(meta->candidate_slot)) {
    return false;
  }
  meta->candidate_slot = BOOT_SLOT_NONE;
  meta->candidate_attempted = 0U;
  return true;
}

uint8_t BootFlash_SelectBoot(BootMeta_t *meta, bool *trial, bool *changed)
{
  *trial = false;
  *changed = false;

  const uint8_t c = meta->candidate_slot;
  if (SlotValid(c) && (meta->slot[c].valid != 0U)) {
    if (meta->candidate_attempted == 0U) {
      /* Premier essai : on marque *avant* de sauter. Si le candidat plante au point de ne
       * jamais rendre la main, le reset suivant retrouve la marque et abandonne. Marquer
       * après le saut n'arriverait jamais, et la carte rebouclerait indéfiniment sur une
       * image morte — c'est le seul ordre qui rende le rollback automatique. */
      meta->candidate_attempted = 1U;
      *changed = true;
      *trial = true;
      return c;
    }
    /* Deuxième passage sans confirmation entre-temps : l'essai a échoué. */
    meta->candidate_slot = BOOT_SLOT_NONE;
    meta->candidate_attempted = 0U;
    *changed = true;
  } else if (SlotValid(c)) {
    /* Candidat désigné mais invalide : ne devrait pas exister, et ne mérite pas de subsister. */
    meta->candidate_slot = BOOT_SLOT_NONE;
    meta->candidate_attempted = 0U;
    *changed = true;
  } else {
    /* rien en attente */
  }

  return SlotValid(meta->active_slot) ? meta->active_slot : BOOT_SLOT_NONE;
}

void BootFlash_EncodeInfo(const BootMeta_t *meta, const char *bl_version, uint8_t *dst)
{
  size_t o = 0U;

  Frame_PutU16(&dst[o], 0x0200U);  o += 2U;
  PutFixedString((char *)&dst[o], BOOT_VERSION_LEN, bl_version);
  o += BOOT_VERSION_LEN;
  dst[o++] = meta->active_slot;
  dst[o++] = meta->candidate_slot;
  dst[o++] = meta->candidate_attempted;
  dst[o++] = 0U;

  for (uint8_t s = 0U; s < 2U; s++) {
    const BootSlotMeta_t *m = &meta->slot[s];
    Frame_PutU32(&dst[o], (s == 0U) ? BOOT_SLOT_A_ADDR : BOOT_SLOT_B_ADDR);  o += 4U;
    Frame_PutU32(&dst[o], BOOT_SLOT_CAPACITY);                               o += 4U;
    Frame_PutU32(&dst[o], m->image_size);                                    o += 4U;
    Frame_PutU32(&dst[o], m->crc32);                                         o += 4U;
    dst[o++] = m->valid;
    dst[o++] = 0U;
    dst[o++] = 0U;
    dst[o++] = 0U;
    (void)memcpy(&dst[o], m->version, BOOT_VERSION_LEN);
    o += BOOT_VERSION_LEN;
  }
}

/* ------------------------------------------------------------------ matériel */

#ifndef BOOT_FLASH_HOSTTEST

#include "stm32g4xx_hal.h"

static BootMeta_t s_meta;
static bool       s_meta_from_a;

const BootMeta_t *BootFlash_Meta(void)
{
  return &s_meta;
}

void BootFlash_Init(void)
{
  BootMeta_t a;
  BootMeta_t b;
  const bool a_ok = BootMeta_Decode((const uint8_t *)BOOT_META_PAGE_A, &a);
  const bool b_ok = BootMeta_Decode((const uint8_t *)BOOT_META_PAGE_B, &b);

  if (!BootMeta_Pick(&a, a_ok, &b, b_ok, &s_meta, &s_meta_from_a)) {
    BootMeta_Blank(&s_meta);
    /* Aucune page lisible : la prochaine écriture ira sur la page A. */
    s_meta_from_a = false;
  }
}

/** Numéro de page d'une adresse flash, et sa banque. Le G4 numérote par banque. */
static void PageOf(uint32_t addr, uint32_t *bank, uint32_t *page)
{
  const uint32_t off = addr - FLASH_BASE_ADDR;
  if (off < (FLASH_TOTAL_SIZE / 2U)) {
    *bank = FLASH_BANK_1;
    *page = off / FLASH_PAGE_SIZE;
  } else {
    *bank = FLASH_BANK_2;
    *page = (off - (FLASH_TOTAL_SIZE / 2U)) / FLASH_PAGE_SIZE;
  }
}

static bool ErasePages(uint32_t addr, uint32_t bytes)
{
  FLASH_EraseInitTypeDef e = {0};
  uint32_t bank;
  uint32_t page;
  uint32_t error = 0U;

  PageOf(addr, &bank, &page);
  e.TypeErase = FLASH_TYPEERASE_PAGES;
  e.Banks = bank;
  e.Page = page;
  e.NbPages = bytes / FLASH_PAGE_SIZE;

  if (HAL_FLASH_Unlock() != HAL_OK) {
    return false;
  }
  const HAL_StatusTypeDef st = HAL_FLASHEx_Erase(&e, &error);
  (void)HAL_FLASH_Lock();
  return (st == HAL_OK) && (error == 0xFFFFFFFFU);
}

/** Programme des double-mots. `len` est un multiple de 8, garanti par les contrôles amont. */
static bool ProgramAt(uint32_t addr, const uint8_t *data, uint32_t len)
{
  if (HAL_FLASH_Unlock() != HAL_OK) {
    return false;
  }
  bool ok = true;
  for (uint32_t i = 0U; (i < len) && ok; i += 8U) {
    /* Recomposé octet par octet : le tampon de réception n'est aligné que sur un octet, et
     * un `uint64_t` lu depuis une adresse impaire est un comportement indéfini. */
    uint64_t dw = 0U;
    for (uint8_t b = 0U; b < 8U; b++) {
      dw |= (uint64_t)data[i + b] << (8U * b);
    }
    ok = (HAL_FLASH_Program(FLASH_TYPEPROGRAM_DOUBLEWORD, addr + i, dw) == HAL_OK);
  }
  (void)HAL_FLASH_Lock();
  return ok;
}

bool BootFlash_CommitMeta(const BootMeta_t *meta)
{
  /* On écrit sur la page que l'on n'a *pas* lue : l'ancienne reste intacte jusqu'à ce que la
   * nouvelle soit complète et son CRC juste. C'est là toute l'atomicité. */
  const uint32_t target = s_meta_from_a ? BOOT_META_PAGE_B : BOOT_META_PAGE_A;

  BootMeta_t next = *meta;
  next.magic = BOOT_META_MAGIC;
  next.generation = meta->generation + 1U;

  uint8_t raw[BOOT_META_RECORD_LEN];
  BootMeta_Encode(&next, raw);

  if (!ErasePages(target, FLASH_PAGE_SIZE)) {
    return false;
  }
  if (!ProgramAt(target, raw, sizeof(raw))) {
    return false;
  }

  s_meta = next;
  s_meta_from_a = (target == BOOT_META_PAGE_A);
  return true;
}

bool BootFlash_Erase(uint8_t slot)
{
  const uint32_t addr = BootFlash_SlotAddr(slot);
  return (addr != 0U) && ErasePages(addr, BOOT_SLOT_CAPACITY);
}

bool BootFlash_Program(uint8_t slot, uint32_t offset, const uint8_t *data, uint16_t len)
{
  const uint32_t addr = BootFlash_SlotAddr(slot);
  return (addr != 0U) && ProgramAt(addr + offset, data, len);
}

bool BootFlash_Verify(uint8_t slot, uint32_t image_size, uint32_t expected_crc32)
{
  const uint32_t addr = BootFlash_SlotAddr(slot);
  if (addr == 0U) {
    return false;
  }
  const uint8_t *img = (const uint8_t *)addr;

  if (!BootFlash_VectorsPlausible(Frame_GetU32(&img[0]), Frame_GetU32(&img[4]), addr)) {
    return false;
  }
  return BootFlash_Crc32(img, image_size) == expected_crc32;
}

#endif /* BOOT_FLASH_HOSTTEST */
