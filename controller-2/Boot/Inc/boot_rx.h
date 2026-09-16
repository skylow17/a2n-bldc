/**
 * @file boot_rx.h
 * @brief Réception du bootloader : canal binaire seul. Voir boot_rx.c.
 */
#ifndef BOOT_RX_H
#define BOOT_RX_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void BootRx_Init(void);

/** À appeler dans la superloop. Consomme ce que la liaison a reçu. */
void BootRx_Process(void);

#ifdef __cplusplus
}
#endif
#endif /* BOOT_RX_H */
