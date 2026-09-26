/**
 * @file signals.c
 * @brief Table des signaux tracables et lecture depuis un instantane. Voir comm/signals.h.
 *
 * La table est la seule source de verite : `Signal_Count()` en derive, la serialisation en
 * derive, et l'interface construit ses courbes a partir de ce qu'elle recoit. Il n'existe
 * aucune liste de signaux cote PC.
 */
#include "comm/signals.h"

#include <string.h>

#include "board.h"
#include "comm/frame.h"

/* ---------------------------------------------------------------- conversions
 *
 * Les deux constantes ci-dessous derivent des reglages de la carte plutot que d'etre
 * ecrites en dur : si l'horloge ou la frequence PWM bouge, `loop.duration_ns` et
 * `loop.load_pct` suivent, au lieu de mentir silencieusement.
 */

/** Duree d'un cycle coeur, en nanosecondes. 1 / 144 MHz ≈ 6.944 ns. */
#define SIGNAL_NS_PER_CYCLE    (1.0e9f / (float)BOARD_SYSCLK_HZ)

/** Periode de la boucle de controle, en nanosecondes. 20 kHz → 50 000 ns. */
#define SIGNAL_LOOP_PERIOD_NS  (1.0e9f / (float)PWM_FREQ_HZ)

/* ---------------------------------------------------------------- accesseurs
 *
 * Un accesseur par signal. Ils sont appeles depuis l'ISR de controle par le scope : pas de
 * division entiere, pas d'acces memoire hors de l'instantane recu.
 */

static float ReadRawIa(const Signal_Snapshot_t *snap) { return (float)snap->raw_ia; }
static float ReadRawIb(const Signal_Snapshot_t *snap) { return (float)snap->raw_ib; }
static float ReadRawIc(const Signal_Snapshot_t *snap) { return (float)snap->raw_ic; }

/* Le brut moins l'offset mesure. Toujours en counts, jamais en amperes : la conversion
 * demande le gain de l'amplificateur, qui se regle par SPI, et l'etape 5 pour la verifier.
 * Un signal en amperes qui sortirait avant cette verification serait faux sans le dire. */
static float ReadCentIa(const Signal_Snapshot_t *snap) { return (float)snap->cent_ia; }
static float ReadCentIb(const Signal_Snapshot_t *snap) { return (float)snap->cent_ib; }
static float ReadCentIc(const Signal_Snapshot_t *snap) { return (float)snap->cent_ic; }

static float ReadEncPosRad(const Signal_Snapshot_t *snap)  { return snap->pos_rad; }

/* 1 ou 0. Sans lui, un arbre immobile sans aimant tracait une position a zero qu'on ne
 * distinguait pas d'une vraie mesure a zero. */
static float ReadEncValid(const Signal_Snapshot_t *snap) { return (float)snap->enc_valid; }
static float ReadEncVelRadS(const Signal_Snapshot_t *snap) { return snap->vel_rad_s; }

static float ReadThetaE(const Signal_Snapshot_t *snap)   { return snap->theta_e_rad; }
static float ReadId(const Signal_Snapshot_t *snap)       { return snap->id_a; }
static float ReadIq(const Signal_Snapshot_t *snap)       { return snap->iq_a; }
static float ReadOlTheta(const Signal_Snapshot_t *snap)  { return snap->ol_theta_rad; }
static float ReadFocValid(const Signal_Snapshot_t *snap) { return (float)snap->foc_valid; }
static float ReadVd(const Signal_Snapshot_t *snap)       { return snap->vd_v; }
static float ReadVq(const Signal_Snapshot_t *snap)       { return snap->vq_v; }

static float ReadEncAgeUs(const Signal_Snapshot_t *snap)
{
  /* Age de l'echantillon d'angle au moment ou l'ISR l'a lu. C'est la moitie mesurable du
   * budget de retard de l'etape 6 : l'autre moitie, le filtre interne du capteur, ne se
   * voit pas d'ici et se lit dans la fiche technique. Tracable pour qu'un ralentissement
   * du bus I2C se voie sur une courbe au lieu de se deviner. */
  return (float)snap->enc_age_us;
}

static float ReadLoopDurationNs(const Signal_Snapshot_t *snap)
{
  return (float)snap->cycles_last * SIGNAL_NS_PER_CYCLE;
}

static float ReadLoopMaxDurationNs(const Signal_Snapshot_t *snap)
{
  return (float)snap->cycles_max * SIGNAL_NS_PER_CYCLE;
}

static float ReadLoopLoadPct(const Signal_Snapshot_t *snap)
{
  /* Fraction de la periode de boucle consommee par le dernier passage dans l'ISR. C'est
   * la grandeur qu'on surveille quand la FOC viendra se greffer : au-dela d'environ 50 %,
   * il ne reste plus assez de marge pour le jitter d'entree en interruption. */
  return ((float)snap->cycles_last * SIGNAL_NS_PER_CYCLE * 100.0f) / SIGNAL_LOOP_PERIOD_NS;
}

/* ---------------------------------------------------------------- table
 *
 * Identifiants figes par docs/protocol.md §6. Un identifiant reste stable tant que le signal
 * garde sa signification et son unite ; changer l'une des deux impose un nouvel identifiant,
 * sinon une capture archivee devient illisible sans qu'on s'en apercoive.
 */
static const SignalDesc_t s_signals[] = {
  { 1U, "current.raw_ia_count", "count", ReadRawIa             },
  { 2U, "current.raw_ib_count", "count", ReadRawIb             },
  { 3U, "current.raw_ic_count", "count", ReadRawIc             },
  { 4U, "loop.duration_ns",     "ns",    ReadLoopDurationNs    },
  { 5U, "loop.max_duration_ns", "ns",    ReadLoopMaxDurationNs },
  { 6U, "loop.load_pct",        "%",     ReadLoopLoadPct       },
  { 7U, "enc.pos_rad",          "rad",   ReadEncPosRad         },
  { 8U, "enc.vel_rad_s",        "rad/s", ReadEncVelRadS        },
  { 9U, "enc.age_us",           "us",    ReadEncAgeUs          },
  { 10U, "current.ia_count",    "count", ReadCentIa            },
  { 11U, "current.ib_count",    "count", ReadCentIb            },
  { 12U, "current.ic_count",    "count", ReadCentIc            },
  { 13U, "enc.valid",           "bool",  ReadEncValid          },
  { 14U, "foc.theta_e_rad",     "rad",   ReadThetaE            },
  { 15U, "foc.id_a",            "A",     ReadId                },
  { 16U, "foc.iq_a",            "A",     ReadIq                },
  { 17U, "ol.theta_rad",        "rad",   ReadOlTheta           },
  { 18U, "foc.valid",           "bool",  ReadFocValid          },
  { 19U, "foc.vd_v",            "V",     ReadVd                },
  { 20U, "foc.vq_v",            "V",     ReadVq                },
};

#define SIGNAL_COUNT  ((uint16_t)(sizeof(s_signals) / sizeof(s_signals[0])))

/* ---------------------------------------------------------------- acces */

uint16_t Signal_Count(void) { return SIGNAL_COUNT; }

const SignalDesc_t *Signal_At(uint16_t index)
{
  return (index < SIGNAL_COUNT) ? &s_signals[index] : NULL;
}

const SignalDesc_t *Signal_ById(uint16_t id)
{
  for (uint16_t i = 0U; i < SIGNAL_COUNT; i++) {
    if (s_signals[i].id == id) {
      return &s_signals[i];
    }
  }
  return NULL;
}

bool Signal_IsKnown(uint16_t id)
{
  return Signal_ById(id) != NULL;
}

/* ---------------------------------------------------------------- serialisation */

/* Meme regle que pour les parametres : champ de largeur fixe complete par des zeros, non
 * termine s'il est plein. Duplique volontairement depuis param.c plutot que partage — les
 * deux tables n'ont pas les memes largeurs et une fonction commune parametrable ne
 * gagnerait rien ici. */
static void PutFixedString(uint8_t *dst, size_t width, const char *src)
{
  (void)memset(dst, 0, width);
  if (src == NULL) {
    return;
  }
  const size_t n = strlen(src);
  (void)memcpy(dst, src, (n < width) ? n : width);
}

bool Signal_SerializeEntry(uint16_t index, uint8_t *dst)
{
  if ((index >= SIGNAL_COUNT) || (dst == NULL)) {
    return false;
  }
  const SignalDesc_t *s = &s_signals[index];
  size_t o = 0U;

  Frame_PutU16(&dst[o], s->id);                      o += 2U;
  dst[o++] = SIGNAL_TYPE_F32;
  dst[o++] = SIGNAL_FLAGS_NONE;
  PutFixedString(&dst[o], SIGNAL_NAME_LEN, s->name); o += SIGNAL_NAME_LEN;
  PutFixedString(&dst[o], SIGNAL_UNIT_LEN, s->unit); o += SIGNAL_UNIT_LEN;

  return (o == SIGNAL_ENTRY_WIRE_LEN);
}

/* ---------------------------------------------------------------- lecture */

bool Signal_Read(uint16_t id, const Signal_Snapshot_t *snap, float *out)
{
  const SignalDesc_t *s = Signal_ById(id);
  if ((s == NULL) || (snap == NULL) || (out == NULL)) {
    return false;
  }
  *out = s->read(snap);
  return true;
}
