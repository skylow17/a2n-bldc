/**
 * @file selftest.c
 * @brief Execution des vecteurs de reference sur la cible. Voir comm/selftest.h.
 */
#include "comm/selftest.h"

#include <string.h>

#include "comm/cobs.h"
#include "comm/crc16.h"
#include "comm/frame.h"
#include "comm/param.h"
#include "comm/selftest_vectors.h"

/* Le plus gros vecteur COBS encode 512 octets nuls, soit 515 en sortie. On prend la marge
 * de la trame complete : ces tampons sont sur la pile de la superloop, pas dans l'ISR. */
static uint8_t s_buf_a[FRAME_ENCODED_MAX];
static uint8_t s_buf_b[FRAME_RAW_MAX];

static void RunCrc16(SelftestResult_t *r)
{
  for (size_t i = 0U; i < SELFTEST_CRC16_COUNT; i++) {
    const Crc16Vector_t *v = &k_crc16_vectors[i];
    r->total++;
    if (Crc16(v->data, v->len) != v->crc) {
      r->crc16_failed++;
      r->failed++;
    }
  }
}

static void RunCobs(SelftestResult_t *r)
{
  for (size_t i = 0U; i < SELFTEST_COBS_COUNT; i++) {
    const CobsVector_t *v = &k_cobs_vectors[i];

    /* Encodage : octet pour octet, pas seulement decodable. C'est la seule facon de
     * detecter une divergence de forme canonique avec l'implementation TypeScript. */
    r->total++;
    const size_t n = Cobs_Encode(v->raw, v->raw_len, s_buf_a, sizeof(s_buf_a));
    if ((n != v->enc_len) || (memcmp(s_buf_a, v->enc, n) != 0)) {
      r->cobs_encode_failed++;
      r->failed++;
    }

    r->total++;
    const size_t m = Cobs_Decode(v->enc, v->enc_len, s_buf_b, sizeof(s_buf_b));
    if ((m != v->raw_len) || (memcmp(s_buf_b, v->raw, m) != 0)) {
      r->cobs_decode_failed++;
      r->failed++;
    }
  }
}

static void RunFrame(SelftestResult_t *r)
{
  /* Aller-retour sur les tailles de payload aux limites, y compris celles ou COBS ouvre un
   * groupe supplementaire. On ne dispose pas ici des trames figees du JSON — elles sont
   * verifiees cote TypeScript — mais l'aller-retour valide l'assemblage, le CRC et le
   * decoupage tels que les compile le toolchain ARM. */
  static const uint16_t sizes[] = { 0U, 1U, 63U, 64U, 253U, 254U, 255U, 511U, 512U };
  uint8_t payload[FRAME_PAYLOAD_MAX];

  for (uint16_t i = 0U; i < FRAME_PAYLOAD_MAX; i++) {
    payload[i] = (uint8_t)(i * 7U);
  }

  for (size_t k = 0U; k < (sizeof(sizes) / sizeof(sizes[0])); k++) {
    const uint16_t n = sizes[k];
    r->total++;

    const size_t enc = Frame_Encode(0x1234U, 0x05U, 0xABU, payload, n, s_buf_a, sizeof(s_buf_a));
    if ((enc == 0U) || (s_buf_a[enc - 1U] != 0x00U)) {
      r->frame_failed++;
      r->failed++;
      continue;
    }

    Frame_t f;
    const FrameStatus_t st = Frame_Decode(s_buf_a, enc - 1U, s_buf_b, sizeof(s_buf_b), &f);
    if ((st != FRAME_OK) || (f.msg_id != 0x1234U) || (f.flags != 0x05U) ||
        (f.seq != 0xABU) || (f.payload_len != n) ||
        ((n > 0U) && (memcmp(f.payload, payload, n) != 0))) {
      r->frame_failed++;
      r->failed++;
    }
  }

  /* Un octet corrompu doit etre rejete par le CRC, pas absorbe silencieusement. */
  r->total++;
  const size_t enc = Frame_Encode(0x0012U, 0U, 9U, payload, 8U, s_buf_a, sizeof(s_buf_a));
  if (enc > 2U) {
    s_buf_a[1] = (uint8_t)((s_buf_a[1] == 0xFFU) ? 0xFEU : (s_buf_a[1] + 1U));
    Frame_t f;
    if (Frame_Decode(s_buf_a, enc - 1U, s_buf_b, sizeof(s_buf_b), &f) == FRAME_OK) {
      r->frame_failed++;
      r->failed++;
    }
  } else {
    r->frame_failed++;
    r->failed++;
  }
}

void Selftest_Run(SelftestResult_t *out)
{
  if (out == NULL) {
    return;
  }
  (void)memset(out, 0, sizeof(*out));

  RunCrc16(out);
  RunCobs(out);
  RunFrame(out);

  out->dict_hash = Param_DictHash();
  out->total++;
  out->dict_hash_ok = (out->dict_hash == (uint32_t)SELFTEST_DICT_HASH) &&
                      (Param_Count() == SELFTEST_DICT_COUNT);
  if (!out->dict_hash_ok) {
    out->failed++;
  }
}
