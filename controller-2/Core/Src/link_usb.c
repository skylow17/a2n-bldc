/**
 * @file link_usb.c
 * @brief Liaison USB CDC — tampons circulaires, émission non bloquante.
 */
#include "link_usb.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "usbd_cdc_if.h"
#include "usbd_def.h"

/* Un paquet USB full-speed fait 64 octets. Si un transfert fait exactement la taille du
 * paquet, l'hôte attend un paquet de longueur nulle pour savoir que c'est fini. On plafonne
 * donc à 63 octets : la question ne se pose jamais, pour un coût de débit négligeable. */
#define LINK_CHUNK  63U

typedef struct
{
  uint8_t           buf[LINK_TX_SIZE];
  volatile uint16_t head;
  volatile uint16_t tail;
} TxRing_t;

typedef struct
{
  uint8_t           buf[LINK_RX_SIZE];
  volatile uint16_t head;
  volatile uint16_t tail;
} RxRing_t;

static TxRing_t s_tx;
static RxRing_t s_rx;
static uint8_t  s_chunk[LINK_CHUNK];
static volatile bool     s_tx_busy;
static volatile uint32_t s_tx_dropped;
static volatile uint32_t s_rx_dropped;

static inline uint16_t TxUsed(void)
{
  /* En uint32_t : sinon la promotion entiere rend une branche signee et l'autre non. */
  const uint32_t h = s_tx.head, t = s_tx.tail;
  return (uint16_t)((h >= t) ? (h - t) : (LINK_TX_SIZE - t + h));
}

static inline uint16_t TxFree(void)
{
  /* Une case reste toujours libre pour distinguer plein de vide. */
  return (uint16_t)(LINK_TX_SIZE - 1U - TxUsed());
}

void Link_Init(void)
{
  s_tx.head = s_tx.tail = 0U;
  s_rx.head = s_rx.tail = 0U;
  s_tx_busy = false;
  s_tx_dropped = 0U;
  s_rx_dropped = 0U;
}

bool Link_TxWrite(const void *data, uint16_t len)
{
  const uint8_t *p = (const uint8_t *)data;

  if ((p == NULL) || (len == 0U)) {
    return true;
  }
  /* Tout ou rien : une trame à moitié écrite serait indécodable côté hôte, et une ligne
   * de console tronquée est pire qu'une ligne absente. */
  if (len > TxFree()) {
    s_tx_dropped += len;
    return false;
  }

  uint16_t h = s_tx.head;
  for (uint16_t i = 0U; i < len; i++) {
    s_tx.buf[h] = p[i];
    h = (uint16_t)((h + 1U) % LINK_TX_SIZE);
  }
  s_tx.head = h;
  return true;
}

bool Link_TxPrintf(const char *fmt, ...)
{
  char    line[160];
  va_list ap;

  va_start(ap, fmt);
  const int n = vsnprintf(line, sizeof(line), fmt, ap);
  va_end(ap);

  if (n <= 0) {
    return false;
  }
  const uint16_t len = (uint16_t)((n >= (int)sizeof(line)) ? (sizeof(line) - 1U) : (size_t)n);
  return Link_TxWrite(line, len);
}

void Link_Pump(void)
{
  if (s_tx_busy) {
    return;
  }
  const uint16_t used = TxUsed();
  if (used == 0U) {
    return;
  }

  uint16_t n = (used > LINK_CHUNK) ? LINK_CHUNK : used;
  uint16_t t = s_tx.tail;
  for (uint16_t i = 0U; i < n; i++) {
    s_chunk[i] = s_tx.buf[t];
    t = (uint16_t)((t + 1U) % LINK_TX_SIZE);
  }

  /* On ne fait pas avancer la queue avant d'être sûr que le transfert est accepté :
   * si l'USB refuse, les octets restent dans le tampon et repartiront au tour suivant. */
  s_tx_busy = true;
  if (CDC_Transmit_FS(s_chunk, n) != USBD_OK) {
    s_tx_busy = false;
    return;
  }
  s_tx.tail = t;
}

void Link_OnTxComplete(void)
{
  s_tx_busy = false;
}

void Link_OnRxFromUsb(const uint8_t *data, uint16_t len)
{
  if ((data == NULL) || (len == 0U)) {
    return;
  }
  for (uint16_t i = 0U; i < len; i++) {
    const uint16_t next = (uint16_t)((s_rx.head + 1U) % LINK_RX_SIZE);
    if (next == s_rx.tail) {
      s_rx_dropped++;
      continue;
    }
    s_rx.buf[s_rx.head] = data[i];
    s_rx.head = next;
  }
}

uint16_t Link_RxRead(uint8_t *dst, uint16_t max)
{
  uint16_t n = 0U;
  while ((n < max) && (s_rx.tail != s_rx.head)) {
    dst[n++]  = s_rx.buf[s_rx.tail];
    s_rx.tail = (uint16_t)((s_rx.tail + 1U) % LINK_RX_SIZE);
  }
  return n;
}

uint32_t Link_TxDropped(void) { return s_tx_dropped; }
uint32_t Link_RxDropped(void) { return s_rx_dropped; }

/* ---------------------------------------------------------------- présence de l'hôte */

/* Écrits depuis l'interruption USB, lus depuis la boucle principale : deux booléens,
 * chacun atomique, et la conjonction se recalcule à chaque lecture. */
static volatile bool s_dtr;
static volatile bool s_suspended;

bool Link_HostAttached(void)
{
  return s_dtr && !s_suspended;
}

void Link_OnControlLineState(bool dtr)
{
  s_dtr = dtr;
}

void Link_OnBusSuspend(void)
{
  s_suspended = true;
}

void Link_OnBusResume(void)
{
  s_suspended = false;
}
