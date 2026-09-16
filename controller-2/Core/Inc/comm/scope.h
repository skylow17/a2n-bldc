/**
 * @file scope.h
 * @brief Capture burst a la cadence de la boucle — docs/protocol.md §6.
 *
 * C'est la capacite qui manquait entierement au firmware v1, et la raison pour laquelle
 * aucun regulateur n'y etait reglable autrement qu'a l'aveugle : le streaming souscrit
 * plafonne a 500 Hz, ce qui suffit a surveiller une machine mais pas a voir une reponse
 * indicielle de boucle de courant. Le scope enregistre en RAM **a 20 kHz**, sur condition
 * de declenchement, puis la superloop dumpe le tampon.
 *
 * Partage du travail, et c'est la seule regle qui compte ici :
 *
 * - `Scope_OnControlTick()` est appele depuis l'ISR de controle. Il copie au plus quatre
 *   `float` et n'emet rien. Aucun acces USB, aucune boucle non bornee, aucun appel qui
 *   attend. C'est le seul consommateur autorise dans l'ISR.
 * - tout le reste — configuration, armement, lecture, transitions poussees — se fait depuis
 *   la superloop. Le tampon n'est lu qu'a l'etat `complete`, ou l'ISR n'y touche plus.
 *
 * Le tampon est dimensionne au maximum du protocole et alloue statiquement : 2 048 points
 * × 4 signaux × 4 octets = 32 Kio. Une allocation dynamique dans un firmware de commande
 * moteur n'apporterait rien et introduirait un mode de defaillance de plus.
 */
#ifndef COMM_SCOPE_H
#define COMM_SCOPE_H

#include <stdbool.h>
#include <stdint.h>

#include "comm/signals.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Bornes du protocole — docs/protocol.md §6. */
#define SCOPE_MAX_SIGNALS      4U
#define SCOPE_MAX_DEPTH        2048U
#define SCOPE_MAX_DECIMATION   256U

/** Modes de declenchement, valeurs du protocole. */
typedef enum
{
  SCOPE_TRIG_IMMEDIATE = 0,
  SCOPE_TRIG_RISING    = 1,
  SCOPE_TRIG_FALLING   = 2,
  SCOPE_TRIG_EITHER    = 3,
} ScopeTrigger_t;

/** Etats, valeurs du protocole. */
typedef enum
{
  SCOPE_IDLE      = 0,
  SCOPE_ARMED     = 1,
  SCOPE_TRIGGERED = 2,
  SCOPE_COMPLETE  = 3,
} ScopeState_t;

typedef struct
{
  uint16_t depth;                            /**< 1..SCOPE_MAX_DEPTH                     */
  uint16_t decimation;                       /**< 1..SCOPE_MAX_DECIMATION, depuis 20 kHz */
  uint16_t pretrigger_samples;               /**< 0..depth-1                             */
  uint8_t  trigger_mode;                     /**< ScopeTrigger_t                         */
  uint8_t  signal_count;                     /**< 1..SCOPE_MAX_SIGNALS                   */
  uint16_t trigger_signal_id;                /**< doit appartenir a la selection, sauf
                                              *   en mode immediate                      */
  float    threshold;
  uint16_t signal_ids[SCOPE_MAX_SIGNALS];
} ScopeConfig_t;

typedef struct
{
  ScopeState_t state;
  uint8_t      signal_count;
  uint16_t     captured;             /**< points actuellement conservés               */
  uint16_t     depth;
  uint16_t     trigger_index;        /**< index logique ; 0xffff avant declenchement  */
  uint16_t     decimation;
  uint32_t     sample_period_ns;     /**< 50 000 × decimation                         */
  uint32_t     start_timestamp_us;   /**< horodatage du premier point ; 0 avant trig  */
} ScopeStatus_t;

/** Valeur de `trigger_index` tant que le declenchement n'a pas eu lieu. */
#define SCOPE_TRIGGER_INDEX_NONE  0xFFFFU

/** Configuration par defaut : capture immediate des trois courants bruts. */
void Scope_Init(void);

/** Configuration courante, telle que le firmware l'a normalisee. */
const ScopeConfig_t *Scope_GetConfig(void);

/** Instantane coherent de l'etat, pris sous masquage d'interruption. */
void Scope_GetStatus(ScopeStatus_t *out);

/**
 * @brief Valide et applique une configuration.
 * @return false si elle viole une borne du protocole, si un identifiant de signal est
 *         inconnu ou duplique, ou si le signal de declenchement n'appartient pas a la
 *         selection hors mode immediate. La configuration precedente est alors intacte.
 *
 * Refuse aussi pendant une capture : changer les colonnes sous les points deja acquis
 * produirait un tampon dont une moitie ne veut pas dire la meme chose que l'autre.
 */
bool Scope_Configure(const ScopeConfig_t *cfg);

/**
 * @brief Arme la capture, ou la relance si elle etait deja armee. Le tampon precedent
 *        est perdu.
 * @return true. Le booleen existe pour le site d'appel de proto.c, qui traduit un refus
 *         en ERR_BUSY ; aucun refus n'est defini aujourd'hui.
 *
 * Le protocole (docs/protocol.md §6) attache explicitement ERR_BUSY a SCOPE_CONFIG, et a
 * lui seul : rien n'y interdit de reamorcer une capture. Le device simule accepte lui
 * aussi le reamorcage. Refuser ici creerait un ecart de comportement entre la carte et le
 * simulateur — exactement la classe de defaut que ce depot a deja payee deux fois.
 *
 * Consequence a garder en tete : un scope arme sur un front qui n'arrive jamais ne peut
 * pas etre reconfigure, puisque SCOPE_CONFIG repond ERR_BUSY. Le protocole n'offre pas de
 * desarmement. C'est un manque de la specification, pas du firmware — voir STATUS.md.
 */
bool Scope_Arm(void);

/**
 * @brief Lit un point de la capture terminee.
 * @param sample index logique, 0 = point le plus ancien conserve
 * @param signal rang dans la selection de SCOPE_CONFIG
 * @return false hors de l'etat `complete` ou hors des bornes ; `*out` est laisse intact.
 */
bool Scope_ReadValue(uint16_t sample, uint8_t signal, float *out);

/**
 * @brief Relève-et-efface le drapeau de changement d'etat.
 *
 * Les transitions arrivent dans l'ISR, mais SCOPE_STATUS doit partir depuis la superloop :
 * ce drapeau est le passage de relais entre les deux. Appele par Proto_Process().
 */
bool Scope_ConsumeStatusDirty(void);

/**
 * @brief Point d'entree ISR : soumet un instantane a la capture.
 *
 * Sans effet hors des etats `armed` et `triggered`. Cout borne : une decimation, une
 * evaluation de declenchement, et au plus SCOPE_MAX_SIGNALS appels d'accesseur.
 */
void Scope_OnControlTick(const Signal_Snapshot_t *snap);

#ifdef __cplusplus
}
#endif
#endif /* COMM_SCOPE_H */
