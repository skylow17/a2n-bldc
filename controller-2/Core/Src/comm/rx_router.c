/**
 * @file rx_router.c
 * @brief Demultiplexeur de reception. Voir comm/rx_router.h.
 */
#include "comm/rx_router.h"

#include "safety.h"

#include <string.h>

#include "comm/frame.h"
#include "comm/proto.h"
#include "console.h"
#include "link_usb.h"

/* Le tampon doit accepter la plus grande trame encodee. Une ligne de console est bien plus
 * courte, mais elle partage le meme tampon : un seul message est en cours d'accumulation a
 * la fois, puisqu'on ne peut en terminer un qu'en rencontrant son terminateur. */
#define RX_ACC_MAX  FRAME_ENCODED_MAX

typedef enum
{
  RX_IDLE = 0,   /* entre deux messages : le prochain octet decide du canal */
  RX_BINARY,     /* trame COBS en cours, terminateur attendu : 0x00 */
  RX_ASCII,      /* ligne de console en cours, terminateur attendu : CR ou LF */
} RxState_t;

static RxState_t s_state;
static uint8_t   s_acc[RX_ACC_MAX];
static uint16_t  s_len;
static bool      s_overflow;
static uint8_t   s_scratch[FRAME_RAW_MAX];
static uint32_t  s_overflows;

void RxRouter_Init(void)
{
  s_state     = RX_IDLE;
  s_len       = 0U;
  s_overflow  = false;
  s_overflows = 0U;
}

uint32_t RxRouter_Overflows(void) { return s_overflows; }

static void OnBinaryFrame(void)
{
  Frame_t f;

  /* Avant le decodage : ce qui prouve qu'un hote est vivant, c'est qu'il emette, pas
   * qu'il emette juste. Une trame au CRC casse compte donc aussi. */
  Safety_NoteCommand();
  const FrameStatus_t st = Frame_Decode(s_acc, s_len, s_scratch, sizeof(s_scratch), &f);

  switch (st) {
    case FRAME_OK:
      Proto_HandleFrame(f.msg_id, f.flags, f.seq, f.payload, f.payload_len);
      break;

    case FRAME_ERR_CRC:
      /* Le seq figure en clair dans la trame decodee, mais celle-ci vient precisement
       * d'etre declaree non fiable. On repond avec seq = 0 plutot que de citer un octet
       * dont on sait qu'il est suspect. */
      Proto_SendError(0U, 0U, PROTO_ERR_CRC);
      break;

    case FRAME_ERR_COBS:
    case FRAME_ERR_LEN:
    default:
      Proto_SendError(0U, 0U, PROTO_ERR_LEN);
      break;
  }
}

static void Reset(void)
{
  s_state    = RX_IDLE;
  s_len      = 0U;
  s_overflow = false;
}

static void NoteOverflow(void)
{
  if (!s_overflow) {
    s_overflow = true;
    s_overflows++;
  }
}

void RxRouter_Process(void)
{
  uint8_t  chunk[64];
  uint16_t n;

  while ((n = Link_RxRead(chunk, sizeof(chunk))) > 0U) {
    for (uint16_t i = 0U; i < n; i++) {
      const uint8_t c = chunk[i];

      switch (s_state) {
        case RX_IDLE:
          /* C'est ici, et seulement ici, que le canal est choisi : sur le premier octet
           * du message. Se fier au terminateur ne marche pas — COBS exclut 0x00 de la
           * trame encodee, mais pas 0x0A ni 0x0D. */
          if (c == FRAME_SOH) {
            s_state = RX_BINARY;
          } else if ((c == (uint8_t)'\r') || (c == (uint8_t)'\n') || (c == 0x00U)) {
            /* Terminateur isole : reste d'un message precedent, ou ligne vide. */
          } else {
            s_state    = RX_ASCII;
            s_acc[0]   = c;
            s_len      = 1U;
          }
          break;

        case RX_BINARY:
          if (c == 0x00U) {
            if (s_overflow) {
              Proto_SendError(0U, 0U, PROTO_ERR_LEN);
            } else if (s_len > 0U) {
              OnBinaryFrame();
            }
            Reset();
          } else if (s_len >= RX_ACC_MAX) {
            /* On continue de consommer jusqu'au delimiteur plutot que de couper : la
             * trame suivante ne doit pas heriter d'un reste de celle-ci. */
            NoteOverflow();
          } else {
            s_acc[s_len++] = c;
          }
          break;

        case RX_ASCII:
        default:
          if ((c == (uint8_t)'\r') || (c == (uint8_t)'\n')) {
            if (s_overflow) {
              Console_ReplyOverflow();
            } else {
              s_acc[s_len] = 0U;
              Safety_NoteCommand();
              Console_ExecuteLine((const char *)s_acc);
            }
            Reset();
          } else if (c == 0x00U) {
            /* Un 0x00 ne peut pas appartenir a une ligne de texte : l'emetteur s'est
             * desynchronise. On abandonne la ligne et on repart propre. */
            Console_ReplyOverflow();
            Reset();
          } else if (s_len >= (RX_ACC_MAX - 1U)) {
            NoteOverflow();
          } else {
            s_acc[s_len++] = c;
          }
          break;
      }
    }
  }
}
