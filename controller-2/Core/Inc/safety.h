/**
 * @file safety.h
 * @brief Barrière de sécurité du firmware : tout ce qui met de la puissance sur les sorties
 *        passe par ici, et rien ne redémarre tout seul.
 *
 * `AGENTS.md` §4 pose deux règles que ce module applique, et que ni l'hôte, ni la console,
 * ni le serveur MCP ne peuvent contourner — la barrière est dans le firmware, jamais dans
 * le PC :
 *
 *  - **Watchdog de flux de commandes.** Un hôte présent mais figé est aussi dangereux qu'un
 *    câble arraché : le port reste ouvert, `DTR` reste haut, et plus personne n'envoie
 *    `STOP`. Dès que les sorties sont actives, le firmware exige un message — n'importe
 *    lequel, trame binaire ou ligne ASCII — au moins tous les `SAFETY_CMD_TIMEOUT_MS`.
 *    Passé ce délai, le couple tombe. `link_usb.c` couvre le cas où l'hôte disparaît
 *    franchement ; celui-ci couvre le cas où il reste là sans rien dire.
 *  - **Toute faute est latchée.** Une coupure laisse une cause lisible et refuse toute
 *    réactivation tant qu'un acquittement explicite n'est pas arrivé. Pas de reprise
 *    silencieuse : si la cause est encore là, l'acquittement échoue et le dit.
 *
 * L'état armé/désarmé complet arrive avec M3. Ce module n'attend pas M3 : une commande
 * d'arrêt et ses raisons doivent préexister au danger, pas arriver avec lui.
 */
#ifndef SAFETY_H
#define SAFETY_H

#include <stdbool.h>
#include <stdint.h>

/** Raison de la dernière coupure. Ordre stable : la valeur part dans le protocole. */
typedef enum
{
  SAFETY_OK          = 0,  /**< aucune faute latchée                                  */
  SAFETY_HOST_GONE   = 1,  /**< `DTR` retombé, bus suspendu, port refermé             */
  SAFETY_CMD_TIMEOUT = 2,  /**< hôte présent, mais plus un message depuis le délai    */
  SAFETY_DRV_FAULT   = 3,  /**< `nFAULT` du DRV8304                                   */
  SAFETY_REQUESTED   = 4,  /**< `STOP` demandé — coupure normale, pas une faute       */
  SAFETY_OVERCURRENT = 5,  /**< un courant centré a dépassé `SAFETY_OC_LIMIT_COUNTS`  */
} SafetyReason_t;

/* Limite de courant, en counts centrés, sur chacune des trois phases. 20 V/V sur 10 mΩ
 * donnent 0,2 V/A, soit 4,03 mA par count sous une référence de 3,3 V : 500 counts font
 * ≈ 2,0 A. C'est la limite de l'étape 5, sur banc, alimentation limitée en courant.
 *
 * Une limite, pas un réglage (`AGENTS.md` §4) : elle ne se change pas depuis l'hôte, et
 * elle ne vaut que pour le gain qu'elle suppose — d'où la relecture de `CSA_CONTROL` à
 * chaque activation. À 5 V/V les mêmes 500 counts feraient 8 A, et la limite se serait
 * élargie sans que personne n'y touche.
 *
 * C'est une seconde ligne. L'ISR ne voit qu'un échantillon toutes les 50 µs, et un bobinage
 * de faible inductance peut dépasser la limite entre deux : la première ligne est la limite
 * de courant de l'alimentation. */
#define SAFETY_OC_LIMIT_COUNTS  500

/* Durée maximale d'une impulsion d'essai. Sous les 250 ms du watchdog de flux : une
 * impulsion n'a jamais besoin d'être entretenue par l'hôte pour aller à son terme. */
#define SAFETY_PULSE_MAX_MS     200U

/** Réponse d'une demande d'activation, pour que la console dise pourquoi elle refuse. */
typedef enum
{
  SAFETY_EN_OK      = 0,
  SAFETY_EN_LATCHED = 1,   /**< une faute attend son acquittement                       */
  SAFETY_EN_LINK    = 2,   /**< pas d'hôte                                              */
  SAFETY_EN_NOZERO  = 3,   /**< zéro de la chaîne de courant jamais mesuré              */
  SAFETY_EN_CAL     = 4,   /**< `CAL` levé ou campagne en cours : courants aveugles     */
  SAFETY_EN_CSA     = 5,   /**< amplis hors de la configuration que la limite suppose   */
} SafetyEnable_t;

typedef struct
{
  SafetyReason_t reason;        /**< cause de la dernière coupure                     */
  bool           latched;       /**< vrai tant qu'un acquittement n'a pas eu lieu     */
  bool           outputs_live;  /**< image de `Pwm_IsEnabled()`, pour un état cohérent*/
  uint32_t       since_cmd_ms;  /**< âge du dernier message reçu                      */
  uint32_t       trips;         /**< coupures par le watchdog depuis le reset         */
} SafetyStatus_t;

void Safety_Init(void);

/**
 * Un message complet vient d'arriver de l'hôte. Appelé par `rx_router.c` pour les deux
 * canaux, avant l'exécution : ce qui compte est qu'un hôte vivant parle, pas ce qu'il dit.
 */
void Safety_NoteCommand(void);

/** À appeler dans la superloop. Ne bloque jamais, ne dialogue avec rien. */
void Safety_Process(void);

/**
 * Seule voie autorisée pour activer les sorties. Refuse si une faute est latchée, si l'hôte
 * n'est pas là, si la surveillance du courant ne peut pas fonctionner — zéro jamais mesuré,
 * `CAL` levé, amplis reconfigurés. Ne vérifie pas les fautes du DRV — l'appelant le fait, il
 * sait répondre.
 *
 * @param pulse_ms 0 pour une activation sans limite de durée (le watchdog de flux la tient),
 *                 sinon 1 à `SAFETY_PULSE_MAX_MS` : l'ISR coupe elle-même au terme.
 */
SafetyEnable_t Safety_EnableOutputs(uint32_t pulse_ms);

/**
 * Surveillance à chaque passage de la boucle, **depuis l'ISR** : surintensité et terme de
 * l'impulsion. Ne coûte qu'une comparaison quand les sorties sont coupées.
 */
void Safety_OnControlTick(int16_t ia, int16_t ib, int16_t ic);

/** Pire courant absolu vu par phase depuis la dernière activation, en counts. */
void Safety_GetPeaks(uint16_t out[3]);

/** Coupe les sorties et enregistre la cause. Sûr depuis une ISR. */
void Safety_Cut(SafetyReason_t reason);

/**
 * Acquitte la faute latchée. Échoue tant que la cause est encore présente — un
 * acquittement qui réussit alors que rien n'a changé n'acquitte rien.
 */
bool Safety_ClearFault(void);

void Safety_GetStatus(SafetyStatus_t *out);

/** Libellé court et stable, pour la console. En anglais : l'utilisateur le lit. */
const char *Safety_ReasonName(SafetyReason_t reason);

#endif /* SAFETY_H */
