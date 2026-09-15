/**
 * @file dbg_pin.c
 * @brief Broche d'instrumentation IO1 / PC14, sortie sur J7 broche 5.
 */
#include "dbg_pin.h"

void DbgPin_Init(void)
{
  GPIO_InitTypeDef g = {0};

  __HAL_RCC_GPIOC_CLK_ENABLE();

  g.Pin   = PIN_DBG;
  g.Mode  = GPIO_MODE_OUTPUT_PP;
  g.Pull  = GPIO_NOPULL;
  /* PC14 est dans le domaine sauvegarde : sa vitesse de sortie est de toute facon
   * plafonnee. Demander VERY_HIGH ne nuit pas et donne le front le plus raide possible. */
  g.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
  HAL_GPIO_Init(PIN_DBG_PORT, &g);

  DbgPin_Low();
}
