/**
 * @file link_usb.h
 * @brief Liaison USB CDC — émission non bloquante.
 *
 * Le v1 transmettait en attente active sur `CDC_Transmit_FS` jusqu'à ce que l'hôte ait
 * vidé le tampon. Une superloop qui porte aussi la supervision ne peut pas se le permettre,
 * et ce sera encore moins vrai quand la télémétrie poussera à 500 Hz. Ici tout passe par
 * des tampons circulaires : `Link_TxWrite` rend la main immédiatement, et `Link_Pump`
 * écoule ce qui peut l'être à chaque tour de boucle.
 *
 * Rien dans ce module n'est appelé depuis l'ISR de contrôle.
 */
#ifndef LINK_USB_H
#define LINK_USB_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LINK_RX_SIZE  512U
#define LINK_TX_SIZE  2048U

void Link_Init(void);

/** À appeler à chaque tour de superloop. Écoule le tampon d'émission vers l'USB. */
void Link_Pump(void);

/** Empile des octets à émettre. Retourne false si le tampon est plein : dans ce cas rien
 *  n'est écrit du tout, on ne tronque pas une trame au milieu. */
bool Link_TxWrite(const void *data, uint16_t len);

/** Variante texte. Limitée à 160 caractères par appel. */
bool Link_TxPrintf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

/** Dépile jusqu'à @p max octets reçus. Retourne le nombre réellement lu. */
uint16_t Link_RxRead(uint8_t *dst, uint16_t max);

/** Octets perdus faute de place, depuis le démarrage. Une valeur non nulle signale que
 *  l'hôte ne lit pas assez vite ou que le firmware écrit trop. */
uint32_t Link_TxDropped(void);
uint32_t Link_RxDropped(void);

/** Alimenté par la couche CDC, en contexte interruption USB. Pas d'appel direct. */
void Link_OnRxFromUsb(const uint8_t *data, uint16_t len);
void Link_OnTxComplete(void);

#ifdef __cplusplus
}
#endif
#endif /* LINK_USB_H */
