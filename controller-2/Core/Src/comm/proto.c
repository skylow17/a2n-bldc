/**
 * @file proto.c
 * @brief Traitement des messages du canal binaire. Voir comm/proto.h.
 */
#include "comm/proto.h"

#include <string.h>

#include "comm/frame.h"
#include "comm/param.h"
#include "nvm.h"
#include "comm/scope.h"
#include "comm/signals.h"
#include "boot_shared.h"
#include "ctrl.h"
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
static uint16_t s_telem_ids[16];
static uint8_t  s_telem_count;
static uint16_t s_telem_rate_hz;
static uint16_t s_telem_divisor;
static uint32_t s_telem_last_tick;
static uint16_t s_telem_sample_seq;
static uint8_t  s_push_seq;
static uint32_t s_boot_reset_at;

void Proto_Init(void)
{
  s_rx_frames  = 0U;
  s_rx_errors  = 0U;
  s_tx_dropped = 0U;
  s_telem_count = 0U;
  s_telem_rate_hz = 0U;
  s_telem_divisor = 0U;
  s_telem_last_tick = 0U;
  s_telem_sample_seq = 0U;
  s_push_seq = 0U;
  s_boot_reset_at = 0U;
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
  Frame_PutU16(&s_payload[o], Signal_Count());                                     o += 2U;
  uint32_t capabilities = PROTO_CAP_TELEMETRY | PROTO_CAP_SCOPE | PROTO_CAP_NVM;
#if defined(APP_WITH_BOOTLOADER)
  capabilities |= PROTO_CAP_BOOTLOADER;
#endif
  Frame_PutU32(&s_payload[o], capabilities);                                       o += 4U;

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

/* ---------------------------------------------------------------- télémétrie */

#define SIGNALS_HDR_LEN   6U
#define SIGNALS_MAX_BATCH ((FRAME_PAYLOAD_MAX - SIGNALS_HDR_LEN) / SIGNAL_ENTRY_WIRE_LEN)

static void OnTelemSignals(uint8_t seq, const uint8_t *payload, uint16_t len)
{
  if (len != 4U) {
    Proto_SendError(MSG_TELEM_SIGNALS, seq, PROTO_ERR_LEN);
    return;
  }
  const uint16_t total = Signal_Count();
  const uint16_t start = Frame_GetU16(&payload[0]);
  uint16_t want = Frame_GetU16(&payload[2]);
  if (start >= total) {
    Proto_SendError(MSG_TELEM_SIGNALS, seq, PROTO_ERR_RANGE);
    return;
  }
  if (want == 0U) { want = 1U; }
  if (want > SIGNALS_MAX_BATCH) { want = SIGNALS_MAX_BATCH; }
  if (want > (total - start)) { want = (uint16_t)(total - start); }

  size_t o = 0U;
  Frame_PutU16(&s_payload[o], start); o += 2U;
  Frame_PutU16(&s_payload[o], total); o += 2U;
  Frame_PutU16(&s_payload[o], want);  o += 2U;
  for (uint16_t i = 0U; i < want; i++) {
    (void)Signal_SerializeEntry((uint16_t)(start + i), &s_payload[o]);
    o += SIGNAL_ENTRY_WIRE_LEN;
  }
  Send(MSG_TELEM_SIGNALS, FRAME_FLAG_RESPONSE, seq, s_payload, (uint16_t)o);
}

static void OnTelemSubscribe(uint8_t seq, const uint8_t *payload, uint16_t len)
{
  if (len < 4U) {
    Proto_SendError(MSG_TELEM_SUBSCRIBE, seq, PROTO_ERR_LEN);
    return;
  }
  uint16_t rate = Frame_GetU16(&payload[0]);
  const uint8_t count = payload[2];
  if (len != (uint16_t)(4U + (uint16_t)count * 2U)) {
    Proto_SendError(MSG_TELEM_SUBSCRIBE, seq, PROTO_ERR_LEN);
    return;
  }
  if ((payload[3] != 0U) || (count > 16U)) {
    Proto_SendError(MSG_TELEM_SUBSCRIBE, seq, PROTO_ERR_ARG);
    return;
  }
  for (uint8_t i = 0U; i < count; i++) {
    const uint16_t id = Frame_GetU16(&payload[4U + (uint16_t)i * 2U]);
    if (!Signal_IsKnown(id)) {
      Proto_SendError(MSG_TELEM_SUBSCRIBE, seq, PROTO_ERR_ID);
      return;
    }
    for (uint8_t j = 0U; j < i; j++) {
      if (s_telem_ids[j] == id) {
        Proto_SendError(MSG_TELEM_SUBSCRIBE, seq, PROTO_ERR_ARG);
        return;
      }
    }
    s_telem_ids[i] = id;
  }

  if ((rate == 0U) || (count == 0U)) {
    rate = 0U;
    s_telem_count = 0U;
    s_telem_divisor = 0U;
  } else {
    if (rate < 100U) { rate = 100U; }
    if (rate > 500U) { rate = 500U; }
    s_telem_divisor = (uint16_t)((20000U + (rate / 2U)) / rate);
    rate = (uint16_t)(20000U / s_telem_divisor);
    s_telem_count = count;
  }
  s_telem_rate_hz = rate;
  Ctrl_Stats_t stats;
  Ctrl_GetStats(&stats);
  s_telem_last_tick = stats.ticks;
  s_telem_sample_seq = 0U;

  size_t o = 0U;
  Frame_PutU16(&s_payload[o], s_telem_rate_hz); o += 2U;
  s_payload[o++] = s_telem_count;
  s_payload[o++] = 0U;
  for (uint8_t i = 0U; i < s_telem_count; i++) {
    Frame_PutU16(&s_payload[o], s_telem_ids[i]); o += 2U;
  }
  Send(MSG_TELEM_SUBSCRIBE, FRAME_FLAG_RESPONSE, seq, s_payload, (uint16_t)o);
}

static void ProcessTelemetry(void)
{
  if ((s_telem_count == 0U) || (s_telem_divisor == 0U)) {
    return;
  }
  Ctrl_Stats_t stats;
  Ctrl_GetStats(&stats);
  if ((uint32_t)(stats.ticks - s_telem_last_tick) < s_telem_divisor) {
    return;
  }
  s_telem_last_tick = stats.ticks;
  const Signal_Snapshot_t snapshot = {
    .ticks = stats.ticks,
    .cycles_last = stats.cycles_last,
    .cycles_max = stats.cycles_max,
    .raw_ia = stats.raw_ia,
    .raw_ib = stats.raw_ib,
    .raw_ic = stats.raw_ic,
    .cent_ia = stats.cent_ia,
    .cent_ib = stats.cent_ib,
    .cent_ic = stats.cent_ic,
    .pos_rad = stats.pos_rad,
    .vel_rad_s = stats.vel_rad_s,
    .enc_age_us = stats.enc_age_us,
    .enc_valid = stats.enc_valid,
    .theta_e_rad = stats.theta_e_rad,
    .id_a = stats.id_a,
    .iq_a = stats.iq_a,
    .ol_theta_rad = stats.ol_theta_rad,
    .foc_valid = stats.foc_valid,
  };

  size_t o = 0U;
  Frame_PutU32(&s_payload[o], (stats.ticks - 1U) * 50U); o += 4U;
  Frame_PutU16(&s_payload[o], s_telem_sample_seq++);     o += 2U;
  s_payload[o++] = s_telem_count;
  s_payload[o++] = 0U;
  for (uint8_t i = 0U; i < s_telem_count; i++) {
    float value = 0.0f;
    (void)Signal_Read(s_telem_ids[i], &snapshot, &value);
    Frame_PutF32(&s_payload[o], value); o += 4U;
  }
  Send(MSG_TELEM_FRAME, FRAME_FLAG_PUSH, s_push_seq++, s_payload, (uint16_t)o);
}

/* ---------------------------------------------------------------- scope */

static uint16_t PutScopeConfig(uint8_t *out)
{
  const ScopeConfig_t *c = Scope_GetConfig();
  size_t o = 0U;
  Frame_PutU16(&out[o], c->depth);                 o += 2U;
  Frame_PutU16(&out[o], c->decimation);            o += 2U;
  Frame_PutU16(&out[o], c->pretrigger_samples);    o += 2U;
  out[o++] = c->trigger_mode;
  out[o++] = c->signal_count;
  Frame_PutU16(&out[o], c->trigger_signal_id);     o += 2U;
  Frame_PutF32(&out[o], c->threshold);             o += 4U;
  for (uint8_t i = 0U; i < c->signal_count; i++) {
    Frame_PutU16(&out[o], c->signal_ids[i]);       o += 2U;
  }
  return (uint16_t)o;
}

static uint16_t PutScopeStatus(uint8_t *out)
{
  ScopeStatus_t s;
  Scope_GetStatus(&s);
  size_t o = 0U;
  out[o++] = (uint8_t)s.state;
  out[o++] = s.signal_count;
  Frame_PutU16(&out[o], s.captured);               o += 2U;
  Frame_PutU16(&out[o], s.depth);                  o += 2U;
  Frame_PutU16(&out[o], s.trigger_index);          o += 2U;
  Frame_PutU16(&out[o], s.decimation);             o += 2U;
  Frame_PutU16(&out[o], 0U);                       o += 2U;
  Frame_PutU32(&out[o], s.sample_period_ns);       o += 4U;
  Frame_PutU32(&out[o], s.start_timestamp_us);     o += 4U;
  return (uint16_t)o;
}

static void OnScopeConfig(uint8_t seq, const uint8_t *payload, uint16_t len)
{
  if (len < 14U) {
    Proto_SendError(MSG_SCOPE_CONFIG, seq, PROTO_ERR_LEN);
    return;
  }
  ScopeStatus_t status;
  Scope_GetStatus(&status);
  if ((status.state == SCOPE_ARMED) || (status.state == SCOPE_TRIGGERED)) {
    Proto_SendError(MSG_SCOPE_CONFIG, seq, PROTO_ERR_BUSY);
    return;
  }
  ScopeConfig_t c;
  (void)memset(&c, 0, sizeof(c));
  c.depth = Frame_GetU16(&payload[0]);
  c.decimation = Frame_GetU16(&payload[2]);
  c.pretrigger_samples = Frame_GetU16(&payload[4]);
  c.trigger_mode = payload[6];
  c.signal_count = payload[7];
  c.trigger_signal_id = Frame_GetU16(&payload[8]);
  c.threshold = Frame_GetF32(&payload[10]);
  if (len != (uint16_t)(14U + (uint16_t)c.signal_count * 2U)) {
    Proto_SendError(MSG_SCOPE_CONFIG, seq, PROTO_ERR_LEN);
    return;
  }
  if (c.signal_count > SCOPE_MAX_SIGNALS) {
    Proto_SendError(MSG_SCOPE_CONFIG, seq, PROTO_ERR_RANGE);
    return;
  }
  for (uint8_t i = 0U; i < c.signal_count; i++) {
    c.signal_ids[i] = Frame_GetU16(&payload[14U + (uint16_t)i * 2U]);
  }
  if (!Scope_Configure(&c)) {
    Proto_SendError(MSG_SCOPE_CONFIG, seq, PROTO_ERR_ARG);
    return;
  }
  const uint16_t n = PutScopeConfig(s_payload);
  Send(MSG_SCOPE_CONFIG, FRAME_FLAG_RESPONSE, seq, s_payload, n);
}

static void OnScopeArm(uint8_t seq, uint16_t len)
{
  if (len != 0U) {
    Proto_SendError(MSG_SCOPE_ARM, seq, PROTO_ERR_LEN);
    return;
  }
  if (!Scope_Arm()) {
    Proto_SendError(MSG_SCOPE_ARM, seq, PROTO_ERR_BUSY);
    return;
  }
  const uint16_t n = PutScopeStatus(s_payload);
  Send(MSG_SCOPE_STATUS, FRAME_FLAG_RESPONSE, seq, s_payload, n);
}

static void OnScopeStatus(uint8_t seq, uint16_t len)
{
  if (len != 0U) {
    Proto_SendError(MSG_SCOPE_STATUS, seq, PROTO_ERR_LEN);
    return;
  }
  const uint16_t n = PutScopeStatus(s_payload);
  Send(MSG_SCOPE_STATUS, FRAME_FLAG_RESPONSE, seq, s_payload, n);
}

static void OnScopeRead(uint8_t seq, const uint8_t *payload, uint16_t len)
{
  if (len != 4U) {
    Proto_SendError(MSG_SCOPE_READ, seq, PROTO_ERR_LEN);
    return;
  }
  ScopeStatus_t status;
  Scope_GetStatus(&status);
  if (status.state != SCOPE_COMPLETE) {
    Proto_SendError(MSG_SCOPE_READ, seq, PROTO_ERR_STATE);
    return;
  }
  const uint16_t start = Frame_GetU16(&payload[0]);
  uint16_t count = Frame_GetU16(&payload[2]);
  if ((start >= status.captured) || (count == 0U)) {
    Proto_SendError(MSG_SCOPE_READ, seq, PROTO_ERR_RANGE);
    return;
  }
  const uint16_t max_points = (uint16_t)((FRAME_PAYLOAD_MAX - 8U) /
                                         (4U * status.signal_count));
  if (count > max_points) { count = max_points; }
  if (count > (status.captured - start)) { count = (uint16_t)(status.captured - start); }

  size_t o = 0U;
  Frame_PutU16(&s_payload[o], start);           o += 2U;
  Frame_PutU16(&s_payload[o], status.captured); o += 2U;
  Frame_PutU16(&s_payload[o], count);           o += 2U;
  s_payload[o++] = status.signal_count;
  s_payload[o++] = 0U;
  for (uint16_t sample = 0U; sample < count; sample++) {
    for (uint8_t signal = 0U; signal < status.signal_count; signal++) {
      float value = 0.0f;
      (void)Scope_ReadValue((uint16_t)(start + sample), signal, &value);
      Frame_PutF32(&s_payload[o], value); o += 4U;
    }
  }
  const uint8_t flags = FRAME_FLAG_RESPONSE |
    (((uint32_t)start + count < status.captured) ? FRAME_FLAG_MORE : 0U);
  Send(MSG_SCOPE_READ, flags, seq, s_payload, (uint16_t)o);
}

void Proto_Process(void)
{
  ProcessTelemetry();
  if (Scope_ConsumeStatusDirty()) {
    const uint16_t n = PutScopeStatus(s_payload);
    Send(MSG_SCOPE_STATUS, FRAME_FLAG_PUSH, s_push_seq++, s_payload, n);
  }
  if ((s_boot_reset_at != 0U) && ((int32_t)(HAL_GetTick() - s_boot_reset_at) >= 0)) {
    BootShared_RequestEnter();
  }
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

    case MSG_PARAM_SAVE_NVM: {
      /* Sorties actives : `STATE`, l'effacement figerait l'ISR. Echec d'ecriture ou de
       * relecture : `NVM`, et l'enregistrement precedent reste le bon. Jamais d'OK sans
       * enregistrement relu juste : l'hote croirait sa recette sauvee. */
      uint16_t saved = 0U;
      const Nvm_Result_t r = Nvm_Save(&saved);
      if (r != NVM_OK) {
        Proto_SendError(MSG_PARAM_SAVE_NVM, seq,
                        (r == NVM_ERR_LIVE) ? PROTO_ERR_STATE : PROTO_ERR_NVM);
        break;
      }
      Nvm_Status_t st;
      Nvm_GetStatus(&st);
      uint8_t out[6];
      Frame_PutU16(&out[0], saved);
      Frame_PutU32(&out[2], st.seq);
      Send(MSG_PARAM_SAVE_NVM, FRAME_FLAG_RESPONSE, seq, out, sizeof(out));
      break;
    }

    case MSG_TELEM_SIGNALS:
      OnTelemSignals(seq, payload, payload_len);
      break;

    case MSG_TELEM_SUBSCRIBE:
      OnTelemSubscribe(seq, payload, payload_len);
      break;

    case MSG_SCOPE_CONFIG:
      OnScopeConfig(seq, payload, payload_len);
      break;

    case MSG_SCOPE_ARM:
      OnScopeArm(seq, payload_len);
      break;

    case MSG_SCOPE_STATUS:
      OnScopeStatus(seq, payload_len);
      break;

    case MSG_SCOPE_READ:
      OnScopeRead(seq, payload, payload_len);
      break;

    case MSG_BOOT_ENTER:
#if defined(APP_WITH_BOOTLOADER)
      if (payload_len != 0U) {
        Proto_SendError(MSG_BOOT_ENTER, seq, PROTO_ERR_LEN);
      } else {
        Send(MSG_BOOT_ENTER, FRAME_FLAG_RESPONSE, seq, NULL, 0U);
        s_boot_reset_at = HAL_GetTick() + 50U;
      }
#else
      Proto_SendError(MSG_BOOT_ENTER, seq, PROTO_ERR_STATE);
#endif
      break;

    default:
      s_rx_errors++;
      Proto_SendError(msg_id, seq, PROTO_ERR_ID);
      break;
  }
}
