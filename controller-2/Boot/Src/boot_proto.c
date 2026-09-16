/**
 * @file boot_proto.c
 * @brief Les six messages du bootloader. Voir boot_proto.h.
 *
 * Chaque handler suit le même ordre : longueur, désérialisation, règle métier
 * (`boot_flash.c`), puis seulement l'accès flash. Les contrôles vivent dans `boot_flash.c`
 * parce qu'ils s'y testent hors cible ; ce fichier n'est qu'un aiguillage, et c'est
 * délibéré — il ne décide rien qu'on ne puisse vérifier ailleurs.
 */

#include "boot_proto.h"

#include <string.h>

#include "stm32g4xx_hal.h"

#include "boot_flash.h"
#include "comm/frame.h"
#include "comm/proto.h"
#include "link_usb.h"

/** Version du bootloader, telle qu'elle remonte dans `BOOT_INFO`. */
#define BOOT_VERSION_STRING  "boot-1.0.0"

/** Délai de vidage avant le reset de `BOOT_REBOOT` — spec §8. */
#define BOOT_REBOOT_FLUSH_MS  50U

static uint8_t       s_tx[FRAME_ENCODED_MAX];
static uint8_t       s_payload[BOOT_WIRE_INFO_LEN];
static BootSession_t s_session;

/** Un `BOOT_REBOOT` a été accepté : plus aucune opération flash, reset à l'échéance. */
static bool     s_reboot_pending;
static uint32_t s_reboot_deadline;

void BootProto_Init(void)
{
  (void)memset(&s_session, 0, sizeof(s_session));
  s_reboot_pending = false;
}

static void Send(uint16_t msg_id, uint8_t flags, uint8_t seq, const void *payload, uint16_t len)
{
  const size_t n = Frame_Encode(msg_id, flags, seq, payload, len, s_tx, sizeof(s_tx));
  if (n == 0U) {
    return;
  }
  (void)Link_TxWrite(s_tx, (uint16_t)n);
}

void BootProto_SendError(uint16_t msg_id, uint8_t seq, uint16_t code)
{
  uint8_t p[2];
  Frame_PutU16(p, code);
  Send(msg_id, FRAME_FLAG_RESPONSE | FRAME_FLAG_ERROR, seq, p, sizeof(p));
}

static void SendOk(uint16_t msg_id, uint8_t seq, const void *payload, uint16_t len)
{
  Send(msg_id, FRAME_FLAG_RESPONSE, seq, payload, len);
}

/**
 * @brief Écrit les métadonnées modifiées, et répond à la place de l'appelant si ça échoue.
 *
 * Une mise à jour de métadonnées qui échoue laisse la carte cohérente — l'ancienne page est
 * intacte — mais l'hôte doit l'apprendre, sinon il croira son candidat enregistré.
 */
static bool Commit(BootMeta_t *meta, uint16_t msg_id, uint8_t seq)
{
  if (BootFlash_CommitMeta(meta)) {
    return true;
  }
  BootProto_SendError(msg_id, seq, PROTO_ERR_FLASH);
  return false;
}

/* ------------------------------------------------------------------ handlers */

static void OnInfo(uint8_t seq)
{
  BootFlash_EncodeInfo(BootFlash_Meta(), BOOT_VERSION_STRING, s_payload);
  SendOk(MSG_BOOT_INFO, seq, s_payload, BOOT_WIRE_INFO_LEN);
}

static void OnErase(uint8_t seq, const uint8_t *p, uint16_t len)
{
  if (len != 4U) {
    BootProto_SendError(MSG_BOOT_ERASE, seq, PROTO_ERR_LEN);
    return;
  }
  const uint8_t slot = p[0];
  const uint8_t err = BootFlash_CheckErase(BootFlash_Meta(), slot);
  if (err != 0U) {
    BootProto_SendError(MSG_BOOT_ERASE, seq, err);
    return;
  }
  if (!BootFlash_Erase(slot)) {
    BootProto_SendError(MSG_BOOT_ERASE, seq, PROTO_ERR_FLASH);
    return;
  }

  /* L'effacement invalide ce que les métadonnées disaient du slot : laisser `valid` posé
   * signifierait qu'une image vérifiée s'y trouve encore. Si ce slot était le candidat, il
   * ne l'est plus — on vient d'effacer ce qui devait être essayé. */
  BootMeta_t meta = *BootFlash_Meta();
  (void)memset(&meta.slot[slot], 0, sizeof(meta.slot[slot]));
  if (meta.candidate_slot == slot) {
    (void)BootMeta_ClearCandidate(&meta);
  }
  if (!Commit(&meta, MSG_BOOT_ERASE, seq)) {
    return;
  }

  s_session.erased[slot] = true;
  s_session.written_max[slot] = 0U;

  uint8_t r[4] = {slot, 0U, 0U, 0U};
  SendOk(MSG_BOOT_ERASE, seq, r, sizeof(r));
}

static void OnWrite(uint8_t seq, const uint8_t *p, uint16_t len)
{
  if (len < 8U) {
    BootProto_SendError(MSG_BOOT_WRITE, seq, PROTO_ERR_LEN);
    return;
  }

  BootWriteReq_t req;
  req.slot = p[0];
  req.data_len = Frame_GetU16(&p[2]);
  req.offset = Frame_GetU32(&p[4]);

  /* La longueur annoncée doit correspondre à ce qui est réellement arrivé. Sans ce
   * contrôle, un `data_len` menteur ferait programmer ce qui traîne après le payload. */
  if ((uint32_t)len != ((uint32_t)req.data_len + 8U)) {
    BootProto_SendError(MSG_BOOT_WRITE, seq, PROTO_ERR_LEN);
    return;
  }

  const uint8_t err = BootFlash_CheckWrite(BootFlash_Meta(), &s_session, &req);
  if (err != 0U) {
    BootProto_SendError(MSG_BOOT_WRITE, seq, err);
    return;
  }
  if (!BootFlash_Program(req.slot, req.offset, &p[8], req.data_len)) {
    BootProto_SendError(MSG_BOOT_WRITE, seq, PROTO_ERR_FLASH);
    return;
  }

  const uint32_t end = req.offset + req.data_len;
  if (end > s_session.written_max[req.slot]) {
    s_session.written_max[req.slot] = end;
  }

  SendOk(MSG_BOOT_WRITE, seq, p, 8U);
}

static void OnVerify(uint8_t seq, const uint8_t *p, uint16_t len)
{
  if (len != 28U) {
    BootProto_SendError(MSG_BOOT_VERIFY, seq, PROTO_ERR_LEN);
    return;
  }

  BootVerifyReq_t req;
  req.slot = p[0];
  req.image_size = Frame_GetU32(&p[4]);
  req.expected_crc32 = Frame_GetU32(&p[8]);

  const uint8_t err = BootFlash_CheckVerify(BootFlash_Meta(), &s_session, &req);
  if (err != 0U) {
    BootProto_SendError(MSG_BOOT_VERIFY, seq, err);
    return;
  }
  if (!BootFlash_Verify(req.slot, req.image_size, req.expected_crc32)) {
    /* `ERR_FLASH` et non `ERR_CRC` : ce dernier désigne une trame corrompue sur le lien, et
     * l'hôte la réémettrait. Ici la trame est arrivée intacte — c'est l'image en flash qui
     * ne correspond pas, et la réémettre ne servirait à rien. Le simulateur répond pareil. */
    BootProto_SendError(MSG_BOOT_VERIFY, seq, PROTO_ERR_FLASH);
    return;
  }

  /* La version voyage sans terminaison garantie : on la recopie bornée avant de la passer
   * à une fonction qui attend une chaîne. */
  char version[BOOT_VERSION_LEN + 1U];
  (void)memcpy(version, &p[12], BOOT_VERSION_LEN);
  version[BOOT_VERSION_LEN] = '\0';

  BootMeta_t meta = *BootFlash_Meta();
  BootMeta_SetCandidate(&meta, req.slot, req.image_size, req.expected_crc32, version);
  if (!Commit(&meta, MSG_BOOT_VERIFY, seq)) {
    return;
  }

  SendOk(MSG_BOOT_VERIFY, seq, NULL, 0U);
}

static void OnRollback(uint8_t seq, uint16_t len)
{
  if (len != 0U) {
    BootProto_SendError(MSG_BOOT_ROLLBACK, seq, PROTO_ERR_LEN);
    return;
  }

  BootMeta_t meta = *BootFlash_Meta();
  if (!BootMeta_ClearCandidate(&meta)) {
    BootProto_SendError(MSG_BOOT_ROLLBACK, seq, PROTO_ERR_STATE);
    return;
  }
  if (!Commit(&meta, MSG_BOOT_ROLLBACK, seq)) {
    return;
  }
  SendOk(MSG_BOOT_ROLLBACK, seq, NULL, 0U);
}

static void OnReboot(uint8_t seq, uint16_t len)
{
  if (len != 0U) {
    BootProto_SendError(MSG_BOOT_REBOOT, seq, PROTO_ERR_LEN);
    return;
  }
  SendOk(MSG_BOOT_REBOOT, seq, NULL, 0U);

  /* Échéance dans le futur et comparaison signée, comme `proto.c` côté application. La
   * première version stockait l'instant courant forcé impair (`| 1U`) pour le distinguer
   * de « rien en cours » ; sur un tick pair, cela plaçait l'instant 1 ms *après* maintenant,
   * la soustraction non signée débordait et la carte se réinitialisait avant d'avoir vidé
   * sa réponse — une fois sur deux, exactement. Trouvé sur carte, pas en relecture. */
  s_reboot_pending  = true;
  s_reboot_deadline = HAL_GetTick() + BOOT_REBOOT_FLUSH_MS;
}

/* ------------------------------------------------------------------ aiguillage */

void BootProto_HandleFrame(uint16_t msg_id, uint8_t flags, uint8_t seq,
                           const uint8_t *payload, uint16_t payload_len)
{
  /* Une réponse qui revient vers le firmware n'a pas de sens : l'hôte parle, le firmware
   * répond. On l'ignore plutôt que d'y répondre, pour ne pas entretenir une boucle. */
  if ((flags & FRAME_FLAG_RESPONSE) != 0U) {
    return;
  }

  /* Un reboot est en cours : la spec interdit toute autre opération flash pendant le délai
   * de vidage. Refuser explicitement vaut mieux qu'accepter une écriture qu'un reset
   * coupera en deux. */
  if (s_reboot_pending) {
    BootProto_SendError(msg_id, seq, PROTO_ERR_BUSY);
    return;
  }

  switch (msg_id) {
    case MSG_BOOT_INFO:     OnInfo(seq); break;
    case MSG_BOOT_ERASE:    OnErase(seq, payload, payload_len); break;
    case MSG_BOOT_WRITE:    OnWrite(seq, payload, payload_len); break;
    case MSG_BOOT_VERIFY:   OnVerify(seq, payload, payload_len); break;
    case MSG_BOOT_ROLLBACK: OnRollback(seq, payload_len); break;
    case MSG_BOOT_REBOOT:   OnReboot(seq, payload_len); break;

    /* Tout le reste — paramètres, télémétrie, moteur — existe dans l'application et pas
     * ici. `ERR_ID` le dit franchement ; un silence laisserait l'hôte croire à une carte
     * muette plutôt qu'à un bootloader. */
    default:
      BootProto_SendError(msg_id, seq, PROTO_ERR_ID);
      break;
  }
}

void BootProto_Process(void)
{
  if (!s_reboot_pending) {
    return;
  }
  if ((int32_t)(HAL_GetTick() - s_reboot_deadline) < 0) {
    return;
  }
  NVIC_SystemReset();
}
