/**
 * @file boot_proto.h
 * @brief Canal binaire du bootloader — `../../../docs/protocol.md` §8.
 *
 * Même framing que l'application (§2), six messages et rien d'autre : ni paramètres, ni
 * télémétrie, ni commande moteur. Ce que le bootloader n'implémente pas, il ne peut pas le
 * faire par accident.
 */
#ifndef BOOT_PROTO_H
#define BOOT_PROTO_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void BootProto_Init(void);

/** Traite une trame déjà validée (COBS décodé, CRC vérifié). */
void BootProto_HandleFrame(uint16_t msg_id, uint8_t flags, uint8_t seq,
                           const uint8_t *payload, uint16_t payload_len);

/** Émet une erreur rattachée à `seq`. Exposée pour le routeur, qui doit pouvoir signaler
 *  un CRC faux alors qu'aucun message n'a pu être identifié. */
void BootProto_SendError(uint16_t msg_id, uint8_t seq, uint16_t code);

/**
 * @brief Tâches différées. À appeler dans la superloop.
 *
 * Porte le redémarrage de `BOOT_REBOOT` : la réponse part d'abord, puis 50 ms s'écoulent
 * sans qu'aucune opération flash ne soit acceptée, et seulement ensuite le reset. Redémarrer
 * tout de suite couperait la réponse au milieu de son passage sur l'USB, et l'hôte ne saurait
 * pas si son ordre a été reçu.
 */
void BootProto_Process(void);

#ifdef __cplusplus
}
#endif
#endif /* BOOT_PROTO_H */
