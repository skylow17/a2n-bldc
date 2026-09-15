/**
 * @file rx_router.c
 * @brief Demultiplexeur de reception. Voir comm/rx_router.h.
 */
#include "comm/rx_router.h"

#include <string.h>

#include "comm/frame.h"
#include "comm/proto.h"
#include "console.h"
#include "link_usb.h"

/* Le tampon doit accepter la plus grande trame encodee. Une ligne de console est bien plus
 * courte, mais elle partage le meme tampon : un seul message est en cours d'accumulation a
 * la fois, puisqu'il n'est possible d'en terminer un qu'en rencontrant un terminateur. */
#define RX_ACC_MAX  FRAME_ENCODED_MAX

static uint8_t  s_acc[RX_ACC_MAX];
static uint16_t s_len;
static bool     s_overflow;
static uint8_t  s_scratch[FRAME_RAW_MAX];
static uint32_t s_overflows;

void RxRouter_Init(void)
{
  s_len       = 0U;
  s_overflow  = false;
  s_overflows = 0U;
}

uint32_t RxRouter_Overflows(void) { return s_overflows; }

static void OnBinaryFrame(void)
{
  Frame_t f;
  const FrameStatus_t st = Frame_Decode(s_acc, s_len, s_scratch, sizeof(s_scratch), &f);

  switch (st) {
    case FRAME_OK:
      Proto_HandleFrame(f.msg_id, f.flags, f.seq, f.payload, f.payload_len);
      break;

    case FRAME_ERR_CRC:
      /* On connait le seq : il est en clair dans la trame decodee, mais celle-ci n'est
       * justement pas fiable. On repond avec seq = 0 plutot que de citer un octet dont on
       * vient d'etablir qu'il est suspect. */
      Proto_SendError(0U, 0U, PROTO_ERR_CRC);
      break;

    case FRAME_ERR_COBS:
    case FRAME_ERR_LEN:
    default:
      Proto_SendError(0U, 0U, PROTO_ERR_LEN);
      break;
  }
}

static void OnAsciiLine(void)
{
  /* La console travaille sur une chaine C ; il reste toujours au moins une place libre,
   * puisqu'un depassement est detecte avant d'atteindre RX_ACC_MAX. */
  s_acc[s_len] = 0U;
  Console_ExecuteLine((const char *)s_acc);
}

void RxRouter_Process(void)
{
  uint8_t  chunk[64];
  uint16_t n;

  while ((n = Link_RxRead(chunk, sizeof(chunk))) > 0U) {
    for (uint16_t i = 0U; i < n; i++) {
      const uint8_t c = chunk[i];
      const bool    is_terminator = (c == 0x00U) || (c == (uint8_t)'\r') || (c == (uint8_t)'\n');

      if (!is_terminator) {
        if (s_len >= (RX_ACC_MAX - 1U)) {
          /* On continue de consommer jusqu'au terminateur plutot que de couper : le
           * message suivant ne doit pas heriter d'un reste du precedent. */
          if (!s_overflow) {
            s_overflow = true;
            s_overflows++;
          }
        } else {
          s_acc[s_len++] = c;
        }
        continue;
      }

      if (s_overflow) {
        if (c == 0x00U) {
          Proto_SendError(0U, 0U, PROTO_ERR_LEN);
        } else {
          Console_ReplyOverflow();
        }
      } else if (s_len > 0U) {
        if (c == 0x00U) {
          OnBinaryFrame();
        } else {
          OnAsciiLine();
        }
      }
      /* Un terminateur isole (ligne vide, ou le \n d'un \r\n) ne declenche rien. */

      s_len      = 0U;
      s_overflow = false;
    }
  }
}
