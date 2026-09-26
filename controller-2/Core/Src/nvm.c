/**
 * @file nvm.c
 * @brief Persistance du dictionnaire de paramètres — voir `nvm.h` pour le pourquoi.
 */
#include "nvm.h"

#include <string.h>

#include "stm32g4xx_hal.h"

#include "comm/param.h"
#include "pwm.h"

/* ------------------------------------------------------------------ géométrie */

/* Début de la zone `nvm params` (`AGENTS.md` §4), juste après le slot B et avant les
 * métadonnées du bootloader. En banque 2, pages 112 et 113 en mode double banque. */
#define NVM_BASE          0x08078000UL
#define NVM_PAGE_SIZE     2048UL
#define NVM_BANK2_BASE    0x08040000UL
#define NVM_PAGE_A        NVM_BASE
#define NVM_PAGE_B        (NVM_BASE + NVM_PAGE_SIZE)

#define NVM_MAGIC         0xA2B00201UL
#define NVM_HDR_LEN       12U
#define NVM_ENTRY_LEN     8U
#define NVM_CRC_LEN       4U
#define NVM_MAX_ENTRIES   ((NVM_PAGE_SIZE - NVM_HDR_LEN - NVM_CRC_LEN) / NVM_ENTRY_LEN)   /* 254 */

static uint8_t      s_buf[NVM_PAGE_SIZE];   /* un enregistrement, en lecture comme en écriture */
static Nvm_Status_t s_st;

/* Lecture de flash sous garde ECC : voir `Nvm_OnNmi`. */
static volatile bool s_in_read;
static volatile bool s_ecc_hit;

/* ------------------------------------------------------------------ petit-boutiste */

static void PutU16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static void PutU32(uint8_t *p, uint32_t v)
{
  p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}
static uint16_t GetU16(const uint8_t *p) { return (uint16_t)(p[0] | ((uint16_t)p[1] << 8)); }
static uint32_t GetU32(const uint8_t *p)
{
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/* ------------------------------------------------------------------ lecture */

/*
 * Garde ECC.
 *
 * Une coupure pendant la programmation d'un double-mot le laisse avec un ECC incohérent, et
 * sa lecture lève une erreur double que le G4 transforme en NMI. Le gestionnaire par défaut
 * boucle à l'infini : un enregistrement déchiré aurait figé la carte **à chaque démarrage**,
 * sans autre issue qu'une sonde. Pendant une lecture de la zone, cette NMI-là est donc
 * acquittée et notée ; la lecture continue avec une valeur fausse, que le CRC refusera, et
 * l'autre page prend le relais. Toute autre NMI reste fatale.
 */
bool Nvm_OnNmi(void)
{
  const uint32_t eccr = FLASH->ECCR;
  if (!s_in_read || ((eccr & FLASH_ECCR_ECCD) == 0U)) {
    return false;
  }
  FLASH->ECCR = eccr | FLASH_ECCR_ECCD;   /* rc_w1 : écrire 1 acquitte */
  s_ecc_hit = true;
  return true;
}

/** Copie une page en RAM sous garde ECC. Faux si une erreur double a été rencontrée. */
static bool ReadPage(uint32_t addr, uint8_t *dst)
{
  s_ecc_hit = false;
  s_in_read = true;
  __DSB();
  const volatile uint8_t *src = (const volatile uint8_t *)addr;
  for (uint32_t i = 0U; i < NVM_PAGE_SIZE; i++) {
    dst[i] = src[i];
  }
  __DSB();
  s_in_read = false;
  return !s_ecc_hit;
}

/** Longueur utile d'un enregistrement de `count` entrées, CRC compris. */
static uint32_t RecordLen(uint16_t count)
{
  return NVM_HDR_LEN + ((uint32_t)count * NVM_ENTRY_LEN) + NVM_CRC_LEN;
}

/** Vrai si `buf` porte un enregistrement cohérent ; rend alors sa séquence et son compte. */
static bool Decode(const uint8_t *buf, uint32_t *seq, uint16_t *count)
{
  if (GetU32(&buf[0]) != NVM_MAGIC) {
    return false;
  }
  const uint16_t n = GetU16(&buf[8]);
  if (n > NVM_MAX_ENTRIES) {
    return false;
  }
  const uint32_t body = RecordLen(n) - NVM_CRC_LEN;
  if (Param_Crc32(buf, body) != GetU32(&buf[body])) {
    return false;
  }
  *seq = GetU32(&buf[4]);
  *count = n;
  return true;
}

/* Le plus grand numéro de séquence gagne. Comparaison signée sur la différence : le compteur
 * ne débordera pas dans la vie de la carte, mais la règle ne coûte rien. */
static bool Newer(uint32_t a, uint32_t b)
{
  return (int32_t)(a - b) > 0;
}

void Nvm_Load(void)
{
  memset(&s_st, 0, sizeof(s_st));
  s_st.page = 0xFFU;

  static uint8_t other[NVM_PAGE_SIZE];     /* statique : 2 ko hors de la pile */
  uint32_t seq_a = 0U, seq_b = 0U;
  uint16_t n_a = 0U, n_b = 0U;
  const bool a_ok = ReadPage(NVM_PAGE_A, s_buf) && Decode(s_buf, &seq_a, &n_a);
  const bool b_ok = ReadPage(NVM_PAGE_B, other) && Decode(other, &seq_b, &n_b);

  const uint8_t *rec = NULL;
  if (a_ok && (!b_ok || !Newer(seq_b, seq_a))) {
    rec = s_buf;       s_st.page = 0U; s_st.seq = seq_a; s_st.entries = n_a;
  } else if (b_ok) {
    rec = other;       s_st.page = 1U; s_st.seq = seq_b; s_st.entries = n_b;
  }
  if (rec == NULL) {
    return;            /* rien d'enregistré, ou rien de lisible : les défauts restent */
  }
  s_st.valid = true;

  for (uint16_t i = 0U; i < s_st.entries; i++) {
    const uint8_t *e = &rec[NVM_HDR_LEN + ((uint32_t)i * NVM_ENTRY_LEN)];
    const uint16_t id = GetU16(&e[0]);
    const uint8_t type = e[2];
    float value;
    const uint32_t bits = GetU32(&e[4]);
    memcpy(&value, &bits, sizeof(value));

    /* Rien n'est pris sur parole. Le type doit être le même — un u8 relu comme un f32 serait
     * une valeur sans rapport —, le drapeau `persistent` doit être encore là, et l'écriture
     * passe par `Param_WriteValue`, qui refuse ce qui sort des bornes actuelles. */
    const ParamDesc_t *p = Param_ById(id);
    if ((p == NULL) || (p->type != type) || ((p->flags & PARAM_FLAG_PERSISTENT) == 0U) ||
        (Param_WriteValue(id, value) != PARAM_OK)) {
      s_st.skipped++;
      continue;
    }
    s_st.loaded++;
  }
}

/* ------------------------------------------------------------------ écriture */

static bool DualBank(void)
{
  /* Toute la géométrie suppose le mode double banque, pages de 2 ko. En simple banque, la
   * page 112 de la banque 2 désignerait tout autre chose. Le bootloader le suppose aussi ; on
   * le vérifie quand même, parce qu'une erreur ici effacerait du code. */
  return (FLASH->OPTR & FLASH_OPTR_DBANK) != 0U;
}

static bool ErasePage(uint32_t addr)
{
  FLASH_EraseInitTypeDef e = {0};
  uint32_t error = 0U;
  e.TypeErase = FLASH_TYPEERASE_PAGES;
  e.Banks     = FLASH_BANK_2;
  e.Page      = (addr - NVM_BANK2_BASE) / NVM_PAGE_SIZE;
  e.NbPages   = 1U;
  return (HAL_FLASHEx_Erase(&e, &error) == HAL_OK) && (error == 0xFFFFFFFFU);
}

static bool Program(uint32_t addr, const uint8_t *data, uint32_t len)
{
  for (uint32_t i = 0U; i < len; i += 8U) {
    uint64_t dw = 0U;
    for (uint32_t b = 0U; b < 8U; b++) {
      dw |= (uint64_t)data[i + b] << (8U * b);
    }
    if (HAL_FLASH_Program(FLASH_TYPEPROGRAM_DOUBLEWORD, addr + i, dw) != HAL_OK) {
      return false;
    }
  }
  return true;
}

Nvm_Result_t Nvm_Save(uint16_t *saved)
{
  if (saved != NULL) {
    *saved = 0U;
  }
  /* La zone est en banque 2, avec le slot B : si l'application s'exécute depuis lui,
   * l'effacement fige le cœur une vingtaine de millisecondes, ISR de contrôle comprise. */
  if (Pwm_IsEnabled()) {
    return NVM_ERR_LIVE;
  }
  if (!DualBank()) {
    return NVM_ERR_FLASH;
  }

  /* Construction de l'enregistrement : toutes les entrées persistantes, valeur courante. */
  memset(s_buf, 0xFF, sizeof(s_buf));
  uint16_t n = 0U;
  for (uint16_t i = 0U; i < Param_Count(); i++) {
    const ParamDesc_t *p = Param_At(i);
    if ((p == NULL) || ((p->flags & PARAM_FLAG_PERSISTENT) == 0U)) {
      continue;
    }
    if (n >= NVM_MAX_ENTRIES) {
      return NVM_ERR_FULL;
    }
    float v = 0.0f;
    (void)Param_ReadValue(p->id, &v);
    uint32_t bits;
    memcpy(&bits, &v, sizeof(bits));
    uint8_t *e = &s_buf[NVM_HDR_LEN + ((uint32_t)n * NVM_ENTRY_LEN)];
    PutU16(&e[0], p->id);
    e[2] = p->type;
    e[3] = 0xFFU;
    PutU32(&e[4], bits);
    n++;
  }
  const uint32_t seq = s_st.valid ? (s_st.seq + 1U) : 1U;
  PutU32(&s_buf[0], NVM_MAGIC);
  PutU32(&s_buf[4], seq);
  PutU16(&s_buf[8], n);
  PutU16(&s_buf[10], 0xFFFFU);
  const uint32_t body = RecordLen(n) - NVM_CRC_LEN;
  PutU32(&s_buf[body], Param_Crc32(s_buf, body));
  const uint32_t len = (RecordLen(n) + 7U) & ~7UL;   /* au double-mot, complété à 0xFF */

  /* Toujours sur la page qui ne porte pas l'enregistrement courant. */
  const uint8_t target_page = (s_st.valid && (s_st.page == 0U)) ? 1U : 0U;
  const uint32_t target = (target_page == 0U) ? NVM_PAGE_A : NVM_PAGE_B;

  if (HAL_FLASH_Unlock() != HAL_OK) {
    return NVM_ERR_FLASH;
  }
  __HAL_FLASH_CLEAR_FLAG(FLASH_FLAG_ALL_ERRORS);
  bool ok = ErasePage(target) && Program(target, s_buf, len);
  (void)HAL_FLASH_Lock();

  /* Le cache de données du contrôleur flash a pu garder l'ancien contenu de la page : on le
   * vide avant de relire, sans quoi la vérification comparerait le tampon à lui-même. */
  __HAL_FLASH_DATA_CACHE_DISABLE();
  __HAL_FLASH_DATA_CACHE_RESET();
  __HAL_FLASH_DATA_CACHE_ENABLE();

  /* Relecture complète : c'est elle, et non le statut du HAL, qui dit si c'est écrit. */
  if (ok) {
    static uint8_t check[NVM_PAGE_SIZE];
    uint32_t seq_r = 0U;
    uint16_t n_r = 0U;
    ok = ReadPage(target, check) && Decode(check, &seq_r, &n_r) &&
         (seq_r == seq) && (n_r == n) && (memcmp(check, s_buf, len) == 0);
  }
  if (!ok) {
    return NVM_ERR_FLASH;   /* l'enregistrement courant, sur l'autre page, reste le bon */
  }

  s_st.valid   = true;
  s_st.seq     = seq;
  s_st.page    = target_page;
  s_st.entries = n;
  s_st.saves++;
  if (saved != NULL) {
    *saved = n;
  }
  return NVM_OK;
}

void Nvm_GetStatus(Nvm_Status_t *out)
{
  *out = s_st;
}
