/**
 * @file proto.h
 * @brief Canal binaire : traitement des messages. Voir docs/protocol.md §3 a §5.
 *
 * Tourne dans la superloop, jamais depuis une ISR. Les reponses sont poussees dans le tampon
 * d'emission de la liaison ; si celui-ci est plein la reponse est perdue et comptee, jamais
 * tronquee — une demi-trame cote hote est indecodable, alors qu'une trame absente se
 * redemande.
 */
#ifndef COMM_PROTO_H
#define COMM_PROTO_H

#include <stddef.h>
#include <stdint.h>

/* Identifiants de message — docs/protocol.md §3. */
#define MSG_HELLO                 0x0001U
#define MSG_DEVICE_INFO           0x0002U
#define MSG_PARAM_DICT_GET        0x0010U
#define MSG_PARAM_DICT_ENTRY      0x0011U
#define MSG_PARAM_READ            0x0012U
#define MSG_PARAM_WRITE           0x0013U
#define MSG_PARAM_SAVE_NVM        0x0014U
#define MSG_PARAM_RESET_DEFAULTS  0x0015U
#define MSG_TELEM_SIGNALS         0x0040U
#define MSG_TELEM_SUBSCRIBE       0x0041U
#define MSG_TELEM_FRAME           0x0042U
#define MSG_SCOPE_CONFIG          0x0050U
#define MSG_SCOPE_ARM             0x0051U
#define MSG_SCOPE_STATUS          0x0052U
#define MSG_SCOPE_READ            0x0053U
#define MSG_BOOT_ENTER            0x0070U

/* Codes d'erreur — docs/protocol.md §2. */
#define PROTO_ERR_CRC       1U
#define PROTO_ERR_LEN       2U
#define PROTO_ERR_ID        3U
#define PROTO_ERR_ARG       4U
#define PROTO_ERR_RANGE     5U
#define PROTO_ERR_STATE     6U
#define PROTO_ERR_BUSY      7U
#define PROTO_ERR_NOTARMED  8U
#define PROTO_ERR_LOCKED    9U
#define PROTO_ERR_NVM       10U
#define PROTO_ERR_FLASH     11U

/* Bits de `capabilities` du handshake. Une capacite n'est annoncee que lorsqu'elle est
 * reellement implementee : l'interface s'en sert pour griser ce qui n'existe pas. */
#define PROTO_CAP_TELEMETRY   0x00000001U
#define PROTO_CAP_SCOPE       0x00000002U
#define PROTO_CAP_NVM         0x00000004U
#define PROTO_CAP_CAN         0x00000008U
#define PROTO_CAP_BOOTLOADER  0x00000010U
#define PROTO_CAP_ENCODER_INC 0x00000020U

void Proto_Init(void);

/** Tâches asynchrones de communication : télémétrie et notifications de scope. */
void Proto_Process(void);

/** Traite une trame binaire deja validee (COBS decode, CRC verifie). */
void Proto_HandleFrame(uint16_t msg_id, uint8_t flags, uint8_t seq,
                       const uint8_t *payload, uint16_t payload_len);

/** Emet une reponse d'erreur rattachee a `seq`. Exposee pour le routeur, qui doit pouvoir
 *  signaler un CRC faux alors qu'aucun message n'a pu etre identifie. */
void Proto_SendError(uint16_t msg_id, uint8_t seq, uint16_t code);

/** Compteurs de diagnostic, remontes par la console (`PROTO?`). */
uint32_t Proto_RxFrames(void);
uint32_t Proto_RxErrors(void);
uint32_t Proto_TxDropped(void);

#endif /* COMM_PROTO_H */
