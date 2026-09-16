/**
 * @file scope.c
 * @brief Capture burst a la cadence de la boucle. Voir comm/scope.h.
 *
 * Le tampon est un anneau de `depth` points, et son dimensionnement n'est pas un hasard :
 * il vaut exactement ce qu'il faut pour qu'un point conserve ne soit jamais ecrase.
 *
 * Au declenchement, le point courant occupe l'emplacement `w`. La capture doit conserver
 * `pretrigger` points avant lui et `depth - pretrigger - 1` apres, soit `depth` cases
 * consecutives finissant en `w + depth - pretrigger - 1`, c'est-a-dire `w - pretrigger - 1`
 * modulo `depth` : la case juste avant le premier point garde. L'ecriture post-trigger
 * s'arrete donc une case avant de mordre sur le pre-trigger. Aucune copie, aucun second
 * tampon, et rien a verifier dans l'ISR.
 */
#include "comm/scope.h"

#include <math.h>
#include <string.h>

#include "board.h"

/** Duree d'un tick de boucle, en microsecondes. 20 kHz -> 50 us. */
#define SCOPE_TICK_US  (1000000UL / PWM_FREQ_HZ)

/* Tampon de capture, dimensionne au maximum du protocole : 2048 x 4 x 4 = 32 Kio.
 * Alloue statiquement — voir l'en-tete pour la raison. */
static float s_buf[SCOPE_MAX_DEPTH][SCOPE_MAX_SIGNALS];

static ScopeConfig_t s_cfg;

/* Accesseurs resolus une fois pour toutes a la configuration : l'ISR ne fait aucune
 * recherche par identifiant, elle suit des pointeurs deja valides. */
static const SignalDesc_t *s_readers[SCOPE_MAX_SIGNALS];

/** Rang du signal de declenchement dans la selection, 0xFF s'il n'y figure pas. */
static uint8_t s_trigger_slot;

/* Etat partage entre l'ISR et la superloop. `volatile` parce que l'ISR le modifie sous les
 * pieds de la boucle principale ; les lectures composees passent par un masquage court. */
static volatile ScopeState_t s_state;
static volatile uint16_t     s_write;            /* prochaine case a ecrire             */
static volatile uint16_t     s_filled;           /* points valides, plafonne a depth     */
static volatile uint16_t     s_captured;         /* points conserves par la capture      */
static volatile uint16_t     s_decim_count;
static volatile uint16_t     s_post_remaining;   /* points restant apres declenchement   */
static volatile uint16_t     s_start_index;      /* case du point logique 0              */
static volatile uint16_t     s_trigger_index;
static volatile uint32_t     s_start_timestamp_us;
static volatile bool         s_status_dirty;
static volatile float        s_prev_value;       /* signal de declenchement, point n-1   */
static volatile bool         s_prev_valid;

/* ---------------------------------------------------------------- configuration */

static bool ResolveReaders(const ScopeConfig_t *cfg,
                           const SignalDesc_t **readers,
                           uint8_t *trigger_slot)
{
  *trigger_slot = 0xFFU;

  for (uint8_t i = 0U; i < cfg->signal_count; i++) {
    const SignalDesc_t *d = Signal_ById(cfg->signal_ids[i]);
    if (d == NULL) {
      return false;
    }
    /* Un doublon donnerait deux colonnes identiques dans la capture, en consommant une
     * des quatre voies pour rien. L'interface le lit comme une erreur, pas comme un choix. */
    for (uint8_t j = 0U; j < i; j++) {
      if (cfg->signal_ids[j] == cfg->signal_ids[i]) {
        return false;
      }
    }
    if (cfg->signal_ids[i] == cfg->trigger_signal_id) {
      *trigger_slot = i;
    }
    readers[i] = d;
  }
  for (uint8_t i = cfg->signal_count; i < SCOPE_MAX_SIGNALS; i++) {
    readers[i] = NULL;
  }
  return true;
}

bool Scope_Configure(const ScopeConfig_t *cfg)
{
  if (cfg == NULL) {
    return false;
  }
  if ((cfg->depth == 0U) || (cfg->depth > SCOPE_MAX_DEPTH)) {
    return false;
  }
  if ((cfg->decimation == 0U) || (cfg->decimation > SCOPE_MAX_DECIMATION)) {
    return false;
  }
  if (cfg->pretrigger_samples >= cfg->depth) {
    return false;
  }
  if ((cfg->signal_count == 0U) || (cfg->signal_count > SCOPE_MAX_SIGNALS)) {
    return false;
  }
  if (cfg->trigger_mode > (uint8_t)SCOPE_TRIG_EITHER) {
    return false;
  }
  /* NaN echoue toutes les comparaisons d'ordre : un seuil NaN donnerait un scope arme qui
   * ne se declenche jamais, sans que rien ne le dise. Meme raisonnement que
   * Param_WriteValue(). */
  if ((cfg->trigger_mode != (uint8_t)SCOPE_TRIG_IMMEDIATE) && isnan(cfg->threshold)) {
    return false;
  }

  const SignalDesc_t *readers[SCOPE_MAX_SIGNALS];
  uint8_t trigger_slot;
  if (!ResolveReaders(cfg, readers, &trigger_slot)) {
    return false;
  }
  /* Hors mode immediate, le signal de declenchement doit etre capture : sans cela, le
   * point de declenchement ne serait visible sur aucune des courbes rendues. */
  if ((cfg->trigger_mode != (uint8_t)SCOPE_TRIG_IMMEDIATE) && (trigger_slot == 0xFFU)) {
    return false;
  }

  /* Une capture en cours interdit le changement : les points deja acquis ne voudraient
   * plus dire la meme chose que les suivants. */
  __disable_irq();
  if ((s_state == SCOPE_ARMED) || (s_state == SCOPE_TRIGGERED)) {
    __enable_irq();
    return false;
  }
  s_cfg = *cfg;
  /* Copie explicite plutot que memcpy : les deux tableaux portent des pointeurs vers du
   * const, et le passage par `void *` fait perdre ce qualificatif — un avertissement de
   * plus dans un build qui doit rester muet. */
  for (uint8_t i = 0U; i < SCOPE_MAX_SIGNALS; i++) {
    s_readers[i] = readers[i];
  }
  s_trigger_slot       = trigger_slot;
  s_state              = SCOPE_IDLE;
  s_write              = 0U;
  s_filled             = 0U;
  s_captured           = 0U;
  s_decim_count        = 0U;
  s_post_remaining     = 0U;
  s_start_index        = 0U;
  s_trigger_index      = SCOPE_TRIGGER_INDEX_NONE;
  s_start_timestamp_us = 0U;
  s_prev_valid         = false;
  __enable_irq();
  return true;
}

void Scope_Init(void)
{
  /* Meme configuration par defaut que le device simule : capture immediate et pleine
   * profondeur des trois courants bruts. Un SCOPE_ARM nu fonctionne donc sans
   * configuration prealable, sur la carte comme sur le simulateur. */
  ScopeConfig_t cfg;
  (void)memset(&cfg, 0, sizeof(cfg));
  cfg.depth              = SCOPE_MAX_DEPTH;
  cfg.decimation         = 1U;
  cfg.pretrigger_samples = 0U;
  cfg.trigger_mode       = (uint8_t)SCOPE_TRIG_IMMEDIATE;
  cfg.signal_count       = 3U;
  cfg.trigger_signal_id  = 1U;
  cfg.threshold          = 0.0f;
  cfg.signal_ids[0]      = 1U;
  cfg.signal_ids[1]      = 2U;
  cfg.signal_ids[2]      = 3U;

  s_state = SCOPE_IDLE;
  if (!Scope_Configure(&cfg)) {
    /* La table de signaux ne porte pas les identifiants attendus : le scope resterait
     * muet sans qu'on sache pourquoi. Autant le dire au demarrage. */
    Board_FatalError("scope");
  }
  s_status_dirty = false;
}

const ScopeConfig_t *Scope_GetConfig(void) { return &s_cfg; }

/* ---------------------------------------------------------------- etat */

void Scope_GetStatus(ScopeStatus_t *out)
{
  if (out == NULL) {
    return;
  }
  /* L'etat est compose de plusieurs champs que l'ISR met a jour ensemble. Les lire sans
   * masquer donnerait un instantane mixte — par exemple `complete` avec le `captured`
   * d'avant la derniere ecriture. Le masquage dure quelques dizaines de cycles. */
  __disable_irq();
  out->state              = s_state;
  out->signal_count       = s_cfg.signal_count;
  out->captured           = (s_state == SCOPE_COMPLETE) ? s_captured : s_filled;
  out->depth              = s_cfg.depth;
  out->trigger_index      = s_trigger_index;
  out->decimation         = s_cfg.decimation;
  out->sample_period_ns   = (uint32_t)SCOPE_TICK_US * 1000U * (uint32_t)s_cfg.decimation;
  out->start_timestamp_us = s_start_timestamp_us;
  __enable_irq();
}

bool Scope_Arm(void)
{
  /* Aucun refus : reamorcer une capture en cours est licite et repart de zero. Voir
   * l'en-tete pour la raison — le protocole ne definit ERR_BUSY que pour SCOPE_CONFIG,
   * et le device simule accepte le reamorcage. */
  __disable_irq();
  s_write              = 0U;
  s_filled             = 0U;
  s_captured           = 0U;
  s_decim_count        = 0U;
  s_post_remaining     = 0U;
  s_start_index        = 0U;
  s_trigger_index      = SCOPE_TRIGGER_INDEX_NONE;
  s_start_timestamp_us = 0U;
  s_prev_valid         = false;
  s_state              = SCOPE_ARMED;
  s_status_dirty       = true;
  __enable_irq();
  return true;
}

bool Scope_ConsumeStatusDirty(void)
{
  __disable_irq();
  const bool dirty = s_status_dirty;
  s_status_dirty = false;
  __enable_irq();
  return dirty;
}

bool Scope_ReadValue(uint16_t sample, uint8_t signal, float *out)
{
  if (out == NULL) {
    return false;
  }
  /* Aucun masquage : a l'etat `complete`, Scope_OnControlTick() sort immediatement et ne
   * touche plus ni au tampon ni aux index. C'est la seule lecture du tampon autorisee. */
  if (s_state != SCOPE_COMPLETE) {
    return false;
  }
  if ((sample >= s_captured) || (signal >= s_cfg.signal_count)) {
    return false;
  }
  const uint16_t idx = (uint16_t)(((uint32_t)s_start_index + sample) % s_cfg.depth);
  *out = s_buf[idx][signal];
  return true;
}

/* ---------------------------------------------------------------- capture (ISR) */

static bool EdgeFired(uint8_t mode, float prev, float cur, float threshold)
{
  const bool rising  = (prev < threshold) && (cur >= threshold);
  const bool falling = (prev > threshold) && (cur <= threshold);

  switch ((ScopeTrigger_t)mode) {
    case SCOPE_TRIG_RISING:  return rising;
    case SCOPE_TRIG_FALLING: return falling;
    case SCOPE_TRIG_EITHER:  return rising || falling;
    default:                 return false;
  }
}

void Scope_OnControlTick(const Signal_Snapshot_t *snap)
{
  const ScopeState_t state = s_state;
  if (((state != SCOPE_ARMED) && (state != SCOPE_TRIGGERED)) || (snap == NULL)) {
    return;
  }

  /* Decimation : un point conserve tous les `decimation` passages de boucle. */
  s_decim_count++;
  if (s_decim_count < s_cfg.decimation) {
    return;
  }
  s_decim_count = 0U;

  const uint16_t w = s_write;
  const uint8_t  n = s_cfg.signal_count;
  for (uint8_t i = 0U; i < n; i++) {
    s_buf[w][i] = s_readers[i]->read(snap);
  }
  s_write = (uint16_t)(((uint32_t)w + 1U) % s_cfg.depth);
  if (s_filled < s_cfg.depth) {
    s_filled++;
  }

  if (state == SCOPE_TRIGGERED) {
    if (s_post_remaining > 0U) {
      s_post_remaining--;
    }
    if (s_post_remaining == 0U) {
      s_captured     = s_cfg.depth;
      s_state        = SCOPE_COMPLETE;
      s_status_dirty = true;
    }
    return;
  }

  /* --- etat `armed` : evaluation du declenchement sur le point qu'on vient d'ecrire --- */

  const bool pretrigger_ready = (s_filled > s_cfg.pretrigger_samples);
  bool fire = false;

  if (s_cfg.trigger_mode == (uint8_t)SCOPE_TRIG_IMMEDIATE) {
    /* Meme en immediat, le pre-trigger demande est honore : il n'existe aucun point avant
     * l'armement, il faut donc le temps de le constituer. */
    fire = pretrigger_ready;
  } else {
    const float cur = s_buf[w][s_trigger_slot];
    /* Le point precedent est tenu a jour des l'armement, y compris pendant que le
     * pre-trigger se remplit : sinon le premier front eligible serait manque. */
    if (s_prev_valid && pretrigger_ready) {
      fire = EdgeFired(s_cfg.trigger_mode, s_prev_value, cur, s_cfg.threshold);
    }
    s_prev_value = cur;
    s_prev_valid = true;
  }

  if (!fire) {
    return;
  }

  /* Le point courant est le point de declenchement. Le premier point conserve est
   * `pretrigger` cases avant lui — voir l'explication de l'anneau en tete de fichier. */
  s_start_index   = (uint16_t)(((uint32_t)w + s_cfg.depth - s_cfg.pretrigger_samples)
                               % s_cfg.depth);
  s_trigger_index = s_cfg.pretrigger_samples;

  /* Horodatage du premier point conserve. Meme convention que la telemetrie dans proto.c :
   * `ticks` est deja incremente pour le passage courant, donc le premier echantillon de la
   * boucle porte l'instant 0. */
  const uint32_t first_tick = snap->ticks
                            - ((uint32_t)s_cfg.pretrigger_samples * s_cfg.decimation);
  s_start_timestamp_us = (first_tick - 1U) * (uint32_t)SCOPE_TICK_US;

  s_post_remaining = (uint16_t)(s_cfg.depth - s_cfg.pretrigger_samples - 1U);
  if (s_post_remaining == 0U) {
    s_captured = s_cfg.depth;
    s_state    = SCOPE_COMPLETE;
  } else {
    s_state    = SCOPE_TRIGGERED;
  }
  s_status_dirty = true;
}
