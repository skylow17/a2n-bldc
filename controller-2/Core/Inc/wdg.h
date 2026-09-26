/**
 * @file wdg.h
 * @brief Chien de garde matériel (IWDG) de l'application, et cause du dernier démarrage.
 *
 * Ce qu'il couvre : une superloop figée. L'ISR de contrôle, prioritaire, continuerait de
 * tourner — mais le watchdog de flux de commandes vit dans la superloop, et une carte dont la
 * superloop ne tourne plus ne couperait plus le couple si l'hôte se taisait. L'IWDG la
 * relance, et un redémarrage laisse les sorties en haute impédance.
 *
 * Ce qu'il ne fait pas : se substituer au chien de garde de probation. Pendant qu'un candidat
 * attend sa confirmation, c'est l'IWDG armé par le bootloader (≈ 2 s) qui décide du rollback ;
 * le rafraîchir d'ici garderait en vie un candidat qui ne confirme jamais. Il n'est donc
 * démarré qu'hors probation — et un candidat qui confirme redémarre de toute façon.
 *
 * Un reset logiciel l'arrête sur ce G473 : constaté à chaque mise à jour du 2026-09-26, où
 * l'application tournait des dizaines de minutes après la probation sans jamais rafraîchir
 * celui que le bootloader avait armé. Entrer dans le bootloader le désarme donc.
 */
#ifndef WDG_H
#define WDG_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Délai du chien de garde. La superloop ne bloque jamais plus de quelques dizaines de
 *  millisecondes — la sauvegarde en NVM fige le cœur 22 ms, le plus long relevé. LSI ≈ 32 kHz
 *  à quelques pour cent près : 200 ms de consigne en garantissent bien plus de 150. */
#define WDG_TIMEOUT_MS  200U

typedef enum
{
  WDG_CAUSE_OTHER = 0,
  WDG_CAUSE_POWER,      /**< mise sous tension ou chute d'alimentation (BOR)   */
  WDG_CAUSE_PIN,        /**< broche NRST                                        */
  WDG_CAUSE_SOFTWARE,   /**< `NVIC_SystemReset` : mise à jour, entrée bootloader */
  WDG_CAUSE_IWDG,       /**< chien de garde indépendant                          */
  WDG_CAUSE_WWDG,
  WDG_CAUSE_LOWPOWER,
  WDG_CAUSE_OPTION,     /**< rechargement des octets d'option                    */
  WDG_CAUSE_CLEARED,    /**< aucun drapeau : le bootloader les a effacés avant de
                         *   sauter ici — `BootShared_PrevEnd` en dit alors plus  */
} Wdg_Cause_t;

/** Relève la cause du démarrage et efface les drapeaux. À appeler tôt : rien d'autre ne
 *  doit les effacer avant. */
void Wdg_CaptureCause(void);

Wdg_Cause_t Wdg_Cause(void);
const char *Wdg_CauseName(Wdg_Cause_t c);

/** Démarre l'IWDG — sauf en probation, voir l'en-tête. Irréversible jusqu'au reset. */
void Wdg_Start(bool in_trial);

/** Superloop, à chaque tour. Sans effet tant que `Wdg_Start` n'a pas démarré le chien. */
void Wdg_Kick(void);

bool Wdg_Running(void);

#ifdef __cplusplus
}
#endif

#endif /* WDG_H */
