/**
 * @file main.c
 * @brief a2n-bldc-controller-2 — point d'entrée.
 *
 * Étape M0 : squelette temps réel seul.
 *
 * Ordre d'initialisation imposé par la sécurité de l'étage de puissance :
 * les sorties PWM sont mises en haute impédance avant tout le reste, et elles y restent.
 * Le compteur de TIM1 et le déclenchement de l'ADC tournent, donc la boucle 20 kHz
 * s'exécute, mais aucun transistor n'est piloté : la mesure de M0 se fait moteur
 * strictement au repos.
 */
#include "board.h"
#include "board_clock.h"
#include "ctrl.h"
#include "dbg_pin.h"
#include "pwm.h"
#include "adc_sync.h"

void Board_FatalError(const char *what)
{
  (void)what;
  /* Sécurité d'abord : couper le pont avant d'arrêter le processeur. Si l'erreur survient
   * après Pwm_Init(), MOE peut être actif ; on ne laisse pas un bras en conduction. */
  Pwm_Disable();
  __disable_irq();
  for (;;) {
    __NOP();
  }
}

int main(void)
{
  HAL_Init();
  Board_ClockInit();

  DbgPin_Init();
  Ctrl_Init();

  Pwm_Init();       /* TIM1 démarre, MOE = 0 : sorties en haute impédance   */
  AdcSync_Init();   /* conversions injectées armées sur TIM1_TRGO, ISR 20 kHz */

  for (;;) {
    /* La superloop est vide, et c'est le point de l'étape M0.
     *
     * Dans le v1, cette boucle portait la lecture I2C bloquante de l'AS5600, le parsing
     * des commandes et l'acquisition des courants, ce qui plafonnait l'ensemble à environ
     * 1,5 kHz avec de la gigue. Rien de ce dont la boucle de contrôle dépend ne doit
     * revenir ici : supervision, communication et console viendront s'y installer, mais
     * la régulation vit dans l'ISR, et seulement là.
     */
    __WFI();
  }
}
