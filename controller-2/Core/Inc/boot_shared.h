/**
 * @file boot_shared.h
 * @brief Poignée de main en SRAM entre l'application et le bootloader A/B.
 *
 * Deux messages passent par là, et ils ne peuvent pas passer ailleurs : un reset efface les
 * registres, la flash coûte un cycle d'effacement, et il n'existe aucun périphérique commun
 * aux deux images. Les 256 derniers octets de la SRAM sont donc soustraits aux deux linkers
 * (`ld/*.ld`, `LENGTH = 0x1FF00`) et réservés à ce dialogue.
 *
 * ```
 *   application  --ENTER-->   reset   -->  bootloader reste en mise a jour
 *   bootloader   --TRIAL-->   saut    -->  application candidate, IWDG arme
 *   application  --CONFIRM--> reset   -->  bootloader valide le candidat
 * ```
 *
 * Le mot est toujours accompagné de son complément. La SRAM n'est pas initialisée après une
 * coupure d'alimentation : sans ce contrôle, un motif résiduel pourrait se faire passer pour
 * une demande et bloquer la carte en bootloader. C'est exactement ce que la spécification
 * exige d'éviter — `../../docs/protocol.md` §8.
 *
 * **Le consommateur efface.** Chaque mot est lu une fois puis invalidé, par l'application ici
 * et par le bootloader de son côté. Un message qui survivrait à sa lecture se rejouerait au
 * reset suivant.
 */
#ifndef BOOT_SHARED_H
#define BOOT_SHARED_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Base de la zone réservée : 256 derniers octets des 128 ko de SRAM. */
#define BOOT_SHARED_BASE  0x2001FF00UL
#define BOOT_SHARED_SIZE  256U

/* Mots de commande. Les valeurs n'ont pas de sens particulier, sinon d'être improbables
 * dans de la SRAM résiduelle et distinctes les unes des autres. */
#define BOOT_SHARED_ENTER    0xB007E17EUL  /**< app → bootloader : reste en mise a jour */
#define BOOT_SHARED_TRIAL    0xB007471AUL  /**< bootloader → app : tu es le candidat     */
#define BOOT_SHARED_CONFIRM  0xB007C0FFUL  /**< app → bootloader : point de sante atteint */

/**
 * @brief Délai de probation, en millisecondes.
 *
 * Le bootloader arme l'IWDG avant de sauter sur le candidat ; celui-ci doit confirmer avant
 * expiration. On vise nettement plus court que la seconde pour laisser de la marge au
 * démarrage USB, qui est le plus lent de la séquence.
 */
#define BOOT_TRIAL_CONFIRM_MS  600U

/**
 * @brief Nombre de passages d'ISR exigés avant de confirmer.
 *
 * 10 000 ticks à 20 kHz = 500 ms de boucle temps réel réellement exécutée. Le critère porte
 * sur les ticks et pas seulement sur l'horloge : une superloop vivante avec une ISR morte
 * est précisément la panne que le rollback doit attraper, et c'est celle que le v1 avait.
 */
#define BOOT_TRIAL_CONFIRM_TICKS  10000U

/**
 * @brief Consomme le message laissé par le bootloader. À appeler une fois, tôt au démarrage.
 *
 * Après cet appel, la zone partagée est neutre : un reset inattendu ne rejouera rien.
 */
void BootShared_Init(void);

/** Vrai si cette exécution est une probation — le bootloader nous a marqués candidat. */
bool BootShared_IsTrial(void);

/**
 * @brief Appelé depuis la superloop. Confirme la probation dès que la santé est établie.
 *
 * Sans effet hors probation. Quand les critères sont réunis, écrit le mot de confirmation
 * et redémarre : c'est le bootloader qui rend le candidat actif, pas l'application.
 */
void BootShared_Process(void);

/**
 * @brief Demande à redémarrer en bootloader, et redémarre.
 *
 * Appelé par `Proto_Process()` après que la réponse à `BOOT_ENTER` a été mise en file et que
 * le délai de vidage est écoulé. Ne rend jamais la main.
 */
void BootShared_RequestEnter(void);

/**
 * @brief Décide si la probation peut être confirmée.
 *
 * Isolée du matériel pour être testable hors cible : c'est une décision de sûreté, et la
 * relire ne suffit pas. Confirmer trop tôt rendrait actif un firmware qui n'a pas prouvé
 * qu'il tourne ; ne jamais confirmer provoquerait un rollback sur un firmware sain.
 *
 * @param elapsed_ms      temps écoulé depuis le démarrage
 * @param ticks_advanced  passages d'ISR observés depuis le démarrage
 * @param pwm_enabled     état du pont de puissance
 */
bool BootShared_ShouldConfirm(uint32_t elapsed_ms, uint32_t ticks_advanced, bool pwm_enabled);

#ifdef BOOT_IMAGE
/* ------------------------------------------------------------------ côté bootloader
 *
 * L autre bout du même protocole. Ces trois fonctions ne sont bâties que dans l image du
 * bootloader — l application n a rien à en faire, et les exposer des deux côtés inviterait
 * à confirmer sa propre probation.
 */

/**
 * @brief L application a-t-elle demandé à rester en mise à jour ? Consomme le message.
 *
 * Appelé une fois, tôt. Après cet appel la zone est neutre : une coupure d alimentation ne
 * peut donc pas laisser la carte bloquée en bootloader.
 */
bool BootShared_TakeEnter(void);

/**
 * @brief Le candidat a-t-il atteint son point de santé ? Consomme le message.
 *
 * C est ce mot, et lui seul, qui autorise la promotion du candidat. Son absence vaut échec :
 * le rollback est le comportement par défaut, pas une réaction à un signal d erreur.
 */
bool BootShared_TakeConfirm(void);

/** Marque l exécution qui suit comme une probation. Écrit juste avant le saut. */
void BootShared_MarkTrial(void);
#endif /* BOOT_IMAGE */

#ifdef __cplusplus
}
#endif
#endif /* BOOT_SHARED_H */
