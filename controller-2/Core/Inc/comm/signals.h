/**
 * @file signals.h
 * @brief Dictionnaire de signaux auto-decrit — docs/protocol.md §6.
 *
 * Meme principe que le dictionnaire de parametres : le firmware publie la liste de ce qu'il
 * sait tracer, l'interface la decouvre a la connexion et construit ses courbes sans
 * connaitre le firmware. Ajouter un signal = ajouter une ligne dans la table de signals.c,
 * et rien a changer cote PC.
 *
 * Un signal n'est pas une variable : c'est une **lecture d'instantane**. L'ISR de controle
 * produit un `Signal_Snapshot_t` coherent, et chaque signal sait en extraire sa valeur. Cette
 * indirection a une raison precise : le scope echantillonne dans l'ISR et le streaming dans la
 * superloop, sur le meme dictionnaire. Sans instantane commun, les deux chemins liraient des
 * grandeurs prises a des instants differents et une capture melangerait des points incoherents.
 *
 * Regle de travail (../../docs/protocol.md §6) : toute grandeur interne qu'on souhaite pouvoir
 * tracer est declaree ici au moment ou elle est introduite. Une mesure brute garde un nom qui
 * dit qu'elle est brute — `current.raw_ia_count` et non `current.ia_a` : un signal en amperes
 * n'apparaitra qu'apres calibration de la chaine de courant.
 */
#ifndef COMM_SIGNALS_H
#define COMM_SIGNALS_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Longueurs des champs texte dans la trame. Memes regles que pour les parametres : les
 * chaines sont completees par des zeros et ne sont pas terminees quand elles remplissent
 * exactement le champ. Le lecteur traite le champ comme borne, jamais comme une chaine C. */
#define SIGNAL_NAME_LEN  32U
#define SIGNAL_UNIT_LEN  8U

/** Taille d'une entree serialisee dans TELEM_SIGNALS — docs/protocol.md §6. */
#define SIGNAL_ENTRY_WIRE_LEN  (2U + 1U + 1U + SIGNAL_NAME_LEN + SIGNAL_UNIT_LEN)  /* = 44 */

/* Type sur le fil. Toutes les valeurs circulent en f32, comme pour les parametres : c'est la
 * representation unique retenue sur la liaison, pour que l'interface n'ait qu'un seul chemin
 * de code. Les autres valeurs de ce champ sont reservees. */
#define SIGNAL_TYPE_F32  6U

/** Champ `flags` d'une entree : reserve, doit valoir 0 — docs/protocol.md §6. */
#define SIGNAL_FLAGS_NONE  0U

/**
 * @brief Instantane coherent de l'etat temps reel, produit par l'ISR de controle.
 *
 * Les grandeurs brutes y sont rangees telles qu'elles ont ete acquises. La conversion en
 * unite physique appartient au signal, pas a l'instantane : c'est ce qui permet d'exposer
 * `loop.duration_ns` et `loop.load_pct` a partir du meme compteur de cycles DWT.
 */
typedef struct
{
  uint32_t ticks;        /**< nombre d'appels de l'ISR depuis le demarrage      */
  uint32_t cycles_last;  /**< duree du dernier passage, en cycles coeur         */
  uint32_t cycles_max;   /**< pire cas depuis le dernier reset des statistiques */
  uint16_t raw_ia;       /**< brut ADC phase A, non calibre                     */
  uint16_t raw_ib;
  uint16_t raw_ic;
  float    pos_rad;      /**< angle mecanique extrapole, AS5600                 */
  float    vel_rad_s;    /**< vitesse mecanique estimee                         */
  uint16_t enc_age_us;   /**< age de l'echantillon d'angle a cet instant        */
  uint8_t  enc_valid;    /**< 0 tant qu'aucun angle coherent n'a ete publie     */
} Signal_Snapshot_t;

/**
 * @brief Description d'un signal tracable.
 *
 * `read` est appele depuis l'ISR par le scope : il doit etre court, sans division entiere
 * ni branchement inutile, et ne toucher que l'instantane recu.
 */
typedef struct
{
  uint16_t    id;
  const char *name;   /**< "loop.load_pct" — au plus SIGNAL_NAME_LEN caracteres */
  const char *unit;   /**< "count", "ns", "%" ; "" si sans dimension            */
  float     (*read)(const Signal_Snapshot_t *snap);
} SignalDesc_t;

uint16_t            Signal_Count(void);
const SignalDesc_t *Signal_At(uint16_t index);
const SignalDesc_t *Signal_ById(uint16_t id);

/** Vrai si `id` figure au dictionnaire. Utilise pour valider une souscription. */
bool Signal_IsKnown(uint16_t id);

/** Serialise l'entree `index` sur SIGNAL_ENTRY_WIRE_LEN octets. Faux si l'index sort. */
bool Signal_SerializeEntry(uint16_t index, uint8_t *dst);

/**
 * @brief Lit la valeur d'un signal dans un instantane.
 * @return false si l'identifiant est inconnu ; `*out` est alors laisse intact.
 */
bool Signal_Read(uint16_t id, const Signal_Snapshot_t *snap, float *out);

#ifdef __cplusplus
}
#endif
#endif /* COMM_SIGNALS_H */
