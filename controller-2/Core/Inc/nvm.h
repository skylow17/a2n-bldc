/**
 * @file nvm.h
 * @brief Persistance du dictionnaire de paramètres en flash — `docs/protocol.md` §5,
 *        « Persistance ».
 *
 * Deux pages de 2 ko alternées au début de la zone `nvm params` (`AGENTS.md` §4). Chaque
 * sauvegarde écrit un enregistrement complet — numéro de séquence et CRC — sur la page qui ne
 * porte **pas** l'enregistrement courant : l'ancien reste intact tant que le nouveau n'est pas
 * écrit et relu juste. Une coupure pendant l'écriture laisse donc toujours un enregistrement
 * valide. C'est la même mécanique que les métadonnées du bootloader, pour la même raison.
 *
 * Au chargement, rien n'est pris sur parole : chaque entrée est confrontée au dictionnaire
 * — identifiant connu, drapeau `persistent`, même type, valeur dans les bornes — et le reste
 * est ignoré et compté. Un enregistrement écrit par un autre firmware ne peut donc ni charger
 * une grandeur que celui-ci ne reconnaît plus, ni contourner une borne resserrée depuis.
 */
#ifndef NVM_H
#define NVM_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct
{
  bool     valid;      /**< un enregistrement valide a été trouvé ou écrit              */
  uint32_t seq;        /**< son numéro de séquence                                       */
  uint8_t  page;       /**< 0 = A, 1 = B, 0xFF = aucune                                  */
  uint16_t entries;    /**< entrées qu'il contient                                       */
  uint16_t loaded;     /**< entrées restaurées au démarrage                              */
  uint16_t skipped;    /**< entrées ignorées au démarrage : inconnues, retypées, hors bornes */
  uint32_t saves;      /**< sauvegardes réussies depuis le reset                         */
} Nvm_Status_t;

typedef enum
{
  NVM_OK = 0,
  NVM_ERR_LIVE,        /**< sorties de puissance actives : l'effacement figerait l'ISR    */
  NVM_ERR_FLASH,       /**< effacement, programmation ou relecture en échec              */
  NVM_ERR_FULL,        /**< plus d'entrées persistantes qu'une page n'en tient            */
} Nvm_Result_t;

/**
 * Relit le dernier enregistrement valide et restaure les valeurs qu'il porte. À appeler
 * après `Param_Init` et avant le premier handshake : l'hôte doit lire les valeurs restaurées,
 * jamais les défauts qui les précèdent.
 */
void Nvm_Load(void);

/**
 * Écrit toutes les entrées persistantes. Depuis la superloop uniquement : bloquant le temps
 * d'un effacement de page et de sa programmation, quelques dizaines de millisecondes.
 * @param saved rempli avec le nombre d'entrées écrites, peut être NULL.
 */
Nvm_Result_t Nvm_Save(uint16_t *saved);

void Nvm_GetStatus(Nvm_Status_t *out);

/**
 * À appeler en tête de `NMI_Handler`. Acquitte une erreur ECC double survenue **pendant une
 * lecture de la zone** — un enregistrement déchiré par une coupure — et rend vrai ; la lecture
 * se poursuit avec une valeur que le CRC refusera. Rend faux pour toute autre NMI, qui reste
 * fatale.
 */
bool Nvm_OnNmi(void);

#ifdef __cplusplus
}
#endif

#endif /* NVM_H */
