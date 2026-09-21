/**
 * @file encoder.c
 * @brief AS5600 sur I2C4, lecture continue en DMA, extrapolation d'angle.
 *
 * Voir `encoder.h` pour le pourquoi et pour le budget de retard. Ce fichier contient le
 * comment, et trois décisions qui méritent d'être expliquées :
 *
 * **La chaîne se relance depuis sa propre interruption de fin.** Pas de timer, pas de
 * cadencement depuis la superloop, pas un octet écrit depuis l'ISR de contrôle. Le bus
 * n'a qu'un seul esclave, donc le faire tourner en continu ne prive personne et donne
 * l'échantillon le plus frais possible. En prime, la cadence de lecture devient une
 * mesure (`period_us`) au lieu d'un réglage à justifier.
 *
 * **La publication vers l'ISR est un seqlock, sans boucle de reprise.** L'ISR de contrôle
 * est à la priorité 0 et l'interruption I2C à 3 : l'ISR peut préempter l'écrivain, jamais
 * l'inverse. Un lecteur qui détecte un compteur impair ou changé sait donc qu'il est
 * tombé au milieu d'une écriture, et il repart de sa propre copie précédente. Aucune
 * attente possible dans l'ISR, et jamais de valeur mi-ancienne mi-neuve.
 *
 * **Sans aimant, on ne fait pas semblant.** `RAW_ANGLE` reste lisible et renvoie du bruit
 * quand aucun aimant n'est en face. `magnet_ok` vient du registre `STATUS` du capteur et
 * dit la vérité ; la vitesse estimée est bornée pour qu'un saut de bruit de 2048 pas ne
 * se propage pas en extrapolation absurde.
 */
#include "encoder.h"

#include "board.h"
#include "stm32g4xx_hal.h"

#include <math.h>
#include <string.h>

/* ------------------------------------------------------------------ registres AS5600 */

#define AS5600_ADDR_7B      0x36U
#define AS5600_ADDR         (AS5600_ADDR_7B << 1)

#define AS5600_REG_STATUS   0x0BU   /* MD bit5, ML bit4, MH bit3                        */
#define AS5600_REG_RAWANGLE 0x0CU   /* 12 bits, non recadré, sans hystérésis            */
#define AS5600_REG_CONF_HI  0x07U   /* WD bit5, FTH(2:0) bits 4:2, SF(1:0) bits 1:0     */
#define AS5600_REG_AGC      0x1AU

#define AS5600_STATUS_MH    0x08U
#define AS5600_STATUS_ML    0x10U
#define AS5600_STATUS_MD    0x20U

/* `ANGLE` (0x0E) passe par le recadrage ZPOS/MPOS et par une hystérésis : très bien pour
 * un potentiomètre, poison pour une boucle de position, où l'hystérésis crée une zone
 * morte que le régulateur passe son temps à traverser. On lit `RAW_ANGLE`. */

/* Un transfert sur ENC_STATUS_EVERY va chercher `STATUS` au lieu de l'angle. L'aimant ne
 * disparaît pas d'un échantillon à l'autre ; un point sur 128 suffit largement et coûte
 * moins d'un pour cent de la bande passante du bus. */
#define ENC_STATUS_EVERY    128U

/* Compensation du retard de groupe du filtre interne, en microsecondes. Zéro par défaut :
 * tant que l'étape 6 n'est pas validée sur carte avec un aimant, avancer la prédiction
 * d'un nombre non mesuré reviendrait à inventer de la fraîcheur. À régler quand la
 * réponse indicielle de l'étape 11 donnera de quoi le calibrer. */
#define ENC_LAG_COMP_US     0U

/* Au-delà, on tient la mesure pour du bruit et on n'extrapole pas. 1500 rad/s mécaniques,
 * soit ~14 000 tr/min : très au-dessus de ce que ce banc verra, et très en dessous des
 * vitesses absurdes qu'un saut de bruit sur un capteur sans aimant produit. */
#define ENC_VEL_MAX_RAD_S   1500.0f

/* Constante du filtre de vitesse, en nombre d'échantillons. La vitesse sort d'une
 * différence de deux angles quantifiés sur 12 bits : à 8 kHz d'échantillonnage, un seul
 * pas de quantification vaut déjà 12 rad/s. Sans filtrage, la dérivée est inexploitable. */
#define ENC_VEL_IIR_SHIFT   5

#define ENC_CYC_PER_US      (BOARD_SYSCLK_HZ / 1000000UL)

/* --------------------------------------------------------------------------- état */

static I2C_HandleTypeDef  s_i2c;
static DMA_HandleTypeDef  s_dma_rx;

static volatile uint8_t   s_buf[2];
static volatile uint32_t  s_xfer_start_cyc;
static volatile uint32_t  s_count;          /* transferts lancés, pilote le tour de STATUS */
static volatile bool      s_reading_status;
static volatile bool      s_running;        /* la chaîne est en vol                      */
static volatile uint32_t  s_last_cplt_ms;   /* dernier transfert abouti, pour le garde-fou */

/* Publication vers l'ISR — seqlock. `s_seq` est impair pendant l'écriture. */
static volatile uint32_t  s_seq;
static volatile int32_t   s_pos_cnt;        /* position non repliée, en pas de 1/4096 tr  */
static volatile uint32_t  s_pos_stamp;      /* DWT->CYCCNT à la fin du transfert          */
static volatile float     s_vel_cnt_s;      /* vitesse en pas par seconde, filtrée        */

static volatile Encoder_t s_pub;
static uint16_t           s_prev_raw;
static bool               s_have_prev;
static uint32_t           s_prev_stamp;

/* Dernier instantané cohérent vu par l'ISR. Sert de repli quand la lecture est déchirée,
 * ce qui ne peut arriver qu'une fois par transfert et au pire sur une seule période. */
static int32_t  s_isr_pos_cnt;
static uint32_t s_isr_stamp;
static float    s_isr_vel_cnt_s;
static bool     s_isr_valid;

/* --------------------------------------------------------------- horloge du bus I2C */

/* Calculés pour un noyau I2C à 144 MHz (PCLK1). Les champs sont, de gauche à droite :
 * PRESC, SCLDEL, SDADEL, SCLH, SCLL. Les valeurs visent les gabarits de la spécification
 * NXP UM10204 — t_LOW, t_HIGH, t_SU;DAT — avec la marge de montée que permettent des
 * tirages de 4k7. La fréquence réelle se mesure : voir `xfer_us`. */
static uint32_t TimingFor(uint32_t hz)
{
  switch (hz) {
    case 100000UL:  return 0x60F13A67UL;   /* Standard-mode                            */
    case 400000UL:  return 0x30431B2EUL;   /* Fast-mode                                */
    case 1000000UL: return 0x10311223UL;   /* Fast-mode Plus                           */
    default:        return 0U;
  }
}

/* ------------------------------------------------------------------ bas niveau I2C */

static void BusRecover(void)
{
  /* Un esclave qui tient SDA bas ne se débloque pas par un reset du périphérique : il
   * attend des fronts d'horloge pour finir l'octet qu'il croit émettre. On les lui donne
   * à la main, puis on refait un STOP. L'AS5600 n'étire pas l'horloge, donc ce cas ne
   * devrait pas arriver — mais une carte qui redémarre en plein transfert, si. */
  GPIO_InitTypeDef g = {0};

  __HAL_RCC_I2C4_FORCE_RESET();
  __HAL_RCC_I2C4_RELEASE_RESET();

  g.Mode  = GPIO_MODE_OUTPUT_OD;
  g.Pull  = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  g.Pin   = PIN_I2C_SCL;
  HAL_GPIO_Init(PIN_I2C_SCL_PORT, &g);
  g.Pin   = PIN_I2C_SDA;
  HAL_GPIO_Init(PIN_I2C_SDA_PORT, &g);

  HAL_GPIO_WritePin(PIN_I2C_SDA_PORT, PIN_I2C_SDA, GPIO_PIN_SET);
  for (uint32_t i = 0U; i < 9U; i++) {
    HAL_GPIO_WritePin(PIN_I2C_SCL_PORT, PIN_I2C_SCL, GPIO_PIN_RESET);
    for (volatile uint32_t d = 0U; d < 400U; d++) { }
    HAL_GPIO_WritePin(PIN_I2C_SCL_PORT, PIN_I2C_SCL, GPIO_PIN_SET);
    for (volatile uint32_t d = 0U; d < 400U; d++) { }
  }
  /* STOP manuel : SDA monte pendant que SCL est haut. */
  HAL_GPIO_WritePin(PIN_I2C_SDA_PORT, PIN_I2C_SDA, GPIO_PIN_RESET);
  for (volatile uint32_t d = 0U; d < 400U; d++) { }
  HAL_GPIO_WritePin(PIN_I2C_SDA_PORT, PIN_I2C_SDA, GPIO_PIN_SET);

  g.Mode      = GPIO_MODE_AF_OD;
  g.Pin       = PIN_I2C_SCL;
  g.Alternate = GPIO_AF8_I2C4;             /* PC6 */
  HAL_GPIO_Init(PIN_I2C_SCL_PORT, &g);
  g.Pin       = PIN_I2C_SDA;
  g.Alternate = GPIO_AF3_I2C4;             /* PB7 */
  HAL_GPIO_Init(PIN_I2C_SDA_PORT, &g);
}

static void DmaSetup(void)
{
  s_dma_rx.Instance                 = DMA1_Channel1;
  s_dma_rx.Init.Request             = DMA_REQUEST_I2C4_RX;
  s_dma_rx.Init.Direction           = DMA_PERIPH_TO_MEMORY;
  s_dma_rx.Init.PeriphInc           = DMA_PINC_DISABLE;
  s_dma_rx.Init.MemInc              = DMA_MINC_ENABLE;
  s_dma_rx.Init.PeriphDataAlignment = DMA_PDATAALIGN_BYTE;
  s_dma_rx.Init.MemDataAlignment    = DMA_MDATAALIGN_BYTE;
  s_dma_rx.Init.Mode                = DMA_NORMAL;
  s_dma_rx.Init.Priority            = DMA_PRIORITY_LOW;
  (void)HAL_DMA_Init(&s_dma_rx);
  __HAL_LINKDMA(&s_i2c, hdmarx, s_dma_rx);
}

static bool I2cSetup(uint32_t hz)
{
  const uint32_t timing = TimingFor(hz);
  if (timing == 0U) {
    return false;
  }

  HAL_I2C_DeInit(&s_i2c);

  s_i2c.Instance              = I2C4;
  s_i2c.Init.Timing           = timing;
  s_i2c.Init.OwnAddress1      = 0U;
  s_i2c.Init.AddressingMode   = I2C_ADDRESSINGMODE_7BIT;
  s_i2c.Init.DualAddressMode  = I2C_DUALADDRESS_DISABLE;
  s_i2c.Init.OwnAddress2      = 0U;
  s_i2c.Init.OwnAddress2Masks = I2C_OA2_NOMASK;
  s_i2c.Init.GeneralCallMode  = I2C_GENERALCALL_DISABLE;
  s_i2c.Init.NoStretchMode    = I2C_NOSTRETCH_DISABLE;

  if (HAL_I2C_Init(&s_i2c) != HAL_OK) {
    return false;
  }
  if (HAL_I2CEx_ConfigAnalogFilter(&s_i2c, I2C_ANALOGFILTER_ENABLE) != HAL_OK) {
    return false;
  }
  if (HAL_I2CEx_ConfigDigitalFilter(&s_i2c, 0U) != HAL_OK) {
    return false;
  }

  s_pub.bus_hz = hz;
  return true;
}

/**
 * Remise à plat complète de la chaîne. C'est la seule reprise, et elle est synchrone.
 *
 * La première version se contentait d'un `HAL_I2C_Master_Abort_IT` suivi d'un réglage :
 * ça ne reprenait jamais. `Abort_IT` est asynchrone et a besoin du bus pour aboutir — or
 * le bus est justement ce qui est mort. Surtout, **le canal DMA restait armé** sur le
 * transfert abandonné, si bien que chaque relance se faisait renvoyer `HAL_BUSY` en
 * silence. Il faut désarmer le DMA, dénitialiser les deux périphériques, remettre le
 * contrôleur I2C à zéro par son bit de reset, puis tout reconstruire dans l'ordre.
 */
static void HardReset(uint32_t hz)
{
  s_running = false;
  (void)HAL_DMA_Abort(&s_dma_rx);
  (void)HAL_DMA_DeInit(&s_dma_rx);
  (void)HAL_I2C_DeInit(&s_i2c);
  BusRecover();
  DmaSetup();
  (void)I2cSetup(hz);
  s_have_prev    = false;   /* l'écart avec l'échantillon d'avant le trou n'a plus de sens */
  s_last_cplt_ms = HAL_GetTick();
}

/* ------------------------------------------------------------- chaîne de lecture */

static void StartNext(void)
{
  /* Un transfert sur ENC_STATUS_EVERY interroge `STATUS`. L'auto-incrément de l'AS5600
   * n'est documenté que pour les registres d'angle, donc on ne tente pas de lire
   * 0x0B..0x0D d'un coup : ce serait gratuit mais non spécifié. */
  const bool want_status = ((s_count % ENC_STATUS_EVERY) == (ENC_STATUS_EVERY - 1U));
  const uint8_t  reg = want_status ? AS5600_REG_STATUS : AS5600_REG_RAWANGLE;
  const uint16_t len = want_status ? 1U : 2U;

  s_reading_status = want_status;
  s_xfer_start_cyc = DWT->CYCCNT;

  if (HAL_I2C_Mem_Read_DMA(&s_i2c, AS5600_ADDR, reg, I2C_MEMADD_SIZE_8BIT,
                           (uint8_t *)s_buf, len) != HAL_OK) {
    s_running = false;          /* `Encoder_Process` relancera */
    return;
  }
  s_count++;
  s_running = true;
}

/** Publie un nouvel angle. Appelé depuis l'interruption de fin de transfert. */
static void PublishAngle(uint16_t raw, uint32_t stamp)
{
  int32_t delta = 0;

  if (s_have_prev) {
    /* Chemin le plus court sur le cercle : l'écart est ramené dans ±2048 pas. C'est ce
     * qui gère le passage 4095 → 0 sans cas particulier, et c'est correct tant que
     * l'arbre tourne de moins d'un demi-tour entre deux échantillons — soit, à 8 kHz,
     * moins de 240 000 tr/min. */
    delta = (int32_t)((uint32_t)((raw - s_prev_raw) + 2048U) & 0x0FFFU) - 2048;
  }
  s_prev_raw  = raw;
  s_have_prev = true;

  const uint32_t dt_cyc = stamp - s_prev_stamp;
  s_prev_stamp = stamp;

  float vel = s_vel_cnt_s;
  if ((dt_cyc > 0U) && (dt_cyc < (BOARD_SYSCLK_HZ / 10UL))) {   /* écarte les trous > 100 ms */
    const float inst = ((float)delta * (float)BOARD_SYSCLK_HZ) / (float)dt_cyc;
    /* IIR du premier ordre. Même forme que partout ailleurs dans ce firmware : pas de
     * tableau d'historique, coût constant, et la constante de temps se lit dans le nom. */
    vel += (inst - vel) / (float)(1 << ENC_VEL_IIR_SHIFT);
  }
  const float vel_max_cnt_s = ENC_VEL_MAX_RAD_S * ((float)ENC_COUNTS_PER_REV / (2.0f * (float)M_PI));
  if (vel >  vel_max_cnt_s) { vel =  vel_max_cnt_s; }
  if (vel < -vel_max_cnt_s) { vel = -vel_max_cnt_s; }

  const int32_t pos = s_pos_cnt + delta;

  /* Seqlock. Les barrières empêchent le compilateur et le cœur de sortir une écriture de
   * la section : sans elles, l'ISR pourrait voir le compteur pair avec des données encore
   * en vol. */
  s_seq++;
  __DMB();
  s_pos_cnt   = pos;
  s_pos_stamp = stamp;
  s_vel_cnt_s = vel;
  __DMB();
  s_seq++;

  s_pub.raw_angle = raw;
  s_pub.turns     = (pos >= 0) ? (pos / ENC_COUNTS_PER_REV)
                               : -((-pos + ENC_COUNTS_PER_REV - 1) / ENC_COUNTS_PER_REV);
  s_pub.present   = true;
  s_pub.reads_ok++;
  s_pub.period_us = (uint16_t)((dt_cyc / ENC_CYC_PER_US) > 65535U ? 65535U
                                                                 : (dt_cyc / ENC_CYC_PER_US));
}

void HAL_I2C_MemRxCpltCallback(I2C_HandleTypeDef *hi2c)
{
  if (hi2c->Instance != I2C4) {
    return;
  }
  const uint32_t now = DWT->CYCCNT;
  s_pub.xfer_us = (uint16_t)((now - s_xfer_start_cyc) / ENC_CYC_PER_US);
  s_last_cplt_ms = HAL_GetTick();

  if (s_reading_status) {
    const uint8_t st = s_buf[0];
    s_pub.status_raw = st;
    s_pub.magnet_ok  = ((st & AS5600_STATUS_MD) != 0U) &&
                       ((st & (AS5600_STATUS_ML | AS5600_STATUS_MH)) == 0U);
    s_pub.present    = true;
  } else {
    PublishAngle((uint16_t)((((uint16_t)s_buf[0] << 8) | s_buf[1]) & 0x0FFFU), now);
  }

  StartNext();
}

void HAL_I2C_ErrorCallback(I2C_HandleTypeDef *hi2c)
{
  if (hi2c->Instance != I2C4) {
    return;
  }
  s_pub.reads_err++;
  s_running = false;      /* la superloop décide de la reprise, pas l'interruption */
}

/* Une chaîne figée ne se signale pas toute seule, et le cas a été rencontré sur carte : un
 * changement de fréquence laissait le canal DMA armé, chaque relance se faisait renvoyer
 * `HAL_BUSY`, et le périphérique restait en attente **sans lever la moindre erreur** —
 * `reads_ok` et `reads_err` tous les deux à zéro pendant que l'angle se figeait sur sa
 * dernière valeur. La cause est corrigée dans `HardReset`, mais un angle qui ne bouge plus
 * et que personne ne déclare faux est exactement le genre de panne qui se propage jusque
 * dans une boucle de position : le garde-fou reste, pour la prochaine cause. */
#define ENC_STALL_MS  20U

void HAL_I2C_AbortCpltCallback(I2C_HandleTypeDef *hi2c)
{
  if (hi2c->Instance == I2C4) {
    s_running = false;
  }
}

void Encoder_IrqDma(void) { HAL_DMA_IRQHandler(&s_dma_rx); }
void Encoder_IrqEv(void)  { HAL_I2C_EV_IRQHandler(&s_i2c); }
void Encoder_IrqEr(void)  { HAL_I2C_ER_IRQHandler(&s_i2c); }

/* ------------------------------------------------------------------------- API */

void Encoder_Init(void)
{
  memset((void *)&s_pub, 0, sizeof(s_pub));

  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  __HAL_RCC_I2C4_CLK_ENABLE();
  __HAL_RCC_DMAMUX1_CLK_ENABLE();
  __HAL_RCC_DMA1_CLK_ENABLE();

  RCC_PeriphCLKInitTypeDef pclk = {0};
  pclk.PeriphClockSelection = RCC_PERIPHCLK_I2C4;
  pclk.I2c4ClockSelection   = RCC_I2C4CLKSOURCE_PCLK1;
  (void)HAL_RCCEx_PeriphCLKConfig(&pclk);

  /* `HALL_DIR` (PB6) fixe le sens de comptage du capteur. Bas = l'angle croît dans le
   * sens horaire. On l'impose plutôt que de le laisser flotter : un sens de comptage qui
   * dépend d'une broche en l'air est exactement le genre de chose qui se découvre le jour
   * où la boucle de position part à l'envers. */
  GPIO_InitTypeDef g = {0};
  g.Pin   = PIN_HALL_DIR;
  g.Mode  = GPIO_MODE_OUTPUT_PP;
  g.Pull  = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(PIN_HALL_DIR_PORT, &g);
  HAL_GPIO_WritePin(PIN_HALL_DIR_PORT, PIN_HALL_DIR, GPIO_PIN_RESET);

  g.Mode      = GPIO_MODE_AF_OD;
  g.Pull      = GPIO_NOPULL;                /* tirages externes R21/R22 */
  g.Speed     = GPIO_SPEED_FREQ_VERY_HIGH;
  g.Pin       = PIN_I2C_SCL;
  g.Alternate = GPIO_AF8_I2C4;              /* PC6 */
  HAL_GPIO_Init(PIN_I2C_SCL_PORT, &g);
  g.Pin       = PIN_I2C_SDA;
  g.Alternate = GPIO_AF3_I2C4;              /* PB7 */
  HAL_GPIO_Init(PIN_I2C_SDA_PORT, &g);

  DmaSetup();

  /* Priorité 3 : sous l'ISR de contrôle (0) et sous la coupure sur faute driver (1). Le
   * capteur ne peut donc retarder ni la régulation ni la mise en sécurité. */
  HAL_NVIC_SetPriority(DMA1_Channel1_IRQn, 3, 0);
  HAL_NVIC_EnableIRQ(DMA1_Channel1_IRQn);
  HAL_NVIC_SetPriority(I2C4_EV_IRQn, 3, 0);
  HAL_NVIC_EnableIRQ(I2C4_EV_IRQn);
  HAL_NVIC_SetPriority(I2C4_ER_IRQn, 3, 1);
  HAL_NVIC_EnableIRQ(I2C4_ER_IRQn);

  /* Fast-mode Plus, comme le prévoit `AGENTS.md` §3. Le schéma annote les tirages R21/R22
   * de 4k7 d'un « TBC » et on pouvait craindre un temps de montée trop lent pour 1 MHz :
   * mesuré sur carte, ça passe. Transfert de 60 µs, un échantillon toutes les 63 µs, et
   * zéro erreur sur plusieurs dizaines de milliers de transferts. `ENC.BUS 400000` permet
   * de redescendre si une autre carte, ou un câblage plus long, s'avère moins docile. */
  if (!I2cSetup(1000000UL)) {
    return;
  }

  /* Le filtre du capteur, avant toute lecture — sinon les premières secondes de mesure
   * portent un retard de 2,2 ms qu'on aurait pu croire structurel. `SF = 11` et un seuil
   * de filtre rapide nul : on veut la réponse la plus courte, et le bruit qui va avec
   * reste sous le pas de quantification. `WD = 0` pour que le capteur ne se mette jamais
   * en veille tout seul après une minute d'immobilité. */
  (void)Encoder_WriteReg(AS5600_REG_CONF_HI, 0x03U);

  s_prev_stamp = DWT->CYCCNT;
  StartNext();
}

void Encoder_Process(void)
{
  /* Deux façons pour la chaîne de mourir, et elles demandent le même remède. Soit une
   * erreur I2C l'a arrêtée proprement (`s_running` retombe), soit elle se croit en vol
   * mais plus rien n'aboutit — c'est le cas du bus trop lent, qui ne lève aucune faute.
   * Le second cas est le plus dangereux : sans ce garde-fou, l'angle se fige sur sa
   * dernière valeur et rien ne le dit. */
  const bool stalled = s_running &&
                       ((HAL_GetTick() - s_last_cplt_ms) > ENC_STALL_MS);
  if (!s_running || stalled) {
    if (stalled) {
      s_pub.reads_err++;
    }
    HardReset(s_pub.bus_hz);
    StartNext();
  }
}

bool Encoder_Sample(float *pos_rad, float *vel_rad_s, uint16_t *age_us)
{
  const uint32_t s1 = s_seq;
  __DMB();
  const int32_t  pos   = s_pos_cnt;
  const uint32_t stamp = s_pos_stamp;
  const float    vel   = s_vel_cnt_s;
  __DMB();
  const uint32_t s2 = s_seq;

  if ((s1 == s2) && ((s1 & 1U) == 0U)) {
    s_isr_pos_cnt   = pos;
    s_isr_stamp     = stamp;
    s_isr_vel_cnt_s = vel;
    s_isr_valid     = true;
  } else if (!s_isr_valid) {
    return false;               /* déchiré et rien en réserve : on le dit, on n'invente pas */
  }

  const uint32_t age_cyc = DWT->CYCCNT - s_isr_stamp;
  const uint16_t age_us_now = (uint16_t)((age_cyc / ENC_CYC_PER_US) > 65535U
                                          ? 65535U : (age_cyc / ENC_CYC_PER_US));
  if (age_us_now > s_pub.age_max_us) {
    s_pub.age_max_us = age_us_now;
  }

  const float lead_s = ((float)age_cyc / (float)BOARD_SYSCLK_HZ)
                     + ((float)ENC_LAG_COMP_US * 1e-6f);
  const float cnt    = (float)s_isr_pos_cnt + (s_isr_vel_cnt_s * lead_s);
  const float k      = (2.0f * (float)M_PI) / (float)ENC_COUNTS_PER_REV;

  *pos_rad   = cnt * k;
  *vel_rad_s = s_isr_vel_cnt_s * k;
  *age_us    = age_us_now;
  return true;
}

void Encoder_Get(Encoder_t *out)
{
  __disable_irq();
  *out = *(const Encoder_t *)&s_pub;
  const int32_t pos = s_pos_cnt;
  const float   vel = s_vel_cnt_s;
  __enable_irq();

  const float k = (2.0f * (float)M_PI) / (float)ENC_COUNTS_PER_REV;
  out->pos_rad   = (float)(pos % ENC_COUNTS_PER_REV) * k;
  out->vel_rad_s = vel * k;
}

void Encoder_ResetStats(void)
{
  __disable_irq();
  s_pub.age_max_us = 0U;
  s_pub.reads_ok   = 0U;
  s_pub.reads_err  = 0U;
  __enable_irq();
}

bool Encoder_SetBusHz(uint32_t hz)
{
  if (TimingFor(hz) == 0U) {
    return false;
  }
  HardReset(hz);
  StartNext();
  return true;
}

/* ------------------------------------------- accès ponctuel, pour la console */

/* Ces deux fonctions prennent le bus en mode bloquant. Elles n'ont le droit d'exister que
 * parce qu'elles ne sont appelées ni depuis l'ISR ni depuis un chemin temps réel : au
 * démarrage pour régler le filtre, et à la demande depuis la console. Le timeout est
 * court exprès — le v1 est mort d'avoir mis une attente I2C sur le chemin critique. */
static bool TakeBus(void)
{
  const bool was = s_running;
  s_running = false;
  if (was) {
    (void)HAL_I2C_Master_Abort_IT(&s_i2c, AS5600_ADDR);
    uint32_t guard = 0U;
    while ((HAL_I2C_GetState(&s_i2c) != HAL_I2C_STATE_READY) && (guard < 200000U)) { guard++; }
  }
  return HAL_I2C_GetState(&s_i2c) == HAL_I2C_STATE_READY;
}

bool Encoder_ReadReg(uint8_t reg, uint8_t *out, uint8_t len)
{
  if (!TakeBus()) {
    return false;
  }
  const bool ok = HAL_I2C_Mem_Read(&s_i2c, AS5600_ADDR, reg, I2C_MEMADD_SIZE_8BIT,
                                   out, len, 10U) == HAL_OK;
  s_have_prev = false;
  StartNext();
  return ok;
}

bool Encoder_WriteReg(uint8_t reg, uint8_t value)
{
  const bool chained = s_running;
  if (chained && !TakeBus()) {
    return false;
  }
  const bool ok = HAL_I2C_Mem_Write(&s_i2c, AS5600_ADDR, reg, I2C_MEMADD_SIZE_8BIT,
                                    &value, 1U, 10U) == HAL_OK;
  if (chained) {
    s_have_prev = false;
    StartNext();
  }
  return ok;
}
