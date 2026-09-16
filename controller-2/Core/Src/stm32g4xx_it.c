/**
 * @file stm32g4xx_it.c
 * @brief Vecteurs d'interruption.
 */
#include "stm32g4xx_hal.h"
#include "ctrl.h"
#include "drv8304.h"
#include "board.h"

extern PCD_HandleTypeDef hpcd_USB_FS;

void NMI_Handler(void)        { for (;;) { } }
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

/**
 * Boucle de controle 20 kHz.
 *
 * Ecrit a la main plutot que delegue a HAL_ADC_IRQHandler : a cette cadence, la cascade
 * de tests de drapeaux du HAL represente une part non negligeable du budget, et surtout
 * elle rend la duree de l'ISR difficile a raisonner. Ici le chemin est explicite.
 */
void ADC1_2_IRQHandler(void)
{
  if ((ADC1->ISR & ADC_ISR_JEOS) != 0U) {
    ADC1->ISR = ADC_ISR_JEOS;   /* write-1-to-clear */
    Ctrl_Isr();
  }
}

/** nFAULT du DRV8304 sur PB11, front descendant. Coupe le pont, ne parle pas au DRV. */
void EXTI15_10_IRQHandler(void)
{
  if (__HAL_GPIO_EXTI_GET_IT(PIN_DRV_NFAULT) != 0U) {
    __HAL_GPIO_EXTI_CLEAR_IT(PIN_DRV_NFAULT);
    Drv8304_OnFaultIrq();
  }
}

/** Interruption USB. Priorite basse : elle ne doit jamais retarder la boucle de controle. */
void USB_LP_IRQHandler(void)
{
  HAL_PCD_IRQHandler(&hpcd_USB_FS);
}
