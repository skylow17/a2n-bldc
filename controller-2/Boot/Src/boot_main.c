/**
 * @file boot_main.c
 * @brief Bootloader A/B — point d'entrée.
 *
 * Trois chemins possibles, décidés dans les premières millisecondes :
 *
 *  - l'application a demandé `BOOT_ENTER` → on reste en mode mise à jour, USB ouvert ;
 *  - un slot est démarrable → on saute dessus, en probation s'il s'agit d'un candidat ;
 *  - rien n'est démarrable → on reste en mode mise à jour, faute de mieux.
 *
 * L'ordre du fichier est celui de la sûreté, pas celui de la lisibilité : les sorties de
 * puissance passent en haute impédance **avant** tout le reste, horloge comprise. Un
 * bootloader qui prendrait deux millisecondes à couper le pont laisserait un bras en
 * conduction pendant deux millisecondes — et c'est un reset qui l'y aurait mis.
 */

#include <stdbool.h>
#include <stdint.h>

#include "stm32g4xx_hal.h"

#include "board.h"
#include "board_clock.h"
#include "boot_flash.h"
#include "boot_proto.h"
#include "boot_rx.h"
#include "boot_shared.h"
#include "link_usb.h"
#include "usb_device.h"

/* --- Adaptateurs pour la pile USB de ST, comme dans l'application ------------------- */

void Board_FatalError(const char *what)
{
  (void)what;
  __disable_irq();
  for (;;) {
    __NOP();
  }
}

void Error_Handler(void)
{
  Board_FatalError("usb");
}

void SystemClock_Config(void)
{
  Board_ClockInit();
}

/* ------------------------------------------------------------------ sûreté */

/**
 * @brief Met les six sorties de pont en haute impédance, avant toute autre chose.
 *
 * Le bootloader ne configure jamais TIM1 : sans MOE, sans fonction alternative, les broches
 * restent ce qu'on en fait ici. Entrée avec tirage vers le bas plutôt qu'analogique — une
 * entrée de driver de grille laissée flottante peut se faire commuter par le couplage des
 * lignes voisines, alors qu'un tirage la tient franchement à l'état bas.
 *
 * Pas de HAL ici : `HAL_Init()` n'a pas encore tourné, et la manœuvre ne demande que
 * d'ouvrir les horloges de port et d'écrire deux registres par port.
 */
static void PowerStageSafe(void)
{
  RCC->AHB2ENR |= RCC_AHB2ENR_GPIOAEN | RCC_AHB2ENR_GPIOBEN | RCC_AHB2ENR_GPIOCEN;
  __DSB();

  GPIO_InitTypeDef g = {0};
  g.Mode = GPIO_MODE_INPUT;
  g.Pull = GPIO_PULLDOWN;
  g.Speed = GPIO_SPEED_FREQ_LOW;

  g.Pin = PIN_PWM1P | PIN_PWM2P | PIN_PWM3P;   /* PA8, PA9, PA10 */
  HAL_GPIO_Init(GPIOA, &g);
  g.Pin = PIN_PWM2N | PIN_PWM3N;               /* PB0, PB1       */
  HAL_GPIO_Init(GPIOB, &g);
  g.Pin = PIN_PWM1N;                           /* PC13           */
  HAL_GPIO_Init(GPIOC, &g);
}

/* ------------------------------------------------------------------ probation */

/**
 * @brief Arme le chien de garde avant de sauter sur un candidat.
 *
 * Écrit directement dans l'IWDG plutôt que par le HAL : le module `hal_iwdg` n'est pas lié
 * par l'image du bootloader, et ces quatre écritures ne justifient pas de l'y faire entrer.
 *
 * LSI ≈ 32 kHz, prédiviseur /32 → un tick ≈ 1 ms. Le rechargement vise les deux secondes
 * annoncées par la spécification : c'est le délai que le candidat a pour confirmer, et il
 * doit rester nettement au-dessus des ~600 ms que `boot_shared.h` lui impose d'atteindre.
 *
 * Une fois armé, l'IWDG ne se désarme plus : seul un reset l'arrête. C'est exactement ce
 * qu'on veut — un candidat qui part en boucle ne peut pas se soustraire à son rollback.
 */
static void ArmWatchdog(void)
{
  IWDG->KR = 0x0000CCCCU;  /* démarrage                         */
  IWDG->KR = 0x00005555U;  /* déverrouillage des registres      */
  IWDG->PR = 3U;           /* prédiviseur /32 → ~1 ms par tick  */
  IWDG->RLR = 2000U;       /* ~2 s                              */
  while (IWDG->SR != 0U) {
    /* Attendre la prise en compte : recharger avant que PR et RLR soient appliqués
     * laisserait le chien sur ses valeurs par défaut, soit un délai bien plus court. */
  }
  IWDG->KR = 0x0000AAAAU;  /* rechargement */
}

/**
 * @brief Quitte le bootloader pour l'image d'un slot. Ne rend jamais la main.
 *
 * Remettre les périphériques dans un état proche du reset est ce qui distingue un saut qui
 * marche d'un saut qui marche *parfois* : l'application refait son initialisation en
 * supposant un départ propre, et une interruption encore armée pendant qu'elle réinstalle
 * ses vecteurs s'exécuterait sur une table à moitié en place.
 */
static void JumpToSlot(uint32_t slot_addr)
{
  const uint32_t sp = *(const volatile uint32_t *)slot_addr;
  const uint32_t pc = *(const volatile uint32_t *)(slot_addr + 4U);

  HAL_RCC_DeInit();
  HAL_DeInit();

  __disable_irq();
  for (uint8_t i = 0U; i < 8U; i++) {
    NVIC->ICER[i] = 0xFFFFFFFFU;
    NVIC->ICPR[i] = 0xFFFFFFFFU;
  }
  SysTick->CTRL = 0U;
  SysTick->LOAD = 0U;
  SysTick->VAL = 0U;

  SCB->VTOR = slot_addr;
  __DSB();
  __ISB();

  /* Les interruptions sont rétablies juste avant le saut : l'application les attend
   * actives, et son propre `main()` commence de toute façon par les couper. */
  __enable_irq();

  __set_MSP(sp);
  ((void (*)(void))pc)();

  /* Une image qui revient de son point d'entrée n'existe pas ; si cela arrivait, mieux vaut
   * un reset qu'un retour dans une pile qu'on vient de remplacer. */
  NVIC_SystemReset();
}

/* ------------------------------------------------------------------ décision */

/**
 * @brief Décide de la suite, et saute si un slot est démarrable.
 *
 * Rend la main uniquement quand il faut rester en mode mise à jour.
 */
static void DecideAndMaybeJump(bool stay_for_update)
{
  BootFlash_Init();

  BootMeta_t meta = *BootFlash_Meta();

  /* Le candidat a-t-il confirmé lors de sa probation ? La réponse se lit dans la SRAM
   * partagée, avant toute autre décision : c'est le seul moment où elle est encore là. */
  if (BootShared_TakeConfirm()) {
    if (BootMeta_PromoteCandidate(&meta)) {
      (void)BootFlash_CommitMeta(&meta);
      meta = *BootFlash_Meta();
    }
  }

  if (stay_for_update) {
    return;
  }

  bool trial = false;
  bool changed = false;
  const uint8_t slot = BootFlash_SelectBoot(&meta, &trial, &changed);

  if (changed) {
    /* Écrit **avant** le saut. Si le candidat plante au point de ne jamais rendre la main,
     * c'est cette marque que le reset suivant retrouvera, et c'est elle qui déclenche le
     * rollback. Écrire après le saut n'arriverait jamais. */
    if (!BootFlash_CommitMeta(&meta)) {
      /* Sans pouvoir enregistrer l'essai, une probation deviendrait un rebouclage infini
       * sur une image peut-être morte. On préfère rester en mise à jour. */
      return;
    }
  }

  if (slot == BOOT_SLOT_NONE) {
    return;
  }

  const uint32_t addr = BootFlash_SlotAddr(slot);
  const uint32_t sp = *(const volatile uint32_t *)addr;
  const uint32_t pc = *(const volatile uint32_t *)(addr + 4U);

  /* Dernier filet : même un slot marqué valide ne se saute pas si ses vecteurs ne tiennent
   * pas debout. Les métadonnées peuvent avoir survécu à un effacement fait par SWD. */
  if (!BootFlash_VectorsPlausible(sp, pc, addr)) {
    return;
  }

  if (trial) {
    BootShared_MarkTrial();
    ArmWatchdog();
  }

  JumpToSlot(addr);
}

/* ------------------------------------------------------------------ main */

int main(void)
{
  /* Avant tout : le pont. Ce que la ligne suivante coûte en microsecondes, elle l'économise
   * en transistors. */
  PowerStageSafe();

  extern const uint32_t g_pfnVectors[];
  __disable_irq();
  SCB->VTOR = (uint32_t)g_pfnVectors;
  __DSB();
  __ISB();
  __enable_irq();

  HAL_Init();
  Board_ClockInit();

  /* Consomme le mot laissé par l'application. Il est lu ici une seule fois : un message qui
   * survivrait à sa lecture se rejouerait au reset suivant, et une coupure d'alimentation
   * pendant une mise à jour bloquerait la carte en bootloader — ce que la spec interdit. */
  const bool asked = BootShared_TakeEnter();

  DecideAndMaybeJump(asked);

  /* Mode mise à jour : rien d'autre que l'USB et les six messages du bootloader. */
  Link_Init();
  BootProto_Init();
  BootRx_Init();
  MX_USB_Device_Init();

  for (;;) {
    Link_Pump();
    BootRx_Process();
    BootProto_Process();
  }
}
