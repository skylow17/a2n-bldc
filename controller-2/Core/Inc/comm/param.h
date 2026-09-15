/**
 * @file param.h
 * @brief Dictionnaire de parametres auto-decrit — docs/protocol.md §5.
 *
 * Le firmware publie la description complete de ses parametres ; l'interface construit ses
 * panneaux a partir de cette description, sans rien connaitre du firmware. C'est ce qui evite
 * de repeter la meme liste des deux cotes et de la laisser diverger — l'un des defauts qui
 * rendaient le v1 penible a piloter.
 *
 * Chaque entree pointe vers le stockage reel de la grandeur (`storage`), pas vers une copie :
 * le module proprietaire declare sa variable normalement, la table l'expose. Il n'y a donc
 * jamais deux valeurs a resynchroniser.
 *
 * Regle de travail : ajouter un parametre = ajouter une ligne dans param_table.c.
 */
#ifndef COMM_PARAM_H
#define COMM_PARAM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Types — docs/protocol.md §5. Les valeurs numeriques sont celles du protocole. */
typedef enum
{
  PARAM_TYPE_U8   = 0,
  PARAM_TYPE_I8   = 1,
  PARAM_TYPE_U16  = 2,
  PARAM_TYPE_I16  = 3,
  PARAM_TYPE_U32  = 4,
  PARAM_TYPE_I32  = 5,
  PARAM_TYPE_F32  = 6,
  PARAM_TYPE_BOOL = 7,
  PARAM_TYPE_ENUM = 8,
} ParamType_t;

#define PARAM_FLAG_READ_ONLY       0x01U
#define PARAM_FLAG_PERSISTENT      0x02U
#define PARAM_FLAG_REQUIRES_DISARM 0x04U
#define PARAM_FLAG_ADVANCED        0x08U
#define PARAM_FLAG_CALIBRATED      0x10U

/* Longueurs des champs texte dans la trame. Les chaines sont completees par des zeros et
 * ne sont pas forcement terminees quand elles occupent tout le champ. */
#define PARAM_NAME_LEN   32U
#define PARAM_UNIT_LEN   8U
#define PARAM_GROUP_LEN  24U

/** Taille d'une entree serialisee, telle qu'elle circule dans PARAM_DICT_ENTRY. */
#define PARAM_ENTRY_WIRE_LEN  (2U + 1U + 1U + PARAM_NAME_LEN + PARAM_UNIT_LEN \
                               + 4U + 4U + 4U + PARAM_GROUP_LEN)   /* = 80 */

typedef struct
{
  uint16_t    id;
  uint8_t     type;        /* ParamType_t */
  uint8_t     flags;
  const char *name;        /* "pwm.freq_hz" — au plus PARAM_NAME_LEN caracteres */
  const char *unit;        /* "Hz", "A", "" si sans dimension */
  const char *group;       /* libelle affiche par l'interface */
  float       min;
  float       max;
  float       def;
  void       *storage;     /* adresse de la grandeur reelle, du type indique */
} ParamDesc_t;

typedef enum
{
  PARAM_OK = 0,
  PARAM_ERR_ID,         /* identifiant inconnu */
  PARAM_ERR_READ_ONLY,
  PARAM_ERR_RANGE,      /* hors [min, max] */
  PARAM_ERR_STATE,      /* modification interdite dans l'etat courant */
} ParamStatus_t;

/** Calcule le hash du dictionnaire. A appeler une fois au demarrage, avant tout handshake. */
void Param_Init(void);

uint16_t           Param_Count(void);
const ParamDesc_t *Param_At(uint16_t index);
const ParamDesc_t *Param_ById(uint16_t id);

/**
 * Hash de la **forme** du dictionnaire : CRC-32 de la concatenation des entrees serialisees,
 * dans l'ordre de la table. Deux firmwares de meme hash acceptent la meme recette.
 *
 * Il se recalcule a l'identique cote PC a partir des entrees recues, ce qui en fait aussi un
 * controle d'integrite de bout en bout du transfert du dictionnaire.
 */
uint32_t Param_DictHash(void);

/** Serialise l'entree `index` sur PARAM_ENTRY_WIRE_LEN octets. Rend false si l'index sort. */
bool Param_SerializeEntry(uint16_t index, uint8_t *dst);

/** Lecture / ecriture en flottant, quel que soit le type reel : c'est la representation
 *  unique retenue sur la liaison, pour que l'interface n'ait qu'un seul chemin de code. */
ParamStatus_t Param_ReadValue(uint16_t id, float *out);
ParamStatus_t Param_WriteValue(uint16_t id, float value);

/** Remet toutes les entrees inscriptibles a leur valeur par defaut. */
void Param_ResetDefaults(void);

#endif /* COMM_PARAM_H */
