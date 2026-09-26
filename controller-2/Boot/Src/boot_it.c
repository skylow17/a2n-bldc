/**
 * @file boot_it.c
 * @brief Vecteurs d'interruption du bootloader.
 *
 * Deux seulement : le tick système et l'USB. Le bootloader n'a ni boucle de contrôle, ni
 * ADC, ni TIM1 — et ce qu'il ne dessert pas, il ne peut pas l'exécuter par accident.
 *
 * Une seule NMI est attendue et rendue : l'erreur ECC double d'une page de métadonnées
 * déchirée par une coupure, acquittée par `BootFlash_OnNmi` — la page est alors lue comme
 * illisible, et l'autre sert. Toute autre NMI, et les fautes, bouclent sur place.
 *
 * Les fautes bouclent sur place plutôt que de redémarrer. Un bootloader qui se relance sur
 * faute rebouclerait indéfiniment sans qu'on puisse l'observer ; arrêté, il se lit au
 * débogueur, et le chien de garde n'est pas armé ici — seulement avant un saut en probation.
 */
#include "stm32g4xx_hal.h"
#include "boot_flash.h"

extern PCD_HandleTypeDef hpcd_USB_FS;

void NMI_Handler(void)        { if (BootFlash_OnNmi()) { return; } for (;;) { } }
void HardFault_Handler(void)  { for (;;) { } }
void MemManage_Handler(void)  { for (;;) { } }
void BusFault_Handler(void)   { for (;;) { } }
void UsageFault_Handler(void) { for (;;) { } }
void SVC_Handler(void)        { }
void DebugMon_Handler(void)   { }
void PendSV_Handler(void)     { }

void SysTick_Handler(void)
{
  HAL_IncTick();
}

void USB_LP_IRQHandler(void)
{
  HAL_PCD_IRQHandler(&hpcd_USB_FS);
}
