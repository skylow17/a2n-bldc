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
#include <stdint.h>

#include "board.h"
#include "board_clock.h"
#include "boot_shared.h"
#include "ctrl.h"
#include "dbg_pin.h"
#include "drv8304.h"
#include "pwm.h"
#include "adc_sync.h"
#include "comm/param.h"
#include "comm/proto.h"
#include "comm/rx_router.h"
#include "comm/scope.h"
#include "console.h"
#include "link_usb.h"
#include "usb_device.h"

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

/* --- Adaptateurs pour la pile USB de ST ---------------------------------------------
 * usb_device.c et usbd_conf.c sont du code CubeMX inchange : ils attendent les deux
 * symboles que le main genere fournit d'habitude. On les branche sur les notres plutot
 * que de modifier du code tiers, qui devra pouvoir etre remplace tel quel.
 */
void Error_Handler(void)
{
  Board_FatalError("usb");
}

void SystemClock_Config(void)
{
  /* Appele apres une sortie de veille USB, pour remonter la PLL. */
  Board_ClockInit();
}

int main(void)
{
  /* Installer nos vecteurs avant SysTick et retablir les IRQ, notamment apres
   * une entree depuis un chargeur/debugger ayant laisse PRIMASK a 1. */
  extern const uint32_t g_pfnVectors[];
  __disable_irq();
  SCB->VTOR = (uint32_t)g_pfnVectors;
  __DSB();
  __ISB();
  __enable_irq();
  HAL_Init();
  Board_ClockInit();
  BootShared_Init(); /* Consomme une seule fois le handshake SRAM du bootloader. */

  DbgPin_Init();
  Ctrl_Init();

  Pwm_Init();       /* TIM1 démarre, MOE = 0 : sorties en haute impédance   */
  AdcSync_Init();   /* conversions injectées armées sur TIM1_TRGO, ISR 20 kHz */
  Drv8304_Init();   /* SPI2 + nFAULT ; ne configure rien dans le driver lui-même   */

  /* La liaison arrive après l'étage de puissance : si l'énumération USB traîne ou échoue,
   * la boucle de contrôle tourne déjà et les sorties sont déjà sûres. */
  Link_Init();
  Console_Init();
  Param_Init();     /* calcule le hash du dictionnaire avant tout handshake */
  Scope_Init();
  Proto_Init();
  RxRouter_Init();
  HAL_Delay(500); // Delay to allow USB host to recognize the device in debug mode
  MX_USB_Device_Init();

  for (;;) {
    /* La superloop est vide, et c'est le point de l'étape M0.
     *
     * Dans le v1, cette boucle portait la lecture I2C bloquante de l'AS5600, le parsing
     * des commandes et l'acquisition des courants, ce qui plafonnait l'ensemble à environ
     * 1,5 kHz avec de la gigue. Rien de ce dont la boucle de contrôle dépend ne doit
     * revenir ici : supervision, communication et console s'y installent, mais la
     * régulation vit dans l'ISR, et seulement là. Aucun appel ci-dessous n'attend quoi
     * que ce soit — ni l'USB, ni l'hôte, ni un périphérique.
     */
    RxRouter_Process();  /* aiguille trames binaires et lignes de console   */
    Proto_Process();     /* streaming et transitions scope, jamais dans l'ISR */
    BootShared_Process(); /* confirmation d'un slot candidat, le cas échéant */
    Link_Pump();         /* écoule le tampon d'émission vers l'USB           */
  }
}
