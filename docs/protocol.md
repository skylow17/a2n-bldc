# Protocole A2N BLDC v2 — spécification

**Fichier faisant autorité.** Le firmware (`controller-2/`) et l'interface (`interface/`)
implémentent ce document, et rien d'autre. Toute évolution se fait ici
d'abord, puis des deux côtés dans la même passe.

> **Statut.** Le cadrage général reste un brouillon, mais une partie est désormais **figée et
> implémentée des deux côtés** : le framing (§2), le handshake (§4), le dictionnaire de
> paramètres (§5) et les messages `0x0001`–`0x0015`. Ces formats sont verrouillés par des
> vecteurs de référence (§11) que le firmware et l'interface vérifient tous les deux.
>
> Tout le reste — télémétrie, scope, bootloader, CAN — est encore proposé et sera verrouillé
> au fur et à mesure de son implémentation, jalon par jalon.

- Version de protocole décrite : **2.0**
- Transport : USB CDC (canal principal), FDCAN3 (sous-ensemble, pour le flashage)

---

## 1. Deux canaux sur un même lien

| Canal | Usage | Forme sur le lien |
|---|---|---|
| **Binaire** | Paramètres, télémétrie, scope, firmware | `0x01` `<trame COBS>` `0x00` |
| **ASCII** | Console de diagnostic manuel au terminal | `<texte imprimable>` `\r` et/ou `\n` |

**La discrimination se fait sur le premier octet, pas sur le terminateur.** Une trame binaire
s'ouvre par un `0x01` (SOH) ; une ligne de console commence toujours par un caractère imprimable.
Le récepteur lit le premier octet qui suit un terminateur et sait dès lors quel canal il lit, donc
quel terminateur attendre.

> **Pourquoi pas la fin de trame.** Une première version discriminait sur l'octet terminal :
> `0x00` → binaire, `\r`/`\n` → ASCII. C'était faux. COBS garantit l'absence de `0x00` dans la
> trame encodée, mais **pas** celle de `0x0A` ou `0x0D`, qui y apparaissent comme n'importe quel
> autre octet. Une trame binaire était donc coupée en morceaux et prise pour du texte dès qu'elle
> en contenait un — soit 6 % du temps pour une trame de 8 octets, et 98 % pour une de 520. Le coût
> de la correction est d'un octet par trame.

Les deux canaux partagent la même machine à états et les mêmes limites ; la console ASCII n'est
jamais un chemin privilégié.

En réception, chaque canal se resynchronise sur son propre terminateur : un `0x00` reçu en mode
ASCII, ou une trame binaire qui dépasse la taille maximale, font abandonner le message en cours
sans jamais contaminer le suivant.

---

## 2. Trame binaire

Avant encodage COBS :

```
+--------+--------+---------+-----------------+--------+
| msg_id | flags  | seq     | payload         | crc16  |
| u16 LE | u8     | u8      | 0..512 octets   | u16 LE |
+--------+--------+---------+-----------------+--------+
```

- `msg_id` — identifiant de message (table §3)
- `flags` — bit 0 : réponse ; bit 1 : erreur ; bit 2 : trame non sollicitée (push) ;
  bit 3 : fragment suivant à venir
- `seq` — incrémenté par l'émetteur, recopié dans la réponse
- `crc16` — CRC-16/CCITT-FALSE sur `msg_id` → fin de `payload`

La trame est ensuite encodée en **COBS**, précédée de l'octet de début `0x01` et suivie du
`0x00` délimiteur (§1). Toute trame dont le CRC
est faux est jetée et journalisée ; elle n'est jamais réparée ni devinée.

Encodage des nombres : **little-endian**, flottants IEEE-754 32 bits.

**Erreurs** — une réponse avec le bit erreur porte `u16 code` + chaîne optionnelle.
Codes : `CRC`, `LEN`, `ID`, `ARG`, `RANGE`, `STATE`, `BUSY`, `NOTARMED`, `LOCKED`, `NVM`, `FLASH`.

---

## 3. Table des messages

| `msg_id` | Nom | Sens | Rôle |
|---|---|---|---|
| `0x0001` | `HELLO` | PC → FW | Ouverture de session |
| `0x0002` | `DEVICE_INFO` | FW → PC | Identité, versions, hash du dictionnaire |
| `0x0010` | `PARAM_DICT_GET` | PC → FW | Lecture du dictionnaire (paginée) |
| `0x0011` | `PARAM_DICT_ENTRY` | FW → PC | Une entrée du dictionnaire |
| `0x0012` | `PARAM_READ` | PC → FW | Lecture de N paramètres |
| `0x0013` | `PARAM_WRITE` | PC → FW | Écriture de N paramètres (RAM) |
| `0x0014` | `PARAM_SAVE_NVM` | PC → FW | Persistance en flash |
| `0x0015` | `PARAM_RESET_DEFAULTS` | PC → FW | Retour aux valeurs par défaut |
| `0x0020` | `STATE_GET` | PC → FW | État machine, mode, fautes |
| `0x0021` | `STATE_EVENT` | FW → PC | Push : changement d'état ou faute |
| `0x0022` | `ARM` / `DISARM` | PC → FW | Armement |
| `0x0023` | `STOP` | PC → FW | Arrêt immédiat, couple coupé |
| `0x0024` | `FAULT_CLEAR` | PC → FW | Acquittement de faute latchée |
| `0x0030` | `MODE_SET` | PC → FW | Torque / Velocity / Position / Open-loop / Calib |
| `0x0031` | `TARGET_SET` | PC → FW | Consigne du mode courant |
| `0x0032` | `PROFILE_SET` | PC → FW | v_max, accel, decel, jerk |
| `0x0033` | `CALIB_RUN` | PC → FW | Lance une routine de calibration |
| `0x0034` | `CALIB_STATUS` | FW → PC | Avancement / résultat |
| `0x0040` | `TELEM_SIGNALS` | FW → PC | Liste des signaux disponibles |
| `0x0041` | `TELEM_SUBSCRIBE` | PC → FW | Souscription : ids + cadence |
| `0x0042` | `TELEM_FRAME` | FW → PC | Push : timestamp + valeurs |
| `0x0050` | `SCOPE_CONFIG` | PC → FW | Signaux, profondeur, décimation, trigger |
| `0x0051` | `SCOPE_ARM` | PC → FW | Armement de la capture |
| `0x0052` | `SCOPE_STATUS` | FW → PC | Armé / déclenché / plein |
| `0x0053` | `SCOPE_READ` | PC → FW | Lecture du buffer (fragmentée) |
| `0x0060` | `LOG_EVENT` | FW → PC | Push : message de journal horodaté |
| `0x0070` | `BOOT_ENTER` | PC → FW | Reboot en bootloader |
| `0x0071` | `BOOT_INFO` | BL → PC | Slots, versions, CRC, validité |
| `0x0072` | `BOOT_ERASE` | PC → BL | Effacement du slot inactif |
| `0x0073` | `BOOT_WRITE` | PC → BL | Écriture d'un bloc |
| `0x0074` | `BOOT_VERIFY` | PC → BL | Vérification CRC et marquage candidat |
| `0x0075` | `BOOT_ROLLBACK` | PC → BL | Retour au slot précédent |

---

## 4. Handshake

`HELLO` a un payload **vide**. La réponse `DEVICE_INFO` porte 58 octets, dans cet ordre :

```
u16  protocol_version      2.0 → 0x0200
char product[16]           "A2N-BLDC"
char fw_version[16]        "2.0.3"
u32  param_dict_hash       ex. 0xa3f1c920
u32  uid[3]                identifiant unique MCU
u16  param_count
u16  telem_signal_count
u32  capabilities          bitfield : scope, nvm, can, bootloader, encoder_inc…
```

`param_dict_hash` est calculé au build sur l'ensemble des entrées du dictionnaire. Il identifie une
**forme** de configuration : deux firmwares de même hash acceptent la même recette.

---

## 5. Dictionnaire de paramètres

Une entrée décrit complètement un paramètre, ce qui permet à l'interface de construire son widget
sans rien savoir du firmware.

```
u16  id
u8   type          0=u8 1=i8 2=u16 3=i16 4=u32 5=i32 6=f32 7=bool 8=enum
u8   flags         bit0 read_only  bit1 persistent  bit2 requires_disarm
                   bit3 advanced   bit4 calibrated
char name[32]      "pid.iq.kp"
char unit[8]       "A", "rad/s", "V", "degC", ""   (vide = sans dimension)
f32  min, max, default
char group[24]     "Current loop"
```

Une entrée occupe donc exactement **80 octets** sur le lien. Les champs texte sont complétés par
des zéros ; une chaîne qui remplit tout le champ n'est **pas** terminée, et doit être lue comme
un champ borné, jamais comme une chaîne C.

Nommage : `groupe.sous_groupe.nom_unite`, minuscules et underscores. Unités SI, unité dans le nom de
la grandeur quand elle est ambiguë.

### Hash de forme

`param_dict_hash` est le **CRC-32/ISO-HDLC** (polynôme réfléchi `0xEDB88320`, init et xorout
`0xFFFFFFFF` — celui de zlib) de la concaténation des entrées sérialisées ci-dessus, dans l'ordre
de la table.

Le calcul porte sur les octets qui circulent, et non sur une représentation interne. Deux
conséquences utiles : l'hôte peut le recalculer à l'identique sur ce qu'il a reçu, ce qui vérifie
du même coup que le dictionnaire a été transféré intégralement et dans le bon ordre ; et deux
firmwares de même hash acceptent la même recette. Un changement de nom, d'unité, de drapeau, de
borne ou d'ordre change le hash. Une différence que le `f32` ne peut pas représenter, non — c'est
cohérent, puisque les deux firmwares exposent alors réellement la même forme.

### Formats des messages de paramètres

```
PARAM_DICT_GET      u16 start_index, u16 count
PARAM_DICT_ENTRY    u16 start_index, u16 total, u16 count, entry[count]   (80 octets/entrée)
PARAM_READ          u16 count, u16 id[count]
  réponse           u16 count, { u16 id, u8 status, f32 value }[count]
PARAM_WRITE         u16 count, { u16 id, f32 value }[count]
  réponse           u16 count, { u16 id, u8 status }[count]
PARAM_RESET_DEFAULTS   payload vide, réponse vide
```

`count` est plafonné par la taille de payload : **6 entrées** par page de dictionnaire, 72 pour
une lecture, 85 pour une écriture. Le firmware réduit `count` plutôt que de refuser.

`status`, par paramètre : `0` OK, `1` identifiant inconnu, `2` lecture seule, `3` hors bornes,
`4` interdit dans l'état courant.

**Une écriture groupée n'est pas une transaction.** Chaque valeur est appliquée indépendamment et
reçoit son propre statut ; une valeur refusée n'annule pas les autres. L'application atomique
d'une recette, quand elle existera, sera un message distinct qui le dira.

Toutes les valeurs circulent en **`f32`, dans l'unité déclarée**, quel que soit le type réel du
paramètre : l'interface n'a ainsi qu'un seul chemin de code. Le firmware arrondit au plus proche
avant de ranger dans un type entier.

### Groupes prévus

| Groupe | Exemples |
|---|---|
| `motor` | `motor.pole_pairs`, `motor.r_ohm`, `motor.l_h`, `motor.kv` |
| `enc` | `enc.source`, `enc.offset_rad`, `enc.direction`, `enc.cpr` |
| `pid.iq` / `pid.id` | `kp`, `ki`, `out_max_v` |
| `pid.vel` | `kp`, `ki`, `out_max_a`, `filt_hz` |
| `pid.pos` | `kp`, `kd`, `out_max_rad_s` |
| `profile` | `vel_max_rad_s`, `accel_max_rad_s2`, `decel_max_rad_s2`, `jerk_max_rad_s3` |
| `lim` | `i_max_a`, `vel_max_rad_s`, `temp_max_c`, `vbus_min_v`, `vbus_max_v`, `watchdog_ms` |
| `pwm` | `freq_hz`, `deadtime_ns`, `modulation` |
| `drv` | registres DRV8304 exposés (gain shunt, courant de grille, OCP) |

---

## 6. Télémétrie

### Streaming souscrit

`TELEM_SUBSCRIBE` : liste d'ids de signaux + cadence souhaitée (Hz). Le firmware renvoie la cadence
réellement appliquée. Plage utile **100–500 Hz**, limitée par le débit CDC et le nombre de signaux.

`TELEM_FRAME` (push) :

```
u32  timestamp_us
u16  seq            détection de perte de trame côté PC
f32  values[n]      dans l'ordre de la souscription
```

Signaux de base : `pos_rad`, `pos_ref_rad`, `vel_rad_s`, `vel_ref_rad_s`, `iq_a`, `iq_ref_a`,
`id_a`, `id_ref_a`, `vbus_v`, `vmot_v`, `v5_v`, `v3v3_v`, `temp_c`, `duty`, `theta_e_rad`,
`ia_a`, `ib_a`, `ic_a`, `loop_load_pct`.

**Règle firmware** : toute grandeur interne qu'on souhaite pouvoir tracer est déclarée comme signal
au moment où elle est introduite.

### Scope burst

`SCOPE_CONFIG` : signaux, profondeur (échantillons), facteur de décimation depuis la cadence de
boucle, et trigger — source, front (`rising` / `falling` / `both`), seuil, pré-trigger en pourcent.
`SCOPE_ARM` puis `SCOPE_STATUS` en push à chaque changement. `SCOPE_READ` dumpe le buffer en trames
fragmentées.

Cadence native ≈ **20 kHz** (cadence de la boucle de courant). C'est le seul moyen de voir une
réponse indicielle de boucle de courant — la capacité qui manquait au firmware v1.

---

## 7. Journal

`LOG_EVENT` (push) : `u32 timestamp_ms`, `u8 level` (debug / info / warn / error / fault),
`u16 code`, chaîne. L'interface fusionne ce flux avec ses propres événements (`gui`) et ceux du
serveur MCP (`mcp`) dans une console unique, filtrable par niveau et par source.

---

## 8. Bootloader

Découpage flash (aligné sur les deux banques de 256 ko, pour permettre l'écriture d'un slot
pendant l'exécution depuis l'autre), séquence de mise à jour et rollback : voir
`../controller-2/AGENTS.md` §4.

Le bootloader implémente le même framing binaire (§2) et les messages `0x0070`–`0x0075`, sur **USB
CDC et CAN**. Il n'expose ni paramètres, ni télémétrie, ni commande moteur. Au démarrage : PWM en
haute impédance et DRV8304 désactivé avant toute autre initialisation.

---

## 9. Console ASCII

Conservée pour le diagnostic sans outil, dans l'esprit du `docs/COMMANDS.md` du firmware v1.
Une ligne = une commande, réponse `OK ...` ou `ERR <code>`. Elle couvre l'essentiel :
`PING`, `INFO?`, `STATE?`, `ARM`, `DISARM`, `STOP`, `FAULTCLR`, `SENS.ALL?`, `PARAM? <name>`,
`PARAM <name> <value>`, `MODE <mode>`, `TARGET <value>`.

Implémentées à ce jour : `PING`, `INFO?`, `STATS?`, `STATS.RESET`, `LINK?`, `PROTO?`,
`SELFTEST`, `PWM?`, `STOP`. Les autres arrivent avec la machine à états (M3).

**`STOP` existe dès maintenant**, et coupe `MOE` — les six sorties passent en haute impédance.
C'est aujourd'hui déjà l'état au repos, donc la commande ne change rien en pratique ; elle est là
quand même, parce qu'une commande d'arrêt doit préexister au danger plutôt qu'arriver avec lui, et
parce que l'interface s'appuie dessus.

Différence avec le v1 : les valeurs sont en **unités SI lisibles**, plus en Q16 / Q15.

---

## 10. Transport CAN

Hors périmètre de l'interface PC pour le contrôle. Prévu pour le flashage et le pilotage
inter-nœuds. Les trames binaires sont fragmentées sur des trames CAN classiques ; le découpage des
identifiants sera spécifié au moment de l'implémentation.

---

## 11. Vecteurs de référence

`docs/protocol-vectors.json` fige les octets attendus : CRC-16, CRC-32, COBS, trames complètes, et
la sérialisation du dictionnaire avec son hash.

Il est produit par `tools/gen_protocol_vectors.py`, une **troisième** implémentation en Python,
ancrée sur des références publiées — les vecteurs de l'article COBS de Cheshire & Baker, et les
vecteurs d'arbitrage `crc16("123456789") == 0x29B1` et `crc32("123456789") == 0xCBF43926`.

Ce détour a une raison précise. Si le firmware produisait les vecteurs que vérifie l'interface, on
ne testerait que leur ressemblance : une erreur commune de lecture de cette spécification passerait
inaperçue des deux côtés. Avec un tiers indépendant, il faut que trois lectures coïncident.

Les trois sommets du triangle :

| Qui | Comment |
|---|---|
| Python | `python tools/gen_protocol_vectors.py` — régénère et vérifie ses propres invariants |
| Interface | `cd interface && npm test` |
| Firmware | commande console `SELFTEST`, **sur la cible** — c'est le seul endroit où le codec est éprouvé avec le vrai compilateur et la vraie endianness |

Le générateur écrit aussi `controller-2/Core/Inc/comm/selftest_vectors.h`, la même table en C. Les
deux fichiers sont commités ; le script ne tourne que lorsque la spécification change.

Réponse attendue de `SELFTEST` sur une carte saine :

```
OK total=43 failed=0 crc16=0 cobs_enc=0 cobs_dec=0 frame=0 dict_hash=A7C793EB dict_ok=1
```

`total` suit le nombre de vecteurs et changera quand on en ajoutera ; ce qui compte est
`failed=0` et `dict_ok=1`. Un `dict_ok=0` avec un `failed` par ailleurs nul signifie que la table
de paramètres a changé sans que les vecteurs soient régénérés — pas que le codec est cassé.
