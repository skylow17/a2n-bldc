# Protocole A2N BLDC v2 — spécification

**Fichier faisant autorité.** Le firmware (`a2n-bldc-controller-2`) et l'interface
(`a2n-bldc-interface`) implémentent ce document, et rien d'autre. Toute évolution se fait ici
d'abord, puis des deux côtés dans la même passe.

> **Statut : brouillon de cadrage.** Les identifiants et formats ci-dessous sont proposés, pas figés.
> Ils seront verrouillés au démarrage du firmware v2. Ce document sert dès maintenant de référence
> commune pour la maquette et la structure de l'interface.

- Version de protocole décrite : **2.0**
- Transport : USB CDC (canal principal), FDCAN3 (sous-ensemble, pour le flashage)

---

## 1. Deux canaux sur un même lien

| Canal | Usage | Détection |
|---|---|---|
| **Binaire** | Paramètres, télémétrie, scope, firmware | Trame délimitée par `0x00`, encodage COBS |
| **ASCII** | Console de diagnostic manuel au terminal | Ligne terminée par `\r` ou `\n`, ne contient aucun `0x00` |

Le firmware discrimine sur l'octet de fin : `0x00` → trame binaire, `\r`/`\n` → ligne ASCII.
Les deux canaux partagent la même machine à états et les mêmes limites ; la console ASCII n'est
jamais un chemin privilégié.

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

La trame est ensuite encodée en **COBS** et suivie d'un `0x00` délimiteur. Toute trame dont le CRC
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

`HELLO` → `DEVICE_INFO` :

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

Nommage : `groupe.sous_groupe.nom_unite`, minuscules et underscores. Unités SI, unité dans le nom de
la grandeur quand elle est ambiguë.

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
`../a2n-bldc-controller-2/AGENTS.md` §4.

Le bootloader implémente le même framing binaire (§2) et les messages `0x0070`–`0x0075`, sur **USB
CDC et CAN**. Il n'expose ni paramètres, ni télémétrie, ni commande moteur. Au démarrage : PWM en
haute impédance et DRV8304 désactivé avant toute autre initialisation.

---

## 9. Console ASCII

Conservée pour le diagnostic sans outil, dans l'esprit de `a2n-bldc-controller/docs/COMMANDS.md`.
Une ligne = une commande, réponse `OK ...` ou `ERR <code>`. Elle couvre l'essentiel :
`PING`, `INFO?`, `STATE?`, `ARM`, `DISARM`, `STOP`, `FAULTCLR`, `SENS.ALL?`, `PARAM? <name>`,
`PARAM <name> <value>`, `MODE <mode>`, `TARGET <value>`.

Différence avec le v1 : les valeurs sont en **unités SI lisibles**, plus en Q16 / Q15.

---

## 10. Transport CAN

Hors périmètre de l'interface PC pour le contrôle. Prévu pour le flashage et le pilotage
inter-nœuds. Les trames binaires sont fragmentées sur des trames CAN classiques ; le découpage des
identifiants sera spécifié au moment de l'implémentation.
