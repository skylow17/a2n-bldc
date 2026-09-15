/**
 * @file proto.c
 * @brief Traitement des messages du canal binaire. Voir comm/proto.h.
 */
#include "comm/proto.h"

#include <string.h>

#include "comm/frame.h"
#include "comm/param.h"
#include "link_usb.h"
#include "stm32g4xx_hal.h"
#include "version.h"

/* Un seul tampon d'emission, reutilise a chaque reponse : le traitement est sequentiel dans
 * la superloop, il n'y a jamais deux reponses en construction simultanement. */
static uint8_t  s_tx[FRAME_ENCODED_MAX];
static uint8_t  s_payload[FRAME_PAYLOAD_MAX];
static uint32_t s_rx_frames;
static uint32_t s_rx_errors;
static uint32_t s_tx_dropped;

void Proto_Init(void)
{
  s_rx_frames  = 0U;
  s_rx_errors  = 0U;
  s_tx_dropped = 0U;
}

uint32_t Proto_RxFrames(void)  { return s_rx_frames; }
uint32_t Proto_RxErrors(void)  { return s_rx_errors; }
uint32_t Proto_TxDropped(void) { return s_tx_dropped; }

static void Send(uint16_t msg_id, uint8_t flags, uint8_t seq,
                 const void *payload, uint16_t len)
{
  const size_t n = Frame_Encode(msg_id, flags, seq, payload, len, s_tx, sizeof(s_tx));
  if (n == 0U) {
    s_tx_dropped++;
    return;
  }
  if (!Link_TxWrite(s_tx, (uint16_t)n)) {
    s_tx_dropped++;
  }
}

void Proto_SendError(uint16_t msg_id, uint8_t seq, uint16_t code)
{
  uint8_t p[2];
  Frame_PutU16(p, code);
  Send(msg_id, FRAME_FLAG_RESPONSE | FRAME_FLAG_ERROR, seq, p, sizeof(p));
}

/* ---------------------------------------------------------------- handshake */

static void PutFixedString(uint8_t *dst, size_t width, const char *src)
{
  (void)memset(dst, 0, width);
  const size_t n = strlen(src);
  (void)memcpy(dst, src, (n < width) ? n : width);
}

static void OnHello(uint8_t seq)
{
  size_t o = 0U;

  Frame_PutU16(&s_payload[o], (uint16_t)((FW_PROTO_MAJOR << 8) | FW_PROTO_MINOR)); o += 2U;
  PutFixedString(&s_payload[o], 16U, FW_PRODUCT);                                  o += 16U;
  PutFixedString(&s_payload[o], 16U, FW_VERSION);                                  o += 16U;
  Frame_PutU32(&s_payload[o], Param_DictHash());                                   o += 4U;
  Frame_PutU32(&s_payload[o], HAL_GetUIDw0());                                     o += 4U;
  Frame_PutU32(&s_payload[o], HAL_GetUIDw1());                                     o += 4U;
  Frame_PutU32(&s_payload[o], HAL_GetUIDw2());                                     o += 4U;
  Frame_PutU16(&s_payload[o], Param_Count());                                      o += 2U;
  Frame_PutU16(&s_payload[o], 0U);   /* telem_signal_count : aucun signal a M1b */ o += 2U;

  /* Aucune capacite annoncee tant qu'aucune n'est implementee. L'interface en deduit
   * correctement qu'il n'y a ni telemetrie, ni scope, ni NVM, ni bootloader. */
  Frame_PutU32(&s_payload[o], 0U);                                                 o += 4U;

  Send(MSG_DEVICE_INFO, FRAME_FLAG_RESPONSE, seq, s_payload, (uint16_t)o);
}

/* ---------------------------------------------------------------- dictionnaire */

/* Nombre d'entrees transportables dans une trame, entete de pagination deduit. */
#define DICT_HDR_LEN    6U
#define DICT_MAX_BATCH  ((FRAME_PAYLOAD_MAX - DICT_HDR_LEN) / PARAM_ENTRY_WIRE_LEN)

static void OnDictGet(uint8_t seq, const uint8_t *payload, uint16_t len)
{
  if (len < 4U) {
    Proto_SendError(MSG_PARAM_DICT_GET, seq, PROTO_ERR_LEN);
    return;
  }

  const uint16_t total = Param_Count();
  const uint16_t start = Frame_GetU16(&payload[0]);
  uint16_t       want  = Frame_GetU16(&payload[2]);

  if (start >= total) {
    Proto_SendError(MSG_PARAM_DICT_GET, seq, PROTO_ERR_RANGE);
    return;
  }
  if (want > DICT_MAX_BATCH)      { want = DICT_MAX_BATCH; }
  if (want > (total - start))     { want = (uint16_t)(total - start); }
  if (want == 0U)                 { want = 1U; }

  size_t o = 0U;
  Frame_PutU16(&s_payload[o], start); o += 2U;
  Frame_PutU16(&s_payload[o], total); o += 2U;
  Frame_PutU16(&s_payload[o], want);  o += 2U;

  for (uint16_t k = 0U; k < want; k++) {
    if (!Param_SerializeEntry((uint16_t)(start + k), &s_payload[o])) {
      Proto_SendError(MSG_PARAM_DICT_GET, seq, PROTO_ERR_ID);
      return;
    }
    o += PARAM_ENTRY_WIRE_LEN;
  }

  Send(MSG_PARAM_DICT_ENTRY, FRAME_FLAG_RESPONSE, seq, s_payload, (uint16_t)o);
}

/* ---------------------------------------------------------------- lecture / ecriture */

static void OnParamRead(uint8_t seq, const uint8_t *payload, uint16_t len)
{
  if (len < 2U) {
    Proto_SendError(MSG_PARAM_READ, seq, PROTO_ERR_LEN);
    return;
  }
  const uint16_t count = Frame_GetU16(&payload[0]);
  if ((uint32_t)len < (2U + (uint32_t)count * 2U)) {
    Proto_SendError(MSG_PARAM_READ, seq, PROTO_ERR_LEN);
    return;
  }
  /* 7 octets par reponse : id, statut, valeur. */
  if ((uint32_t)count * 7U > (FRAME_PAYLOAD_MAX - 2U)) {
    Proto_SendError(MSG_PARAM_READ, seq, PROTO_ERR_RANGE);
    return;
  }

  size_t o = 0U;
  Frame_PutU16(&s_payload[o], count); o += 2U;

  for (uint16_t k = 0U; k < count; k++) {
    const uint16_t id = Frame_GetU16(&payload[2U + (k * 2U)]);
    float v = 0.0f;
    const ParamStatus_t st = Param_ReadValue(id, &v);

    Frame_PutU16(&s_payload[o], id);          o += 2U;
    s_payload[o++] = (uint8_t)st;
    Frame_PutF32(&s_payload[o], v);           o += 4U;
  }

  Send(MSG_PARAM_READ, FRAME_FLAG_RESPONSE, seq, s_payload, (uint16_t)o);
}

static void OnParamWrite(uint8_t seq, const uint8_t *payload, uint16_t len)
{
  if (len < 2U) {
    Proto_SendError(MSG_PARAM_WRITE, seq, PROTO_ERR_LEN);
    return;
  }
  const uint16_t count = Frame_GetU16(&payload[0]);
  if ((uint32_t)len < (2U + (uint32_t)count * 6U)) {
    Proto_SendError(MSG_PARAM_WRITE, seq, PROTO_ERR_LEN);
    return;
  }
  /* 3 octets par reponse : id, statut. */
  if ((uint32_t)count * 3U > (FRAME_PAYLOAD_MAX - 2U)) {
    Proto_SendError(MSG_PARAM_WRITE, seq, PROTO_ERR_RANGE);
    return;
  }

  size_t o = 0U;
  Frame_PutU16(&s_payload[o], count); o += 2U;

  /* Chaque ecriture est independante : une valeur refusee n'annule pas les autres, et
   * l'hote recoit le statut de chacune. Un lot n'est pas une transaction — quand ce sera
   * necessaire (application d'une recette), ce sera un message distinct qui le dira. */
  for (uint16_t k = 0U; k < count; k++) {
    const uint8_t *e = &payload[2U + (k * 6U)];
    const uint16_t id = Frame_GetU16(&e[0]);
    const float    v  = Frame_GetF32(&e[2]);
    const ParamStatus_t st = Param_WriteValue(id, v);

    Frame_PutU16(&s_payload[o], id); o += 2U;
    s_payload[o++] = (uint8_t)st;
  }

  Send(MSG_PARAM_WRITE, FRAME_FLAG_RESPONSE, seq, s_payload, (uint16_t)o);
}

/* ---------------------------------------------------------------- aiguillage */

void Proto_HandleFrame(uint16_t msg_id, uint8_t flags, uint8_t seq,
                       const uint8_t *payload, uint16_t payload_len)
{
  (void)flags;
  s_rx_frames++;

  switch (msg_id) {
    case MSG_HELLO:
      OnHello(seq);
      break;

    case MSG_PARAM_DICT_GET:
      OnDictGet(seq, payload, payload_len);
      break;

    case MSG_PARAM_READ:
      OnParamRead(seq, payload, payload_len);
      break;

    case MSG_PARAM_WRITE:
      OnParamWrite(seq, payload, payload_len);
      break;

    case MSG_PARAM_RESET_DEFAULTS:
      Param_ResetDefaults();
      Send(MSG_PARAM_RESET_DEFAULTS, FRAME_FLAG_RESPONSE, seq, NULL, 0U);
      break;

    case MSG_PARAM_SAVE_NVM:
      /* La persistance arrive avec le decoupage flash (M2). Refuser explicitement vaut
       * mieux que repondre OK sans rien ecrire : l'hote croirait la recette enregistree. */
      s_rx_errors++;
      Proto_SendError(MSG_PARAM_SAVE_NVM, seq, PROTO_ERR_NVM);
      break;

    default:
      s_rx_errors++;
      Proto_SendError(msg_id, seq, PROTO_ERR_ID);
      break;
  }
}
