/**
 * @file drv8304.c
 * @brief Driver de grille DRV8304S — SPI2, nFAULT, CAL.
 *
 * Trois règles :
 *  - un échange SPI est bloquant et court (16 bits à 1,1 MHz, ~15 µs) : il vit dans la
 *    boucle principale ou la console, jamais dans l'ISR de contrôle ;
 *  - la faute est traitée en deux temps : l'EXTI coupe `MOE` tout de suite sans parler au
 *    DRV, la boucle principale relit ensuite les registres d'état pour dire pourquoi ;
 *  - rien ici ne lève `MOE`. Configurer le driver n'est pas mettre le moteur sous tension.
 */
#include "drv8304.h"

#include "stm32g4xx_hal.h"

#include "board.h"
#include "pwm.h"
#include "safety.h"

/* PCLK1 = 144 MHz ; /128 → 1,125 MHz. Le DRV accepte 10 MHz, mais la carte a été retouchée
 * à la main sur ces trois lignes (voir board.h) : on ne cherche pas la vitesse. */
#define DRV_SPI               SPI2
#define DRV_SPI_PRESCALER     SPI_BAUDRATEPRESCALER_128
#define DRV_SPI_TIMEOUT_MS    5U

#define DRV_FRAME_READ        0x8000U
#define DRV_FRAME_ADDR(reg)   ((uint16_t)(((uint16_t)(reg) & 0x000FU) << 11))

static SPI_HandleTypeDef s_spi;

/* Écrits par l'EXTI, lus par la boucle principale : instantané sous masquage dans GetStatus. */
static volatile uint32_t s_fault_events;
static Drv8304_Status_t  s_status;

/* ------------------------------------------------------------------ init */

void Drv8304_Init(void)
{
  GPIO_InitTypeDef g = {0};

  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  __HAL_RCC_SPI2_CLK_ENABLE();

  /* nCS : haut au repos, avant de configurer le SPI pour qu'aucun front parasite ne
   * ressemble à un début de trame. */
  HAL_GPIO_WritePin(PIN_DRV_NCS_PORT, PIN_DRV_NCS, GPIO_PIN_SET);
  g.Pin   = PIN_DRV_NCS;
  g.Mode  = GPIO_MODE_OUTPUT_PP;
  g.Pull  = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(PIN_DRV_NCS_PORT, &g);

  /* CAL : bas = mesure normale. Haut court-circuiterait les entrées des CSA. */
  HAL_GPIO_WritePin(PIN_DRV_CAL_PORT, PIN_DRV_CAL, GPIO_PIN_RESET);
  g.Pin = PIN_DRV_CAL;
  HAL_GPIO_Init(PIN_DRV_CAL_PORT, &g);

  /* SCK / MISO / MOSI en AF5. Le brochage est celui du v1, pas celui du schéma — board.h.
   *
   * Pas de tirage interne sur MISO, et c'est **mesuré** et non supposé : `SDO` du DRV8304
   * est un drain ouvert que la fiche technique veut tiré en externe, ce tirage n'apparaît
   * nulle part au schéma, et on a cru un moment qu'il manquait. `DRV.PINS` a tranché — la
   * broche lit 1 même avec le tirage interne vers le bas, donc la résistance externe existe
   * et elle est franche. En ajouter une seconde en parallèle ne ferait que déplacer le
   * niveau continu du bus sans rien réparer. */
  g.Pin       = PIN_SPI_SCK | PIN_SPI_MISO | PIN_SPI_MOSI;
  g.Mode      = GPIO_MODE_AF_PP;
  g.Pull      = GPIO_NOPULL;
  g.Speed     = GPIO_SPEED_FREQ_LOW;
  g.Alternate = GPIO_AF5_SPI2;
  HAL_GPIO_Init(GPIOB, &g);

  /* nFAULT : drain ouvert côté DRV, tirage interne, interruption sur front descendant. */
  g.Pin  = PIN_DRV_NFAULT;
  g.Mode = GPIO_MODE_IT_FALLING;
  g.Pull = GPIO_PULLUP;
  HAL_GPIO_Init(PIN_DRV_NFAULT_PORT, &g);
  /* Sous l'ISR de contrôle (0) : la faute attend au plus une ISR, soit quelques
   * microsecondes, et le DRV a déjà coupé ses propres grilles avant de baisser nFAULT.
   * Au-dessus de l'USB, qui ne doit pas retarder une coupure. */
  HAL_NVIC_SetPriority(EXTI15_10_IRQn, 1, 0);
  HAL_NVIC_EnableIRQ(EXTI15_10_IRQn);

  /* SPI mode 1 (CPOL = 0, CPHA = 1) : le DRV échantillonne SDI sur le front descendant de
   * SCLK et présente SDO sur le montant. 16 bits, MSB en premier, nCS logiciel. */
  s_spi.Instance               = DRV_SPI;
  s_spi.Init.Mode              = SPI_MODE_MASTER;
  s_spi.Init.Direction         = SPI_DIRECTION_2LINES;
  s_spi.Init.DataSize          = SPI_DATASIZE_16BIT;
  s_spi.Init.CLKPolarity       = SPI_POLARITY_LOW;
  s_spi.Init.CLKPhase          = SPI_PHASE_2EDGE;
  s_spi.Init.NSS               = SPI_NSS_SOFT;
  s_spi.Init.BaudRatePrescaler = DRV_SPI_PRESCALER;
  s_spi.Init.FirstBit          = SPI_FIRSTBIT_MSB;
  s_spi.Init.TIMode            = SPI_TIMODE_DISABLE;
  s_spi.Init.CRCCalculation    = SPI_CRCCALCULATION_DISABLE;
  s_spi.Init.NSSPMode          = SPI_NSS_PULSE_DISABLE;
  s_status.spi_ok = (HAL_SPI_Init(&s_spi) == HAL_OK);

  s_fault_events         = 0U;
  s_status.fault_events  = 0U;
  s_status.fault_status_1 = 0U;
  s_status.vgs_status_2   = 0U;
  s_status.nfault_low = (HAL_GPIO_ReadPin(PIN_DRV_NFAULT_PORT, PIN_DRV_NFAULT) == GPIO_PIN_RESET);
}

/* ------------------------------------------------------------------ SPI */

static bool Transfer(uint16_t tx, uint16_t *rx)
{
  uint16_t word = 0U;

  HAL_GPIO_WritePin(PIN_DRV_NCS_PORT, PIN_DRV_NCS, GPIO_PIN_RESET);
  const HAL_StatusTypeDef st =
      HAL_SPI_TransmitReceive(&s_spi, (uint8_t *)&tx, (uint8_t *)&word, 1U, DRV_SPI_TIMEOUT_MS);
  HAL_GPIO_WritePin(PIN_DRV_NCS_PORT, PIN_DRV_NCS, GPIO_PIN_SET);

  s_status.spi_ok = (st == HAL_OK);
  if (st != HAL_OK) {
    return false;
  }
  *rx = word;
  return true;
}

bool Drv8304_TransferRaw(uint16_t tx, uint16_t *rx)
{
  return (rx != NULL) && Transfer(tx, rx);
}

bool Drv8304_ReadReg(uint8_t reg, uint16_t *value)
{
  uint16_t rx;
  if ((reg >= DRV_REG_COUNT) || (value == NULL)) {
    return false;
  }
  if (!Transfer(DRV_FRAME_READ | DRV_FRAME_ADDR(reg), &rx)) {
    return false;
  }
  *value = rx & DRV_DATA_MASK;
  return true;
}

bool Drv8304_WriteReg(uint8_t reg, uint16_t value)
{
  uint16_t rx;
  if (reg >= DRV_REG_COUNT) {
    return false;
  }
  return Transfer(DRV_FRAME_ADDR(reg) | (value & DRV_DATA_MASK), &rx);
}

/* ------------------------------------------------------------------ opérations */

bool Drv8304_Probe(void)
{
  uint16_t original, readback;

  if (!Drv8304_ReadReg(DRV_REG_DRIVER_CONTROL, &original)) {
    return false;
  }
  const uint16_t toggled = original ^ DRV_CTRL_COAST;
  if (!Drv8304_WriteReg(DRV_REG_DRIVER_CONTROL, toggled) ||
      !Drv8304_ReadReg(DRV_REG_DRIVER_CONTROL, &readback)) {
    (void)Drv8304_WriteReg(DRV_REG_DRIVER_CONTROL, original);
    return false;
  }
  /* Restaurer avant de juger : un DRV laissé en COAST par un test raté serait une
   * surprise pour l'étape suivante. */
  const bool restored = Drv8304_WriteReg(DRV_REG_DRIVER_CONTROL, original);
  return restored && (readback == toggled);
}

bool Drv8304_ReadFaults(void)
{
  uint16_t fs1, fs2;
  if (!Drv8304_ReadReg(DRV_REG_FAULT_STATUS_1, &fs1) ||
      !Drv8304_ReadReg(DRV_REG_VGS_STATUS_2, &fs2)) {
    return false;
  }
  s_status.fault_status_1 = fs1;
  s_status.vgs_status_2   = fs2;
  return true;
}

bool Drv8304_ClearFaults(void)
{
  uint16_t ctrl;
  if (!Drv8304_ReadReg(DRV_REG_DRIVER_CONTROL, &ctrl)) {
    return false;
  }
  /* CLR_FLT s'efface tout seul après prise en compte ; on n'a donc rien à remettre. */
  return Drv8304_WriteReg(DRV_REG_DRIVER_CONTROL, ctrl | DRV_CTRL_CLR_FLT);
}

static volatile bool s_cal_active;

void Drv8304_SetCal(bool enabled)
{
  HAL_GPIO_WritePin(PIN_DRV_CAL_PORT, PIN_DRV_CAL, enabled ? GPIO_PIN_SET : GPIO_PIN_RESET);
  s_cal_active = enabled;
}

bool Drv8304_CalActive(void)
{
  return s_cal_active;
}

bool Drv8304_CsaConfigOk(void)
{
  uint16_t v = 0U;
  if (!Drv8304_ReadReg(DRV_REG_CSA_CONTROL, &v)) {
    return false;
  }
  const uint16_t want_mask = DRV_CSA_VREF_DIV | DRV_CSA_GAIN_MASK | DRV_CSA_SPI_CAL;
  const uint16_t want      = DRV_CSA_VREF_DIV | DRV_CSA_GAIN_20;
  return (v & want_mask) == want;
}

void Drv8304_GetStatus(Drv8304_Status_t *out)
{
  __disable_irq();
  *out = s_status;
  out->fault_events = s_fault_events;
  __enable_irq();
  out->nfault_low = (HAL_GPIO_ReadPin(PIN_DRV_NFAULT_PORT, PIN_DRV_NFAULT) == GPIO_PIN_RESET);
}

/* ------------------------------------------------------------------ faute */

void Drv8304_OnFaultIrq(void)
{
  /* Le DRV a déjà coupé ses grilles (c'est ce que nFAULT signifie). Couper MOE en plus
   * empêche le pont de repartir tout seul quand le DRV se remettra — la reprise doit être
   * une décision, pas un effet de bord. Pas de SPI ici : bloquant, et sans intérêt tant
   * que la boucle principale n'a pas de quoi le journaliser. */
  Safety_Cut(SAFETY_DRV_FAULT);
  s_fault_events++;
}
