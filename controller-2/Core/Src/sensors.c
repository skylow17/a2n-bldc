/**
 * @file sensors.c
 * @brief Mesures lentes sur ADC2 (rails) et sur le groupe régulier d'ADC1 (VREFINT, courant C).
 *
 * Pourquoi deux convertisseurs : le temps d'échantillonnage est un réglage *par voie*, et
 * les voies 1 à 3 d'ADC1 appartiennent au groupe injecté, réglé court (6,5 cycles) pour la
 * boucle de contrôle. Les relire lentement sur ADC1 rallongerait aussi la salve synchrone.
 * PA0 et PA1 sont aussi sur ADC2 : on les y lit avec un échantillonnage long. PA2 n'est
 * que sur ADC1 : on l'y lit par le groupe régulier, au temps court du groupe injecté —
 * moins précis, mais ce que ce module cherche, c'est un zéro, pas un millivolt.
 *
 * Accès registre plutôt que HAL pour les conversions : une conversion régulière sur ADC1
 * ne doit pas passer par un second handle HAL sur un périphérique que `adc_sync.c` tient
 * déjà, et le tourniquet n'a besoin que de trois choses — lancer, savoir si c'est fini, lire.
 */
#include "sensors.h"

#include "stm32g4xx_hal.h"
#include "stm32g4xx_ll_adc.h"

#include "board.h"

/* Codes SMP du registre SMPRx (RM0440) : 110 = 247,5 cycles, 111 = 640,5 cycles.
 * À 36 MHz : 6,9 µs et 17,8 µs. Les diviseurs de monitoring ont ~9 kΩ d'impédance de
 * source, VREFINT exige au moins 4 µs. */
#define SMP_247_5   6U
#define SMP_640_5   7U

typedef struct
{
  ADC_TypeDef *adc;
  uint32_t     channel;   /* numéro de voie 0..18 */
  uint8_t      smp;       /* code SMP, ou 0xFF pour ne pas toucher (voie du groupe injecté) */
} Slot_t;

/* Ordre du tourniquet. VREFINT en premier : les millivolts des autres en dépendent. */
static const Slot_t s_slots[] = {
  { ADC1, 18U, SMP_640_5 },   /* VREFINT                                            */
  { ADC2, 13U, SMP_247_5 },   /* Vin   PA5                                          */
  { ADC2, 12U, SMP_247_5 },   /* Vmot  PB2                                          */
  { ADC2,  3U, SMP_247_5 },   /* 5 V   PA6                                          */
  { ADC2,  4U, SMP_247_5 },   /* 3V3   PA7                                          */
  { ADC2,  1U, SMP_247_5 },   /* CSA A PA0, relecture lente                         */
  { ADC2,  2U, SMP_247_5 },   /* CSA B PA1, relecture lente                         */
  { ADC1,  3U, 0xFFU     },   /* CSA C PA2 : ADC1 seul, au temps du groupe injecté  */
  { ADC1, 16U, SMP_640_5 },   /* Température de jonction, capteur interne           */
};
#define SLOT_COUNT  (sizeof(s_slots) / sizeof(s_slots[0]))

static ADC_HandleTypeDef s_adc2;
static uint8_t           s_index;
static bool              s_busy;
static uint16_t          s_raw[SLOT_COUNT];
static Sensors_t         s_public;

/* ------------------------------------------------------------------ init */

void Sensors_Init(void)
{
  GPIO_InitTypeDef g = {0};

  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  g.Mode = GPIO_MODE_ANALOG;
  g.Pull = GPIO_NOPULL;
  g.Pin  = GPIO_PIN_5 | GPIO_PIN_6 | GPIO_PIN_7;   /* PA5 Vin, PA6 5 V, PA7 3V3 */
  HAL_GPIO_Init(GPIOA, &g);
  g.Pin  = GPIO_PIN_2;                             /* PB2 Vmot                  */
  HAL_GPIO_Init(GPIOB, &g);

  /* Même arbre d'horloge qu'ADC1 (ADC12 partagent le prédiviseur et l'horloge). */
  s_adc2.Instance                   = ADC2;
  s_adc2.Init.ClockPrescaler        = ADC_CLOCK_ASYNC_DIV2;
  s_adc2.Init.Resolution            = ADC_RESOLUTION_12B;
  s_adc2.Init.DataAlign             = ADC_DATAALIGN_RIGHT;
  s_adc2.Init.GainCompensation      = 0U;
  s_adc2.Init.ScanConvMode          = ADC_SCAN_DISABLE;
  s_adc2.Init.EOCSelection          = ADC_EOC_SINGLE_CONV;
  s_adc2.Init.LowPowerAutoWait      = DISABLE;
  s_adc2.Init.ContinuousConvMode    = DISABLE;
  s_adc2.Init.NbrOfConversion       = 1U;
  s_adc2.Init.DiscontinuousConvMode = DISABLE;
  s_adc2.Init.ExternalTrigConv      = ADC_SOFTWARE_START;
  s_adc2.Init.ExternalTrigConvEdge  = ADC_EXTERNALTRIGCONVEDGE_NONE;
  s_adc2.Init.DMAContinuousRequests = DISABLE;
  s_adc2.Init.Overrun               = ADC_OVR_DATA_OVERWRITTEN;
  s_adc2.Init.OversamplingMode      = DISABLE;
  if (HAL_ADC_Init(&s_adc2) != HAL_OK) {
    Board_FatalError("adc2");
  }
  if (HAL_ADCEx_Calibration_Start(&s_adc2, ADC_SINGLE_ENDED) != HAL_OK) {
    Board_FatalError("adc2");
  }
  /* ADEN sans conversion : le tourniquet lancera les siennes. */
  LL_ADC_Enable(ADC2);
  while (!LL_ADC_IsActiveFlag_ADRDY(ADC2)) { }

  /* VREFINT est un canal interne : à activer dans le bloc commun. */
  LL_ADC_SetCommonPathInternalCh(ADC12_COMMON,
                                 LL_ADC_PATH_INTERNAL_VREFINT | LL_ADC_PATH_INTERNAL_TEMPSENSOR);

  s_index = 0U;
  s_busy  = false;
}

/* ------------------------------------------------------------------ tourniquet */

static void Start(const Slot_t *s)
{
  ADC_TypeDef *adc = s->adc;

  if (s->smp != 0xFFU) {
    if (s->channel < 10U) {
      MODIFY_REG(adc->SMPR1, 0x7UL << (3U * s->channel), (uint32_t)s->smp << (3U * s->channel));
    } else {
      MODIFY_REG(adc->SMPR2, 0x7UL << (3U * (s->channel - 10U)),
                 (uint32_t)s->smp << (3U * (s->channel - 10U)));
    }
  }
  /* Séquence régulière d'une seule voie (L = 0), départ logiciel. */
  adc->SQR1 = (s->channel << ADC_SQR1_SQ1_Pos);
  adc->ISR  = ADC_ISR_EOC | ADC_ISR_EOS | ADC_ISR_OVR;
  adc->CR  |= ADC_CR_ADSTART;
}

static void Publish(void)
{
  Sensors_t v = {0};

  v.vrefint_raw = s_raw[0];
  /* VREF+ réel : valeur d'usine de VREFINT (acquise sous 3,0 V) rapportée à la lecture. */
  v.vref_mv = (s_raw[0] != 0U)
      ? (uint16_t)__LL_ADC_CALC_VREFANALOG_VOLTAGE(s_raw[0], LL_ADC_RESOLUTION_12B)
      : 0U;

  const uint32_t vref = v.vref_mv;
  #define TO_MV(raw)  ((uint32_t)(raw) * vref / 4095UL)
  v.vin_mv   = (uint16_t)(TO_MV(s_raw[1]) * BOARD_DIV_VIN_NUM  / BOARD_DIV_VIN_DEN);
  v.vmot_mv  = (uint16_t)(TO_MV(s_raw[2]) * BOARD_DIV_VMOT_NUM / BOARD_DIV_VMOT_DEN);
  v.v5_mv    = (uint16_t)(TO_MV(s_raw[3]) * BOARD_DIV_5V_NUM   / BOARD_DIV_5V_DEN);
  v.v3v3_mv  = (uint16_t)(TO_MV(s_raw[4]) * BOARD_DIV_3V3_NUM  / BOARD_DIV_3V3_DEN);
  for (uint8_t i = 0U; i < 3U; i++) {
    v.csa_raw[i] = s_raw[5U + i];
    v.csa_mv[i]  = (uint16_t)TO_MV(s_raw[5U + i]);
  }
  #undef TO_MV
  /* La température passe par les deux points d'étalonnage d'usine, relevés sous 3,0 V :
   * il faut donc lui donner le VREF+ réellement mesuré, sinon l'erreur de la référence
   * se retrouve en degrés. */
  v.mcu_temp_c = (int16_t)__LL_ADC_CALC_TEMPERATURE(vref, s_raw[8], LL_ADC_RESOLUTION_12B);
  v.rounds = s_public.rounds + 1U;

  __disable_irq();
  s_public = v;
  __enable_irq();
}

void Sensors_Process(void)
{
  const Slot_t *s = &s_slots[s_index];

  if (!s_busy) {
    Start(s);
    s_busy = true;
    return;
  }
  if ((s->adc->ISR & ADC_ISR_EOC) == 0U) {
    return;
  }
  s_raw[s_index] = (uint16_t)s->adc->DR;   /* lire DR efface EOC */
  s_busy = false;
  s_index++;
  if (s_index >= SLOT_COUNT) {
    s_index = 0U;
    Publish();
  }
}

void Sensors_Restart(void)
{
  s_index = 0U;
  s_busy  = false;
}

void Sensors_Get(Sensors_t *out)
{
  __disable_irq();
  *out = s_public;
  __enable_irq();
}
