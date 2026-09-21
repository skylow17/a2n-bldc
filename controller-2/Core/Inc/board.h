/**
 * @file board.h
 * @brief Définition matérielle de la carte A2N BLDC.
 *
 * Source de vérité du brochage : `a2n-bldc-controller/a2n-bldc-controller.ioc` (firmware v1).
 * Le schéma `docs/Schematics.pdf` comporte des erreurs d'affectation connues, signalées ci-dessous.
 */
#ifndef BOARD_H
#define BOARD_H

#include "stm32g4xx_hal.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Erreur d'initialisation irrattrapable.
 *
 * Appelee quand un peripherique refuse sa configuration. On s'arrete franchement :
 * laisser demarrer un firmware de commande moteur sur une base fausse est pire que
 * de ne pas demarrer du tout. @p what identifie le sous-systeme, pour le jour ou un
 * lien de communication existera pour le remonter.
 */
void Board_FatalError(const char *what);

/* ------------------------------------------------------------------ horloges */

#define BOARD_HSE_HZ        24000000UL
#define BOARD_SYSCLK_HZ     144000000UL   /* PLL : HSE/2 × 24 → 288 MHz VCO, /2 → 144 MHz */
#define BOARD_USB_CLK_HZ    48000000UL    /* PLLQ /6                                      */

/* ------------------------------------------------------------------ étage de puissance */

/* TIM1, comptage centré. f_pwm = f_tim / (2 × (ARR + 1)) */
#define PWM_TIM             TIM1
#define PWM_FREQ_HZ         20000UL
#define PWM_ARR             ((BOARD_SYSCLK_HZ / (2UL * PWM_FREQ_HZ)) - 1UL)   /* 3599 */

/* Temps mort. tDTS = 1 / 144 MHz = 6.94 ns, DTG < 128 → DT = DTG × tDTS.
 * 72 × 6.94 ns ≈ 500 ns. À vérifier à l'oscilloscope avant toute mise en puissance :
 * les NVMFD024N06 commutent vite, mais le courant de grille du DRV8304 est réglable
 * et conditionne le temps mort réellement nécessaire. */
#define PWM_DEADTIME_DTG    72U

/* Instant d'échantillonnage du courant. Les shunts sont en low-side (10 mΩ, R19/R20/R25) :
 * le courant ne les traverse que pendant la conduction des transistors bas, c'est-à-dire
 * autour du sommet du comptage centré. CH4 sert de source TRGO et place le déclenchement
 * juste avant ce sommet. */
#define PWM_TRIG_OFFSET     20U
#define PWM_TRIG_CCR4       (PWM_ARR - PWM_TRIG_OFFSET)

/* Référence analogique — **3,3 V depuis la retouche du 2026-09-21**, et non plus les
 * 2,048 V du MCP1501 (`../AGENTS.md` §2, « Écarts connus du schéma »).
 *
 * La carte d'origine alimentait la broche `VREF` du DRV8304 avec la même référence que
 * l'ADC du MCU. C'était une erreur : cette broche est **l'alimentation** des trois
 * amplificateurs de shunt, avec un seuil de sous-tension à 2,6 V et un gain caractérisé
 * seulement de 3,3 à 5 V. À 2,048 V les amplis n'ont jamais été alimentés. `U5` est donc
 * déposé et ses pastilles 1 (OUT) et 6 (VDD) pontées : le net `VREF` devient le rail 3,3 V,
 * qui est aussi `VDDA`.
 *
 * Deux conséquences qui valaient la modification :
 *  - le repos des sorties `SOx` vaut `VREF/2`, et la pleine échelle de l'ADC vaut `VREF` :
 *    le zéro tombe donc **pile au milieu de l'échelle** et la mesure devient ratiométrique,
 *    une dérive du rail décalant les deux dans le même sens ;
 *  - le rail 5 V occupait 98 % de l'échelle contre 2,048 V — il frôlait la saturation.
 *
 * Cette constante est une **déclaration**, pas une hypothèse de calcul : `sensors.c` mesure
 * `VREF+` à chaque tour via `VREFINT` et met tout à l'échelle là-dessus. Elle sert au
 * dictionnaire (`board.vref_mv`) et à `INFO?`, pour que l'interface sache à quoi comparer
 * la valeur mesurée. */
#define BOARD_VREF_MV       3300U
#define BOARD_SHUNT_MOHM    10U
#define BOARD_IMOT_ZERO_MV  (BOARD_VREF_MV / 2U)

/* Diviseurs de monitoring. Dimensionnés à l'origine pour 2,048 V ; ils restent valables
 * puisque la mise à l'échelle part du `VREF+` mesuré, et ils gagnent de la marge. */
#define BOARD_DIV_VIN_NUM   130U   /* R11 120k / R12 10k  → ×13    */
#define BOARD_DIV_VIN_DEN   10U
#define BOARD_DIV_VMOT_NUM  160U   /* R3  150k / R8  10k  → ×16    */
#define BOARD_DIV_VMOT_DEN  10U
#define BOARD_DIV_5V_NUM    25U    /* R2   15k / R7  10k  → ×2.5   */
#define BOARD_DIV_5V_DEN    10U
#define BOARD_DIV_3V3_NUM   168U   /* R10 6.8k / R9  10k  → ×1.68  */
#define BOARD_DIV_3V3_DEN   100U

/* ------------------------------------------------------------------ brochage */

/* PWM 3 phases complémentaires — TIM1 */
#define PIN_PWM1P_PORT      GPIOA          /* PA8  — CH1   */
#define PIN_PWM1P           GPIO_PIN_8
#define PIN_PWM2P_PORT      GPIOA          /* PA9  — CH2   */
#define PIN_PWM2P           GPIO_PIN_9
#define PIN_PWM3P_PORT      GPIOA          /* PA10 — CH3   */
#define PIN_PWM3P           GPIO_PIN_10
/* PC13 appartient au domaine sauvegardé : drive et vitesse de sortie limités par rapport
 * aux cinq autres sorties PWM. Asymétrie de front à mesurer sur la phase A. */
#define PIN_PWM1N_PORT      GPIOC          /* PC13 — CH1N  */
#define PIN_PWM1N           GPIO_PIN_13
#define PIN_PWM2N_PORT      GPIOB          /* PB0  — CH2N  */
#define PIN_PWM2N           GPIO_PIN_0
#define PIN_PWM3N_PORT      GPIOB          /* PB1  — CH3N  */
#define PIN_PWM3N           GPIO_PIN_1

/* Courants de phase — ADC1 */
#define PIN_IMOTA_PORT      GPIOA          /* PA0 — ADC1_IN1 */
#define PIN_IMOTA           GPIO_PIN_0
#define PIN_IMOTB_PORT      GPIOA          /* PA1 — ADC1_IN2 */
#define PIN_IMOTB           GPIO_PIN_1
#define PIN_IMOTC_PORT      GPIOA          /* PA2 — ADC1_IN3 */
#define PIN_IMOTC           GPIO_PIN_2
#define ADC_CH_IMOTA        ADC_CHANNEL_1
#define ADC_CH_IMOTB        ADC_CHANNEL_2
#define ADC_CH_IMOTC        ADC_CHANNEL_3
/* Temps d'échantillonnage des trois voies injectées. À 36 MHz, 6,5 cycles = 180 ns : trop
 * court pour cette source, mesuré sur carte (lecture instable, sous la valeur lente).
 * Valeur retenue après comparaison avec une relecture lente à 247,5 cycles — voir STATUS. */
#ifndef ADC_IMOT_SAMPLETIME
#define ADC_IMOT_SAMPLETIME ADC_SAMPLETIME_6CYCLES_5
#endif

/* Driver de grille DRV8304S — SPI2 + signaux discrets.
 * Le schéma étiquette PB13 = SPI2_MOSI et PB15 = SPI2_SCK, ce qui est électriquement
 * impossible sur ce boîtier : en AF5, PB13 ne peut être que SCK et PB15 que MOSI.
 * La carte a été retouchée en conséquence et le SPI matériel fonctionne avec le brochage
 * ci-dessous, celui du v1. Toute nouvelle carte tirée du schéma non corrigé aura le
 * défaut — voir ../AGENTS.md § « Écarts connus du schéma ». */
#define PIN_SPI_SCK_PORT    GPIOB          /* PB13 */
#define PIN_SPI_SCK         GPIO_PIN_13
#define PIN_SPI_MISO_PORT   GPIOB          /* PB14 */
#define PIN_SPI_MISO        GPIO_PIN_14
#define PIN_SPI_MOSI_PORT   GPIOB          /* PB15 */
#define PIN_SPI_MOSI        GPIO_PIN_15
#define PIN_DRV_NCS_PORT    GPIOB          /* PB12 */
#define PIN_DRV_NCS         GPIO_PIN_12
#define PIN_DRV_NFAULT_PORT GPIOB          /* PB11, actif bas. Pas de TIM1_BKIN sur cette
                                            * broche : la coupure est logicielle (EXTI). */
#define PIN_DRV_NFAULT      GPIO_PIN_11
#define PIN_DRV_CAL_PORT    GPIOC          /* PC4 */
#define PIN_DRV_CAL         GPIO_PIN_4

/* Capteur de position AS5600 — I2C4 */
#define PIN_I2C_SCL_PORT    GPIOC          /* PC6 */
#define PIN_I2C_SCL         GPIO_PIN_6
#define PIN_I2C_SDA_PORT    GPIOB          /* PB7 */
#define PIN_I2C_SDA         GPIO_PIN_7
#define PIN_HALL_DIR_PORT   GPIOB          /* PB6  — broche DIR de l'AS5600 */
#define PIN_HALL_DIR        GPIO_PIN_6
#define PIN_HALL_IC_PORT    GPIOB          /* PB10 — sortie OUT de l'AS5600, TIM2_CH3 */
#define PIN_HALL_IC         GPIO_PIN_10

/* Encodeur incrémental — TIM3, sorti sur J3. Non utilisé pour l'instant. */
#define PIN_ENCA_PORT       GPIOB          /* PB4 — TIM3_CH1 */
#define PIN_ENCA            GPIO_PIN_4
#define PIN_ENCB_PORT       GPIOA          /* PA4 — TIM3_CH2 */
#define PIN_ENCB            GPIO_PIN_4

/* Broche d'instrumentation.
 * TP1/TP2 (PB8/PB9) sont marqués « ne pas poser » sur le schéma, donc pas de point de test
 * garanti. IO1 (PC14) sort en revanche sur J7 broche 5, au travers de R23 1 kΩ : c'est là
 * qu'on mesure la durée de l'ISR à l'oscilloscope. PC14 est dans le domaine sauvegardé
 * (drive limité), largement suffisant pour une impulsion de quelques microsecondes. */
#define PIN_DBG_PORT        GPIOC
#define PIN_DBG             GPIO_PIN_14

#ifdef __cplusplus
}
#endif

#endif /* BOARD_H */
