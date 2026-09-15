/**
 * @file board_clock.c
 * @brief Arbre d'horloge : HSE 24 MHz → 144 MHz système, 48 MHz USB, 36 MHz ADC.
 */
#include "board_clock.h"
#include "board.h"

/* HSE 24 MHz
 *   /M=2      → 12 MHz    (entrée PLL, plage 2.66–16 MHz)
 *   ×N=24     → 288 MHz   (VCO, plage 96–344 MHz)
 *   /R=2      → 144 MHz   SYSCLK
 *   /Q=6      →  48 MHz   USB
 *   /P=4      →  36 MHz   ADC12
 *
 * 144 MHz tient dans la plage 1 du régulateur sans mode boost ; latence flash 4 WS.
 */
void Board_ClockInit(void)
{
  RCC_OscInitTypeDef       osc  = {0};
  RCC_ClkInitTypeDef       clk  = {0};
  RCC_PeriphCLKInitTypeDef perh = {0};

  HAL_PWREx_ControlVoltageScaling(PWR_REGULATOR_VOLTAGE_SCALE1);

  osc.OscillatorType   = RCC_OSCILLATORTYPE_HSE;
  osc.HSEState         = RCC_HSE_ON;
  osc.PLL.PLLState     = RCC_PLL_ON;
  osc.PLL.PLLSource    = RCC_PLLSOURCE_HSE;
  osc.PLL.PLLM         = RCC_PLLM_DIV2;
  osc.PLL.PLLN         = 24;
  osc.PLL.PLLP         = RCC_PLLP_DIV4;   /* 72 MHz — divisé encore par l'ADC   */
  osc.PLL.PLLQ         = RCC_PLLQ_DIV6;   /* 48 MHz — USB                       */
  osc.PLL.PLLR         = RCC_PLLR_DIV2;   /* 144 MHz — SYSCLK                   */
  if (HAL_RCC_OscConfig(&osc) != HAL_OK) {
    Board_FatalError("rcc");
  }

  clk.ClockType      = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK |
                       RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
  clk.SYSCLKSource   = RCC_SYSCLKSOURCE_PLLCLK;
  clk.AHBCLKDivider  = RCC_SYSCLK_DIV1;   /* HCLK  144 MHz */
  clk.APB1CLKDivider = RCC_HCLK_DIV1;     /* PCLK1 144 MHz */
  clk.APB2CLKDivider = RCC_HCLK_DIV1;     /* PCLK2 144 MHz */
  if (HAL_RCC_ClockConfig(&clk, FLASH_LATENCY_4) != HAL_OK) {
    Board_FatalError("rcc");
  }

  perh.PeriphClockSelection = RCC_PERIPHCLK_USB | RCC_PERIPHCLK_ADC12;
  perh.UsbClockSelection    = RCC_USBCLKSOURCE_PLL;    /* PLLQ = 48 MHz          */
  perh.Adc12ClockSelection  = RCC_ADC12CLKSOURCE_PLL;  /* PLLP = 72 MHz, /2 côté
                                                        * ADC → 36 MHz           */
  if (HAL_RCCEx_PeriphCLKConfig(&perh) != HAL_OK) {
    Board_FatalError("rcc");
  }
}
