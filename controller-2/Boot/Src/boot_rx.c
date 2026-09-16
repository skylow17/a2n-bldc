/**
 * @file boot_rx.c
 * @brief Réception du bootloader : canal binaire seul.
 *
 * L'application démultiplexe deux canaux sur le même lien (`comm/rx_router.c`). Le
 * bootloader n'a pas de console : il n'y a rien à interroger, rien à régler, et une ligne de
 * texte pendant une mise à jour ne peut être qu'un émetteur désynchronisé. Tout ce qui ne
 * commence pas par `FRAME_SOH` est donc jeté jusqu'au prochain délimiteur.
 *
 * Ce fichier existe plutôt qu'une réutilisation de `rx_router.c` parce que celui-ci tire la
 * console, qui tire les paramètres, qui tirent le dictionnaire — soit la moitié de
 * l'application dans une image de 32 ko.
 */

#include "boot_rx.h"

#include "boot_proto.h"
#include "comm/frame.h"
#include "comm/proto.h"
#include "link_usb.h"

typedef enum
{
  RX_IDLE = 0,  /* entre deux messages */
  RX_BINARY,    /* trame COBS en cours, délimiteur 0x00 attendu */
  RX_SKIP,      /* octets sans intérêt, on attend le prochain délimiteur */
} RxState_t;

static RxState_t s_state;
static uint8_t   s_acc[FRAME_ENCODED_MAX];
static uint16_t  s_len;
static bool      s_overflow;
static uint8_t   s_scratch[FRAME_RAW_MAX];

void BootRx_Init(void)
{
  s_state = RX_IDLE;
  s_len = 0U;
  s_overflow = false;
}

static void OnFrame(void)
{
  Frame_t f;
  const FrameStatus_t st = Frame_Decode(s_acc, s_len, s_scratch, sizeof(s_scratch), &f);

  switch (st) {
    case FRAME_OK:
      BootProto_HandleFrame(f.msg_id, f.flags, f.seq, f.payload, f.payload_len);
      break;

    case FRAME_ERR_CRC:
      /* Le `seq` est lisible dans la trame décodée, mais celle-ci vient d'être déclarée non
       * fiable. On répond avec 0 plutôt que de citer un octet dont on sait qu'il est
       * suspect. Pendant une mise à jour, ce détail décide si l'hôte réémet le bon bloc. */
      BootProto_SendError(0U, 0U, PROTO_ERR_CRC);
      break;

    case FRAME_ERR_COBS:
    case FRAME_ERR_LEN:
    default:
      BootProto_SendError(0U, 0U, PROTO_ERR_LEN);
      break;
  }
}

static void Reset(void)
{
  s_state = RX_IDLE;
  s_len = 0U;
  s_overflow = false;
}

void BootRx_Process(void)
{
  uint8_t  chunk[64];
  uint16_t n;

  while ((n = Link_RxRead(chunk, sizeof(chunk))) > 0U) {
    for (uint16_t i = 0U; i < n; i++) {
      const uint8_t c = chunk[i];

      switch (s_state) {
        case RX_IDLE:
          if (c == FRAME_SOH) {
            s_state = RX_BINARY;
          } else if (c != 0x00U) {
            /* Ni une trame, ni un délimiteur isolé : on ignore jusqu'au prochain 0x00,
             * pour que la trame suivante ne commence pas au milieu de celle-ci. */
            s_state = RX_SKIP;
          } else {
            /* délimiteur isolé : reste d'un message précédent */
          }
          break;

        case RX_BINARY:
          if (c == 0x00U) {
            if (s_overflow) {
              BootProto_SendError(0U, 0U, PROTO_ERR_LEN);
            } else if (s_len > 0U) {
              OnFrame();
            }
            Reset();
          } else if (s_len >= (uint16_t)sizeof(s_acc)) {
            s_overflow = true;
          } else {
            s_acc[s_len++] = c;
          }
          break;

        case RX_SKIP:
        default:
          if (c == 0x00U) {
            Reset();
          }
          break;
      }
    }
  }
}
