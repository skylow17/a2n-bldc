/**
 * @file param_table.c
 * @brief LA table des parametres. Ajouter un parametre = ajouter une ligne ici.
 *
 * Ce que contient cette table a M1b, et pourquoi si peu : seuls des parametres qui existent
 * reellement. Le firmware n'a pas encore de regulateur, donc pas de gain a exposer ; declarer
 * des `pid.*` ou des `lim.*` maintenant donnerait a l'interface un dictionnaire qui ment — des
 * champs reglables qui ne pilotent rien, et pire, des limites de securite qui ne limitent rien.
 * Les entrees arrivent avec le code qui les consomme, jalon par jalon.
 *
 * On trouve donc ici deux familles :
 *
 *  - la configuration reelle de la carte, en lecture seule. Elle est deja utile : elle permet
 *    a l'interface de verifier que le firmware tourne bien a la frequence qu'elle croit, et
 *    de convertir les grandeurs brutes ;
 *  - cinq parametres de diagnostic `dbg.echo_*`, inscriptibles, un par famille de type. Ils ne
 *    pilotent rien et l'annoncent par leur nom. Leur role est d'exercer completement le chemin
 *    lecture/ecriture et la conversion de chaque type, ce qui est precisement l'objet de M1b.
 *    Ils disparaitront quand de vrais parametres inscriptibles existeront.
 */
#include "comm/param.h"

#include "board.h"
#include "pwm.h"

/* ---------------------------------------------------------------- stockage des reglages */

/* Constantes de configuration, exposees en lecture seule. Elles sont copiees ici depuis les
 * macros du build : l'interface lit ainsi la valeur reellement compilee, pas une valeur
 * saisie a la main de son cote. */
static const uint32_t s_sysclk_hz     = BOARD_SYSCLK_HZ;
static const uint16_t s_vref_mv       = BOARD_VREF_MV;
static const uint32_t s_pwm_freq_hz   = PWM_FREQ_HZ;
static const uint16_t s_pwm_arr       = PWM_ARR;
static const uint16_t s_pwm_ccr4_trig = PWM_TRIG_CCR4;
static const float    s_deadtime_ns   = (float)PWM_DEADTIME_DTG * 1000000000.0f / (float)BOARD_SYSCLK_HZ;

/* Parametres du moteur et du capteur, mesures sur carte (etapes 5 a 9, 2026-09-26) et
 * persistants. Tous a zero par defaut : zero veut dire « pas encore mesure », et c'est ce
 * qu'une carte neuve doit annoncer plutot qu'une valeur d'un autre moteur. Rien ne les
 * consomme encore — M3 le fera. `requires_disarm` : les changer moteur alimente changerait
 * la commutation en marche.
 *
 * Les gains des trois voies de courant n'y sont pas, et c'est voulu : ils fixent ce que vaut
 * la limite de surintensite en amperes, et une valeur ecrite depuis l'hote pourrait
 * l'elargir. Ils restent des constantes (`imot.h`). */
static uint8_t s_motor_pole_pairs;
static float   s_motor_r_ohm;
static float   s_motor_l_h;
static float   s_enc_elec_offset_rad;
static int8_t  s_enc_direction;
static float   s_imot_scale_a;

#define MOTOR_FLAGS  (PARAM_FLAG_PERSISTENT | PARAM_FLAG_REQUIRES_DISARM | PARAM_FLAG_CALIBRATED)

/* Parametres de diagnostic du codec. Sans effet sur le materiel. */
static uint32_t s_dbg_u32;
static int16_t  s_dbg_i16;
static float    s_dbg_f32;
static bool     s_dbg_bool;
static uint8_t  s_dbg_enum;

/* ---------------------------------------------------------------- la table */

/* Les identifiants sont figes une fois publies : une recette enregistree les reference.
 * Un parametre retire laisse son identifiant libre plutot que de le voir recycle. */
const ParamDesc_t g_param_table[] = {
  /* id      type              flags                    name                unit    group        min          max          def */
  { 0x0001U, PARAM_TYPE_U32,   PARAM_FLAG_READ_ONLY,    "board.sysclk_hz",  "Hz",   "Board",     0.0f,        200000000.0f, 0.0f, (void *)&s_sysclk_hz     },
  { 0x0002U, PARAM_TYPE_U16,   PARAM_FLAG_READ_ONLY,    "board.vref_mv",    "mV",   "Board",     0.0f,        65535.0f,     0.0f, (void *)&s_vref_mv       },

  { 0x0010U, PARAM_TYPE_U32,   PARAM_FLAG_READ_ONLY,    "pwm.freq_hz",      "Hz",   "PWM",       0.0f,        100000.0f,    0.0f, (void *)&s_pwm_freq_hz   },
  { 0x0011U, PARAM_TYPE_U16,   PARAM_FLAG_READ_ONLY,    "pwm.arr",          "",     "PWM",       0.0f,        65535.0f,     0.0f, (void *)&s_pwm_arr       },
  { 0x0012U, PARAM_TYPE_F32,   PARAM_FLAG_READ_ONLY,    "pwm.deadtime_ns",  "ns",   "PWM",       0.0f,        10000.0f,     0.0f, (void *)&s_deadtime_ns   },
  { 0x0013U, PARAM_TYPE_U16,   PARAM_FLAG_READ_ONLY,    "pwm.ccr4_trig",    "",     "PWM",       0.0f,        65535.0f,     0.0f, (void *)&s_pwm_ccr4_trig },

  { 0x0200U, PARAM_TYPE_U8,    MOTOR_FLAGS,             "motor.pole_pairs", "",     "Motor",     0.0f,        64.0f,        0.0f, (void *)&s_motor_pole_pairs    },
  { 0x0201U, PARAM_TYPE_F32,   MOTOR_FLAGS,             "motor.r_ohm",      "ohm",  "Motor",     0.0f,        100.0f,       0.0f, (void *)&s_motor_r_ohm         },
  { 0x0202U, PARAM_TYPE_F32,   MOTOR_FLAGS,             "motor.l_h",        "H",    "Motor",     0.0f,        0.1f,         0.0f, (void *)&s_motor_l_h           },
  { 0x0210U, PARAM_TYPE_F32,   MOTOR_FLAGS,             "enc.elec_offset_rad", "rad", "Motor",   0.0f,        6.2832f,      0.0f, (void *)&s_enc_elec_offset_rad },
  { 0x0211U, PARAM_TYPE_I8,    MOTOR_FLAGS,             "enc.direction",    "",     "Motor",    -1.0f,        1.0f,         0.0f, (void *)&s_enc_direction       },
  { 0x0220U, PARAM_TYPE_F32,   MOTOR_FLAGS,             "imot.scale_a",     "A/count", "Motor",  0.0f,        0.02f,        0.0f, (void *)&s_imot_scale_a        },

  { 0x0100U, PARAM_TYPE_U32,   0U,                      "dbg.echo_u32",     "",     "Debug",     0.0f,        4294967040.0f, 0.0f, (void *)&s_dbg_u32       },
  { 0x0101U, PARAM_TYPE_I16,   0U,                      "dbg.echo_i16",     "",     "Debug",    -32768.0f,    32767.0f,     0.0f, (void *)&s_dbg_i16       },
  { 0x0102U, PARAM_TYPE_F32,   0U,                      "dbg.echo_f32",     "A",    "Debug",    -1000.0f,     1000.0f,      0.0f, (void *)&s_dbg_f32       },
  { 0x0103U, PARAM_TYPE_BOOL,  0U,                      "dbg.echo_bool",    "",     "Debug",     0.0f,        1.0f,         0.0f, (void *)&s_dbg_bool      },
  { 0x0104U, PARAM_TYPE_ENUM,  0U,                      "dbg.echo_enum",    "",     "Debug",     0.0f,        3.0f,         0.0f, (void *)&s_dbg_enum      },
};

const uint16_t g_param_count = (uint16_t)(sizeof(g_param_table) / sizeof(g_param_table[0]));

void Param_GetMotor(Param_Motor_t *out)
{
  out->pole_pairs      = s_motor_pole_pairs;
  out->r_ohm           = s_motor_r_ohm;
  out->l_h             = s_motor_l_h;
  out->elec_offset_rad = s_enc_elec_offset_rad;
  out->direction       = s_enc_direction;
  out->imot_scale_a    = s_imot_scale_a;
}
