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
} SafetyReason_t;

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
 * Seule voie autorisée pour activer les sorties. Refuse si une faute est latchée ou si
 * l'hôte n'est pas là. Ne vérifie pas le DRV — l'appelant le fait, il sait répondre.
 */
bool Safety_EnableOutputs(void);

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
