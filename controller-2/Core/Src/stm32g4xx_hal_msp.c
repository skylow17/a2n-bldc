/**
 * @file stm32g4xx_hal_msp.c
 * @brief Initialisation bas niveau des peripheriques : horloges et broches.
 */
#include "stm32g4xx_hal.h"
#include "board.h"

void HAL_MspInit(void)
{
  __HAL_RCC_SYSCFG_CLK_ENABLE();
  __HAL_RCC_PWR_CLK_ENABLE();
}

void HAL_TIM_PWM_MspInit(TIM_HandleTypeDef *htim)
{
  if (htim->Instance != TIM1) {
    return;
  }
  GPIO_InitTypeDef g = {0};

  __HAL_RCC_TIM1_CLK_ENABLE();
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();

  g.Mode      = GPIO_MODE_AF_PP;
  g.Pull      = GPIO_NOPULL;
  g.Speed     = GPIO_SPEED_FREQ_VERY_HIGH;
  g.Alternate = GPIO_AF6_TIM1;

  g.Pin = PIN_PWM1P | PIN_PWM2P | PIN_PWM3P;          /* PA8, PA9, PA10 */
  HAL_GPIO_Init(GPIOA, &g);

  g.Pin = PIN_PWM2N | PIN_PWM3N;                      /* PB0, PB1       */
  HAL_GPIO_Init(GPIOB, &g);

  /* PC13 porte CH1N en AF4, et non AF6 comme les autres sorties. */
  g.Pin       = PIN_PWM1N;
  g.Alternate = GPIO_AF4_TIM1;
  HAL_GPIO_Init(GPIOC, &g);
}

void HAL_ADC_MspInit(ADC_HandleTypeDef *hadc)
{
  if (hadc->Instance != ADC1) {
    return;
  }
  GPIO_InitTypeDef g = {0};

  __HAL_RCC_ADC12_CLK_ENABLE();
  __HAL_RCC_GPIOA_CLK_ENABLE();

  g.Pin  = PIN_IMOTA | PIN_IMOTB | PIN_IMOTC;         /* PA0, PA1, PA2 */
  g.Mode = GPIO_MODE_ANALOG;
  g.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(GPIOA, &g);
}
