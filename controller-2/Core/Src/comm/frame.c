/**
 * @file frame.c
 * @brief Serialisation et verification des trames binaires. Voir comm/frame.h.
 */
#include "comm/frame.h"

#include <string.h>

#include "comm/crc16.h"

size_t Frame_Encode(uint16_t msg_id, uint8_t flags, uint8_t seq,
                    const void *payload, uint16_t payload_len,
                    uint8_t *dst, size_t dst_cap)
{
  uint8_t raw[FRAME_RAW_MAX];

  if (payload_len > FRAME_PAYLOAD_MAX) {
    return 0U;
  }
  if ((payload == NULL) && (payload_len != 0U)) {
    return 0U;
  }

  Frame_PutU16(&raw[0], msg_id);
  raw[2] = flags;
  raw[3] = seq;
  if (payload_len != 0U) {
    (void)memcpy(&raw[FRAME_HEADER_LEN], payload, payload_len);
  }

  const size_t body = (size_t)FRAME_HEADER_LEN + payload_len;
  Frame_PutU16(&raw[body], Crc16(raw, body));

  const size_t raw_len = body + FRAME_CRC_LEN;

  /* +1 pour le delimiteur, +1 pour l'octet que l'encodeur peut ecrire sans le compter. */
  if (dst_cap < (COBS_MAX_ENCODED(raw_len) + 2U)) {
    return 0U;
  }

  const size_t n = Cobs_Encode(raw, raw_len, dst, dst_cap - 1U);
  if (n == 0U) {
    return 0U;
  }
  dst[n] = 0x00U;   /* delimiteur */
  return n + 1U;
}

FrameStatus_t Frame_Decode(const uint8_t *src, size_t len,
                           uint8_t *scratch, size_t scratch_cap,
                           Frame_t *out)
{
  if ((src == NULL) || (scratch == NULL) || (out == NULL)) {
    return FRAME_ERR_LEN;
  }

  const size_t raw_len = Cobs_Decode(src, len, scratch, scratch_cap);
  if (raw_len == 0U) {
    return FRAME_ERR_COBS;
  }
  if ((raw_len < FRAME_RAW_MIN) || (raw_len > FRAME_RAW_MAX)) {
    return FRAME_ERR_LEN;
  }

  const size_t body = raw_len - FRAME_CRC_LEN;
  const uint16_t crc_rx = Frame_GetU16(&scratch[body]);
  if (crc_rx != Crc16(scratch, body)) {
    return FRAME_ERR_CRC;
  }

  out->msg_id      = Frame_GetU16(&scratch[0]);
  out->flags       = scratch[2];
  out->seq         = scratch[3];
  out->payload     = &scratch[FRAME_HEADER_LEN];
  out->payload_len = (uint16_t)(body - FRAME_HEADER_LEN);
  return FRAME_OK;
}
