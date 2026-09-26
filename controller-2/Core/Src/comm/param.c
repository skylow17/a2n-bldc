/**
 * @file param.c
 * @brief Acces au dictionnaire, conversion de types, hash de forme. Voir comm/param.h.
 */
#include "comm/param.h"

#include "pwm.h"

#include <math.h>
#include <string.h>

#include "comm/frame.h"

extern const ParamDesc_t g_param_table[];
extern const uint16_t    g_param_count;

static uint32_t s_dict_hash;

/* ---------------------------------------------------------------- CRC-32 */

/* CRC-32/ISO-HDLC : polynome reflechi 0xEDB88320, init et xorout 0xFFFFFFFF. C'est celui de
 * zlib, donc disponible partout cote PC sans dependance. Calcul bit a bit : il ne tourne
 * qu'une fois au demarrage, sur ~900 octets, et une table de 1 ko ne se justifie pas.
 * Vecteur d'arbitrage : CRC32("123456789") == 0xCBF43926. */
static uint32_t Crc32Update(uint32_t crc, const uint8_t *data, size_t len)
{
  for (size_t i = 0U; i < len; i++) {
    crc ^= data[i];
    for (uint8_t b = 0U; b < 8U; b++) {
      const uint32_t mask = (uint32_t)-(int32_t)(crc & 1U);
      crc = (crc >> 1) ^ (0xEDB88320U & mask);
    }
  }
  return crc;
}

/* ---------------------------------------------------------------- serialisation */

/* Copie une chaine dans un champ de largeur fixe, complete par des zeros. Une chaine qui
 * remplit exactement le champ n'est pas terminee : c'est le format decrit par le protocole,
 * et le lecteur doit traiter le champ comme borne, pas comme une chaine C. */
static void PutFixedString(uint8_t *dst, size_t width, const char *src)
{
  (void)memset(dst, 0, width);
  if (src == NULL) {
    return;
  }
  const size_t n = strlen(src);
  (void)memcpy(dst, src, (n < width) ? n : width);
}

bool Param_SerializeEntry(uint16_t index, uint8_t *dst)
{
  if ((index >= g_param_count) || (dst == NULL)) {
    return false;
  }
  const ParamDesc_t *p = &g_param_table[index];
  size_t o = 0U;

  Frame_PutU16(&dst[o], p->id);                       o += 2U;
  dst[o++] = p->type;
  dst[o++] = p->flags;
  PutFixedString(&dst[o], PARAM_NAME_LEN,  p->name);  o += PARAM_NAME_LEN;
  PutFixedString(&dst[o], PARAM_UNIT_LEN,  p->unit);  o += PARAM_UNIT_LEN;
  Frame_PutF32(&dst[o], p->min);                      o += 4U;
  Frame_PutF32(&dst[o], p->max);                      o += 4U;
  Frame_PutF32(&dst[o], p->def);                      o += 4U;
  PutFixedString(&dst[o], PARAM_GROUP_LEN, p->group); o += PARAM_GROUP_LEN;

  return (o == PARAM_ENTRY_WIRE_LEN);
}

void Param_Init(void)
{
  uint8_t  entry[PARAM_ENTRY_WIRE_LEN];
  uint32_t crc = 0xFFFFFFFFU;

  /* Le hash porte sur les octets qui circulent reellement, pas sur la representation
   * memoire : l'hote peut donc le recalculer a l'identique sur ce qu'il a recu, ce qui en
   * fait aussi un controle d'integrite du transfert. */
  for (uint16_t i = 0U; i < g_param_count; i++) {
    if (Param_SerializeEntry(i, entry)) {
      crc = Crc32Update(crc, entry, sizeof(entry));
    }
  }
  s_dict_hash = crc ^ 0xFFFFFFFFU;
}

uint32_t Param_Crc32(const void *data, size_t len)
{
  return Crc32Update(0xFFFFFFFFU, (const uint8_t *)data, len) ^ 0xFFFFFFFFU;
}

uint16_t Param_Count(void)     { return g_param_count; }
uint32_t Param_DictHash(void)  { return s_dict_hash; }

const ParamDesc_t *Param_At(uint16_t index)
{
  return (index < g_param_count) ? &g_param_table[index] : NULL;
}

const ParamDesc_t *Param_ById(uint16_t id)
{
  for (uint16_t i = 0U; i < g_param_count; i++) {
    if (g_param_table[i].id == id) {
      return &g_param_table[i];
    }
  }
  return NULL;
}

/* ---------------------------------------------------------------- valeurs */

static float LoadAsFloat(const ParamDesc_t *p)
{
  switch ((ParamType_t)p->type) {
    case PARAM_TYPE_U8:   return (float)(*(const uint8_t  *)p->storage);
    case PARAM_TYPE_I8:   return (float)(*(const int8_t   *)p->storage);
    case PARAM_TYPE_U16:  return (float)(*(const uint16_t *)p->storage);
    case PARAM_TYPE_I16:  return (float)(*(const int16_t  *)p->storage);
    case PARAM_TYPE_U32:  return (float)(*(const uint32_t *)p->storage);
    case PARAM_TYPE_I32:  return (float)(*(const int32_t  *)p->storage);
    case PARAM_TYPE_F32:  return *(const float *)p->storage;
    case PARAM_TYPE_BOOL: return (*(const bool *)p->storage) ? 1.0f : 0.0f;
    case PARAM_TYPE_ENUM: return (float)(*(const uint8_t *)p->storage);
    default:              return 0.0f;
  }
}

/* Arrondi au plus proche avant troncature vers le type entier : sans cela, un 2.9999997
 * venant d'un aller-retour flottant cote PC se rangerait en 2. */
static void StoreFromFloat(const ParamDesc_t *p, float v)
{
  const float r = (v < 0.0f) ? (v - 0.5f) : (v + 0.5f);

  switch ((ParamType_t)p->type) {
    case PARAM_TYPE_U8:   *(uint8_t  *)p->storage = (uint8_t)r;  break;
    case PARAM_TYPE_I8:   *(int8_t   *)p->storage = (int8_t)r;   break;
    case PARAM_TYPE_U16:  *(uint16_t *)p->storage = (uint16_t)r; break;
    case PARAM_TYPE_I16:  *(int16_t  *)p->storage = (int16_t)r;  break;
    case PARAM_TYPE_U32:  *(uint32_t *)p->storage = (uint32_t)r; break;
    case PARAM_TYPE_I32:  *(int32_t  *)p->storage = (int32_t)r;  break;
    case PARAM_TYPE_F32:  *(float    *)p->storage = v;           break;
    case PARAM_TYPE_BOOL: *(bool     *)p->storage = (v != 0.0f); break;
    case PARAM_TYPE_ENUM: *(uint8_t  *)p->storage = (uint8_t)r;  break;
    default:              break;
  }
}

ParamStatus_t Param_ReadValue(uint16_t id, float *out)
{
  const ParamDesc_t *p = Param_ById(id);
  if ((p == NULL) || (out == NULL)) {
    return PARAM_ERR_ID;
  }
  *out = LoadAsFloat(p);
  return PARAM_OK;
}

ParamStatus_t Param_WriteValue(uint16_t id, float value)
{
  const ParamDesc_t *p = Param_ById(id);
  if (p == NULL) {
    return PARAM_ERR_ID;
  }
  if ((p->flags & PARAM_FLAG_READ_ONLY) != 0U) {
    return PARAM_ERR_READ_ONLY;
  }
  /* NaN echoue toutes les comparaisons d'ordre : le test explicite evite qu'il se glisse
   * dans un stockage flottant en passant a travers un `if (v < min || v > max)`. */
  if (isnan(value) || (value < p->min) || (value > p->max)) {
    return PARAM_ERR_RANGE;
  }

  /* Tant que la machine a etats n'existe pas (M3), « desarme » veut dire sorties de
   * puissance coupees. Un nombre de paires de poles ou un decalage d'angle change moteur
   * alimente changerait la commutation en marche. */
  if (((p->flags & PARAM_FLAG_REQUIRES_DISARM) != 0U) && Pwm_IsEnabled()) {
    return PARAM_ERR_STATE;
  }

  StoreFromFloat(p, value);
  return PARAM_OK;
}

void Param_ResetDefaults(void)
{
  for (uint16_t i = 0U; i < g_param_count; i++) {
    const ParamDesc_t *p = &g_param_table[i];
    if ((p->flags & PARAM_FLAG_READ_ONLY) == 0U) {
      StoreFromFloat(p, p->def);
    }
  }
}
