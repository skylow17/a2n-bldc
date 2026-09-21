# Protocole A2N BLDC v2 — spécification

**Fichier faisant autorité.** Le firmware (`controller-2/`) et l'interface (`interface/`)
implémentent ce document, et rien d'autre. Toute évolution se fait ici
d'abord, puis des deux côtés dans la même passe.

> **Statut.** Le cadrage général reste un brouillon, mais une partie est désormais **figée et
> implémentée des deux côtés** : le framing (§2), le handshake (§4), le dictionnaire de
> paramètres (§5) et les messages `0x0001`–`0x0015`. Ces formats sont verrouillés par des
> vecteurs de référence (§11) que le firmware et l'interface vérifient tous les deux.
>
> La télémétrie et le scope (§6, messages `0x0040`–`0x0053`) sont également figés. Le
> Le bootloader USB (§8, messages `0x0070`–`0x0075`) est également figé. Le transport CAN
> reste proposé et sera verrouillé au moment de son implémentation.

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
| `0x0076` | `BOOT_REBOOT` | PC → BL | Redémarre après vérification |

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

### Dictionnaire de signaux

Le PC découvre les signaux comme il découvre les paramètres. `TELEM_SIGNALS` est une requête
paginée, de payload `u16 start_index, u16 count`. Sa réponse porte :

```
u16  start_index
u16  total
u16  count
signal[count]
```

Chaque `signal` occupe exactement **44 octets** :

```
u16  id
u8   type          6=f32 ; les autres valeurs sont réservées
u8   flags         réservé, doit valoir 0
char name[32]
char unit[8]
```

Les règles des champs texte bornés du §5 s'appliquent. Une page contient au plus 11 entrées.
Un identifiant est stable tant que le signal conserve sa signification et son unité.

Signaux présents à M1c :

| id | Nom | Unité | Source |
|---:|---|---|---|
| 1 | `current.raw_ia_count` | `count` | ADC1 IN1, non calibré |
| 2 | `current.raw_ib_count` | `count` | ADC1 IN2, non calibré |
| 3 | `current.raw_ic_count` | `count` | ADC1 IN3, non calibré |
| 4 | `loop.duration_ns` | `ns` | dernier passage dans l'ISR |
| 5 | `loop.max_duration_ns` | `ns` | pire passage depuis le reset des stats |
| 6 | `loop.load_pct` | `%` | `duration / 50 us × 100` |
| 7 | `enc.pos_rad` | `rad` | AS5600, angle mécanique **extrapolé** à l'instant de l'ISR |
| 8 | `enc.vel_rad_s` | `rad/s` | vitesse mécanique estimée depuis deux angles consécutifs, filtrée |
| 9 | `enc.age_us` | `us` | âge de l'échantillon d'angle au moment où l'ISR l'a lu |
| 10 | `current.ia_count` | `count` | ADC1 IN1 **moins l'offset mesuré**, signé. En counts et non en ampères : la conversion demande le gain de l'amplificateur, réglable par SPI, et l'étape 5 pour la vérifier |
| 11 | `current.ib_count` | `count` | ADC1 IN2, centré |
| 12 | `current.ic_count` | `count` | ADC1 IN3, centré |

**Règle firmware** : toute grandeur interne qu'on souhaite pouvoir tracer est déclarée comme
signal au moment où elle est introduite. Une mesure brute reste explicitement nommée et un signal
en ampères n'apparaît qu'après calibration de la chaîne de courant.

### Streaming souscrit

`TELEM_SUBSCRIBE` demande puis renvoie la configuration réellement appliquée :

```
u16  rate_hz       0 désabonne ; sinon 100..500 Hz
u8   count         0..16
u8   reserved      doit valoir 0
u16  signal_id[count]
```

Le firmware choisit un diviseur entier de la boucle 20 kHz et renvoie la fréquence entière
correspondante. Un id inconnu donne `ERR_ID`, un doublon ou un champ réservé non nul `ERR_ARG`.
Une souscription vide équivaut à `rate_hz=0`.

`TELEM_FRAME` est une trame push :

```
u32  timestamp_us  horloge monotone modulo 2^32
u16  sample_seq    détection de perte de trame côté PC
u8   count
u8   reserved      0
f32  values[count] dans l'ordre de la souscription
```

### Scope burst

Le scope échantillonne dans l'ISR de contrôle, à 20 kHz avant décimation. Il accepte au plus
**4 signaux** et **2 048 échantillons**. `SCOPE_CONFIG` demande puis renvoie la configuration
normalisée :

```
u16  depth                 1..2048
u16  decimation            1..256, depuis la boucle 20 kHz
u16  pretrigger_samples    0..depth-1
u8   trigger_mode          0=immediate, 1=rising, 2=falling, 3=either
u8   signal_count          1..4
u16  trigger_signal_id     doit appartenir à la sélection sauf en mode immediate
f32  threshold
u16  signal_id[signal_count]
```

`SCOPE_CONFIG` est refusé par `ERR_BUSY` pendant une capture. `SCOPE_ARM` a un payload vide et
répond par un `SCOPE_STATUS`. Le firmware émet aussi `SCOPE_STATUS` en push à chaque transition :

```
u8   state                 0=idle, 1=armed, 2=triggered, 3=complete
u8   signal_count
u16  captured              nombre de points actuellement conservés
u16  depth
u16  trigger_index         index logique du trigger ; 0xffff avant trigger
u16  decimation
u16  reserved              0
u32  sample_period_ns      50000 × decimation
u32  start_timestamp_us    timestamp du premier point ; 0 avant trigger
```

Une requête `SCOPE_STATUS` a un payload vide et renvoie ce même payload. Quand l'état vaut
`complete`, `SCOPE_READ` lit une tranche :

```
requête   u16 start, u16 count
réponse  u16 start, u16 total, u16 count, u8 signal_count, u8 reserved,
         f32 values[count][signal_count]
```

Les valeurs d'un point sont contiguës dans l'ordre de `SCOPE_CONFIG`. Le firmware réduit `count`
pour tenir dans les 512 octets et pose le drapeau `MORE` s'il reste des points après la tranche.
Lire avant l'état `complete` donne `ERR_STATE`; une plage vide ou hors buffer donne `ERR_RANGE`.

La cadence native de **20 kHz** est le seul moyen de voir une réponse indicielle de boucle de
courant — la capacité qui manquait au firmware v1.

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

Le bootloader implémente le même framing binaire (§2) sur **USB CDC**. Le transport CAN reprendra
les mêmes payloads après que sa fragmentation aura été spécifiée (§10). Il n'expose ni paramètres,
ni télémétrie, ni commande moteur. Au démarrage : PWM en haute impédance avant toute autre
initialisation.

`BOOT_ENTER` a un payload et une réponse vides. L'application attend que la réponse soit mise en
file, puis redémarre avec un mot magique en SRAM réservée ; le bootloader efface ce mot avant de
rester en mode mise à jour. Une perte d'alimentation ne peut donc pas laisser la carte bloquée en
bootloader.

`BOOT_INFO` a un payload vide. Sa réponse est :

```
u16  protocol_version
char bootloader_version[16]
u8   active_slot           0=A, 1=B, 0xff=aucun
u8   candidate_slot        0=A, 1=B, 0xff=aucun
u8   candidate_attempted   0 ou 1
u8   reserved              0
slot[2]
```

Chaque description `slot` occupe 36 octets :

```
u32  address
u32  capacity
u32  image_size
u32  crc32                 CRC-32/ISO-HDLC des image_size octets
u8   valid
u8   reserved[3]
char version[16]
```

La réponse fait donc 94 octets. Une flash vierge utilise A comme slot actif implicite si ses
vecteurs sont plausibles ; elle n'est jamais déclarée valide sur la seule foi de ces vecteurs.

`BOOT_ERASE` demande `u8 slot, u8 reserved[3]` et renvoie le même payload. Seul le slot inactif
peut être effacé. `BOOT_WRITE` demande :

```
u8   slot
u8   reserved              0
u16  data_len              8..504, multiple de 8
u32  offset                multiple de 8
u8   data[data_len]
```

La réponse répète les huit premiers octets (`slot`, réservé, `data_len`, `offset`). Une écriture
exige un `BOOT_ERASE` réussi dans la session courante, reste dans le slot et ne peut transformer
un bit que de 1 vers 0. L'hôte complète le dernier bloc par `0xff`, mais `image_size` ci-dessous
exclut ce padding.

`BOOT_VERIFY` demande :

```
u8   slot
u8   reserved[3]           0
u32  image_size
u32  expected_crc32
char version[16]
```

Après contrôle des limites, des vecteurs Cortex-M et du CRC, la réponse est vide et les
métadonnées marquent le slot comme candidat non essayé. Le changement est atomique : deux pages
de métadonnées alternées portent un compteur de génération et leur propre CRC. Une coupure laisse
toujours au moins l'ancien enregistrement lisible.

Au reset suivant, le bootloader marque le candidat « essayé », arme l'IWDG et saute dessus. Le
firmware candidat doit atteindre son point de santé (initialisation sûre, boucle temps réel et
superloop vivantes) dans les deux secondes ; il écrit alors un mot de confirmation en SRAM et
redémarre. Le bootloader valide ce mot et rend le candidat actif. Tout autre reset avant cette
confirmation efface le candidat et repart sur l'ancien slot : c'est le rollback automatique.

`BOOT_ROLLBACK` a un payload et une réponse vides. Il annule un candidat en attente ; sans candidat,
il répond `ERR_STATE`. Il ne rend jamais exécutable une image invalide.

### Codes d'erreur du bootloader

La spécification laissait ces cas ouverts, et firmware et simulateur avaient commencé à y
répondre différemment. Un écart de ce genre ne se voit qu'au moment où l'on branche une carte,
après que tout est passé au vert sur simulateur :

| Cas | Code |
|---|---|
| Payload de mauvaise longueur, `data_len` hors bornes ou non multiple de 8, `offset` non multiple de 8 | `ERR_LEN` |
| Slot inexistant, slot actif, slot non effacé dans la session, écriture ou vérification hors capacité | `ERR_STATE` |
| `BOOT_ROLLBACK` sans candidat en attente | `ERR_STATE` |
| CRC ou vecteurs de l'image refusés par `BOOT_VERIFY` | `ERR_FLASH` |
| Effacement ou programmation refusés par le contrôleur de flash, métadonnées non enregistrées | `ERR_FLASH` |
| Toute opération pendant le délai de vidage de `BOOT_REBOOT` | `ERR_BUSY` |
| Message que le bootloader n'implémente pas — paramètres, télémétrie, moteur | `ERR_ID` |

`ERR_CRC` reste réservé au lien : il désigne une trame corrompue, que l'hôte réémettra. Une
image dont le CRC ne tombe pas juste n'est pas un problème de transmission, et la réémettre ne
servirait à rien — d'où `ERR_FLASH`.

`BOOT_REBOOT` a un payload et une réponse vides. Le bootloader met d'abord la réponse en file,
attend 50 ms sans accepter d'autre opération flash, puis redémarre. Si un candidat vient d'être
vérifié, la séquence probatoire ci-dessus commence ; sinon le slot actif reste inchangé.

---

## 9. Console ASCII

Conservée pour le diagnostic sans outil, dans l'esprit du `docs/COMMANDS.md` du firmware v1.
Une ligne = une commande, réponse `OK ...` ou `ERR <code>`. Elle couvre l'essentiel :
`PING`, `INFO?`, `STATE?`, `ARM`, `DISARM`, `STOP`, `FAULTCLR`, `SENS.ALL?`, `PARAM? <name>`,
`PARAM <name> <value>`, `MODE <mode>`, `TARGET <value>`.

Implémentées à ce jour : `PING`, `INFO?`, `STATS?`, `STATS.RESET`, `LINK?`, `PROTO?`,
`SELFTEST`, `PWM?`, `STOP`, `SAFETY?`, `FAULTCLR`, et depuis M2 les commandes du driver de
grille, de PWM à vide et de mesures lentes ci-dessous.
Les autres arrivent avec la machine à états (M3).

**Barrière de sécurité** — `AGENTS.md` §4. Ces deux commandes ne dépendent d'aucun jalon : une
commande d'arrêt et ses raisons doivent préexister au danger.

| Commande | Réponse | Rôle |
|---|---|---|
| `SAFETY?` | `OK reason=<nom> latched=<0\|1> outputs=<0\|1> since_cmd_ms=<ms> trips=<n> host=<0\|1>` | État de la barrière. `reason` vaut `ok`, `host_gone`, `cmd_timeout`, `drv_fault` ou `requested`. `trips` compte les coupures du watchdog depuis le reset |
| `FAULTCLR` | `OK` / `ERR CAUSE` | Acquitte la faute verrouillée. Échoue tant que la cause est encore là — un acquittement qui réussit alors que rien n'a changé n'acquitte rien |

**Watchdog de flux de commandes.** Dès que les sorties de puissance sont actives, le firmware
exige un message — n'importe lequel, trame binaire ou ligne ASCII, et même une trame au CRC
cassé : ce qui est prouvé, c'est qu'un hôte émet. Passé **250 ms** sans rien, le couple tombe et
la faute est verrouillée. Un hôte présent mais figé garde `DTR` haut et ne peut plus envoyer
`STOP` : c'est ce cas-là que ce délai couvre, l'hôte franchement parti étant déjà traité par la
présence de `DTR` et l'état du bus.

Côté hôte, la conséquence est une obligation : **qui active les sorties doit entretenir le
flux.** L'interface interroge `SAFETY?` toutes les 80 ms — le même message entretient le flux et
rapporte l'état, donc l'état rapporté est toujours celui de l'instant où l'hôte a prouvé qu'il
était vivant. Un script qui pilote la carte à la main doit faire de même.

**Driver de grille DRV8304** (M2, étape 2) :

| Commande | Réponse | Rôle |
|---|---|---|
| `DRV?` | `OK spi=<0/1> nfault=<0/1> events=<n> fs1=<hex> fs2=<hex> ctrl=<hex> hs=<hex> ls=<hex> ocp=<hex> csa=<hex>` | État complet : bus SPI, broche nFAULT (1 = basse, faute), fronts comptés par l'EXTI depuis le reset, puis les sept registres sur 11 bits |
| `DRV.PROBE` | `OK` / `ERR DRV` | Critère de l'étape 2 : bascule `COAST`, relit, restaure. Ne laisse rien dans le driver |
| `DRV.PINS` | `OK miso=<lo>,<hi> sck=<lo>,<hi> mosi=<lo>,<hi> ncs=<0\|1>` | Les trois lignes du SPI relues en entrée numérique, tirées vers le bas puis vers le haut, plus l'état de `nCS`. Au repos `nCS` est haut et le DRV relâche `SDO` : la ligne doit suivre le tirage. `0,1` = libre ; `0,0` = tenue basse ; `1,1` = tenue haute, donc une résistance de tirage externe franche. Restaure l'alternate en sortant |
| `DRV.BITBANG [<tx_hex>]` | `OK tx=<hex> cs=<0\|1> rise=<hex> fall=<hex> idle=<0\|1>` | Une trame de 16 bits pilotée à la main, ~10 µs par bit, `MISO` échantillonné aux **deux** fronts. Rend un oscilloscope inutile quand le périphérique matériel rend zéro sans qu'on sache pourquoi. `cs` est `MISO` juste après la descente de `nCS`, avant tout coup d'horloge : le DRV8304 ne pilote `SDO` que sélectionné, donc `cs=0` dit qu'il a pris la main et `cs=1` qu'il n'a rien vu. `fall` est ce que fait le périphérique en mode 1 ; si `rise` porte une valeur sensée alors que `fall` est nul, le défaut est un demi-coup d'horloge de décalage, donc une erreur de mode et non un fil |
| `DRV.LOOP [<ms>]` | `OK reads=<n> ok=<n> last=<hex> ms=<n>` | Martèle une lecture de registre pendant quelques secondes, pour qu'un oscilloscope puisse déclencher sur les lignes du SPI. Une lecture isolée dure 15 µs et ne se rattrape pas à la main. `ok` compte les échanges abou[]tis au niveau du périphérique, `last` ce qu'ils ont rendu : les deux ensemble distinguent un bus muet d'un bus qui répond n'importe quoi. Plafonné à 20 s |
| `DRV.REG <addr> [<value>]` | `OK reg=<a> value=<hex>` | Lecture, ou écriture puis relecture, d'un registre brut. Hexadécimal, 11 bits |
| `DRV.CLR` | `OK` / `ERR SPI` | Pulse `CLR_FLT` |
| `DRV.CAL ON` / `OFF` | `OK` | Broche `CAL` : haut = entrées des trois CSA court-circuitées, sortie à VREF/2 + offset |

**Mesures lentes et diagnostic d'acquisition** (M2, étape 4) :

| Commande | Réponse | Rôle |
|---|---|---|
| `ENC?` | `OK present=<0\|1> magnet=<0\|1> status=<hex> raw=<c> turns=<n> pos_mrad=<n> vel_mrad_s=<n> bus_hz=<n> xfer_us=<n> period_us=<n> age_max_us=<n> ok=<n> err=<n>` | État de l'AS5600 et **budget de retard de l'étape 6 en une ligne**. `magnet` vient du registre `STATUS` du capteur : `MD` à 1, `ML` et `MH` à 0. `xfer_us` est la durée du transfert I2C, `period_us` l'intervalle entre deux échantillons, `age_max_us` le pire âge vu par l'ISR depuis la dernière remise à zéro — c'est celui-là que subit la boucle de contrôle. Angles en milliradians pour éviter d'embarquer un `printf` flottant |
| `ENC.REG <addr> [<len>]` | `OK reg=<hex> len=<n> <octets…>` | Lecture ponctuelle d'un registre du capteur, adresse en hexadécimal ou décimal, 1 à 8 octets. Prend le bus le temps du transfert puis relance la chaîne continue. Sert à lire `AGC` (0x1A), `MAGNITUDE` (0x1B) et `CONF` (0x07) |
| `ENC.BUS <hz>` | `OK` / `ERR ARG` | Fréquence SCL : `100000`, `400000` ou `1000000`. Le défaut est 1 MHz, mesuré bon sur cette carte. Remet la chaîne à plat et la relance |
| `ENC.RST` | `OK` | Remet à zéro `age_max_us`, `ok` et `err` |
| `SENS.ALL?` | `OK rounds=<n> vref_mv=<mV> vrefint_raw=<c> vin_mv=<mV> vmot_mv=<mV> v5_mv=<mV> v3v3_mv=<mV> csa_raw=<a>,<b>,<c> csa_mv=<a>,<b>,<c>` | Rails via ADC2, VREF+ **mesuré** par VREFINT, et relecture lente des trois entrées de courant. Un tourniquet d'une conversion par passage de superloop |
| `ADC?` | `OK jsqr=… sqr1=… smpr1=… smpr2=… cfgr=… cr=… isr=… jdr=<a>,<b>,<c> ccr=…` | Registres d'ADC1 tels quels. `jsqr` dit combien de voies la séquence injectée convertit réellement |
| `ADC.PROBE` | `OK pulldown=<a>,<b>,<c> pullup=<a>,<b>,<c>` | Les trois entrées de courant lues en numérique sous tirage bas puis haut. Une source qui impose son niveau lit pareil dans les deux cas ; un nœud flottant suit le tirage. Retour en analogique ensuite |
| `ADC.HOLD ON` / `OFF` | `OK` | Fige le groupe injecté. TIM1 déclenche toujours, l'ADC ne convertit plus : le seul moyen d'observer VREF+ ou une sortie de CSA sans que le condensateur d'échantillonnage vienne secouer le nœud. `ON` coupe `MOE` — la boucle n'est plus servie |
| `VREF.SCAN [<écart_µs>]` | `OK held=<0\|1> gap_us=<n> vrefint=<min>/<max>/<moy>:<rapport> vin=… vmot=… v3v3=… seq=<12 bruts>` | 64 conversions serrées par voie, sur quatre voies et deux convertisseurs, plus le rapport max/min en millièmes. Toutes les voies étant ratiométriques de VREF+, un même rapport partout dit que c'est la référence qui bouge. L'écart optionnel entre conversions sépare une oscillation extérieure — extrêmes inchangés — d'un nœud que les conversions pompent elles-mêmes. `vin` et `vmot` sont les seules à ne jamais saturer, ce sont elles qui font foi |
| `VREF.RATIO` | `OK held=<0\|1> v3v3/vrefint=<min>/<max>/<moy> v5/vrefint=… vin/vrefint=… vmot/vrefint=…` | Chaque rail converti sur ADC2 **en même temps** que VREFINT sur ADC1, et publié en rapport : VREF+ s'y simplifie. Un rail sain donne un rapport stable même quand la voie prise seule balaie. Rapports en millièmes |
| `VREF.FREQ [<intervalle_µs>]` | `OK n=512 interval_us=<n> window_us=<n> raw_min=<c> raw_max=<c> raw_mean=<c> crossings=<n> freq_hz=<Hz> seq=<16 bruts>` | 512 conversions de VREFINT à cadence imposée, cadencée au compteur de cycles, puis comptage des passages par la moyenne — deux par période, avec hystérésis contre le bruit. Une fréquence réelle ne dépend pas de la cadence ; deux cadences qui divergent disent qu'on est au-dessus de Nyquist. Le chiffre décide de tout : le courant nécessaire pour agiter le réseau vaut `C·2πf·V/2`, donc la fréquence mesure la capacité réellement présente |
| `VREF.BUF ON [<mv>]` / `OFF` | `OK csr=<hex> ready=<0\|1> nominal_mv=<mv>` / `ERR DRIVEN vref_mv=<mV> target_mv=<mV>` | Branche le tampon de référence interne du MCU sur `VREF+`. `<mv>` vaut `2048` (défaut), `2500` ou `2900` — les trois échelles du VREFBUF. **Refuse si la broche est déjà tenue plus haut que la consigne** (marge de 150 mV) : depuis la retouche du 2026-09-21 `VREF+` est câblé sur le rail 3,3 V, et activer le tampon reviendrait à lui demander de tirer contre un LDO — il se mettrait en limitation sans lever `VRR`, et les mesures seraient fausses sans que rien ne le dise. La commande garde son intérêt sur une carte dont la référence est plus faible : si le balayage s'arrête net, la broche n'était tenue par personne |
| `IMOT.WIGGLE <A\|B\|C> [<ms>]` | `OK driven=<ms> ms at 1 kHz square, probe U3 pin <n>` | Bat l'entrée choisie en créneau 1 kHz depuis le MCU, pendant quelques secondes. Test de continuité à une seule sonde, posée sur la broche du DRV (23 = A, 22 = B, 21 = C) : le créneau y est, la piste est bonne. Bien plus sûr qu'un ohmmètre à deux pointes sur un boîtier dense. Fige le groupe injecté et coupe `MOE` pendant l'essai |
| `IMOT.DECAY` | `OK charge_us=200 delays_us=… a=<5 valeurs> b=… c=… nc=…` | Chaque entrée chargée à 3,3 V puis relâchée, et convertie après 0, 200 µs, 1, 5 et 25 ms — chaque point repris d'une charge neuve. `nc` est `PA3`, marquée sans liaison au schéma : c'est le témoin. Une broche isolée ne fuit qu'en nanoampères et tient des secondes ; reliée à une piste et à un circuit, elle s'écroule. Les trois voies plus rapides que `nc` disent que la piste est bonne et que l'étage au bout ne pilote pas ; identiques à `nc`, la coupure est côté MCU |
| `IMOT.CAL [<n>]` | `OK n=<n> cal=1 mean=<a>,<b>,<c> min=… max=… sigma_mcnt=…` | Campagne d'offset sur `<n>` échantillons du groupe injecté (4000 par défaut, 20 000 au plus, soit une seconde de boucle). Lève la broche `CAL` du DRV pendant toute la campagne — entrées des amplificateurs court-circuitées, donc **zéro vrai de la chaîne** — et **mémorise** la moyenne comme offset de travail. L'écart-type est en milli-counts pour qu'un bruit sous le pas de quantification reste lisible. Bloquant le temps de la campagne ; `MOE` doit être coupé |
| `IMOT.NOISE [<n>]` | même réponse, `cal=0` | La même mesure **sans toucher à `CAL`** et **sans mémoriser** : la chaîne telle qu'elle travaille. L'écart avec `IMOT.CAL` est l'information utile — même zéro, les shunts ne voient rien ; zéros différents, quelque chose passe |
| `IMOT?` | `OK measured=<0\|1> offset=<a>,<b>,<c> raw=<a>,<b>,<c> centered=<a>,<b>,<c>` | Offsets de travail et dernière lecture brute et centrée. `measured=0` dit que l'offset est la mi-échelle théorique et non une mesure : les courants centrés sont alors indicatifs, pas justes |
| `IMOT.Z` | `OK a_lo=<c>,<c> a_hi=<c>,<c> b_lo=… b_hi=… c_lo=… c_hi=…` | Impédance des trois entrées de courant. Chaque broche est forcée en sortie 20 µs, relâchée en analogique, convertie tout de suite puis 2 ms plus tard, vers le bas puis vers le haut. Une sortie d'amplificateur a repris la main dès la première conversion ; un nœud flottant garde la charge du forçage. Ne dépend ni de VREF+ ni du DRV |

Une faute matérielle (nFAULT bas) coupe `MOE` depuis l'interruption, sans dialogue SPI ; c'est
`DRV?` qui dit ensuite pourquoi.

**PWM à vide** (M2, étape 3) — les seules commandes qui mettent une sortie de puissance en
activité avant M3, et elles ne valent qu'à vide, moteur débranché :

| Commande | Réponse | Rôle |
|---|---|---|
| `PWM <a> <b> <c>` | `OK` / `ERR ARG` | Rapports cycliques des trois bras en pour mille, 0..1000. Préchargés, s'appliquent ensemble à l'événement de mise à jour suivant, `MOE` levé ou non |
| `PWM ON` | `OK` / `ERR DRV` / `ERR FAULT` / `ERR LINK` | Lève `MOE`. Refusé si le DRV8304 ne répond pas, s'il signale une faute, ou sans hôte |
| `PWM OFF` | `OK` | Coupe `MOE`, comme `STOP` |
| `PWM?` | `OK enabled=<0/1> a=<‰> b=<‰> c=<‰> host=<0/1>` | État |

**`host`** est la présence de l'hôte vue du firmware : DTR levé par le port ouvert côté PC et
bus USB actif. Elle retombe quand le port se ferme, quand le câble part ou quand le bus se
suspend — et **le firmware coupe `MOE` de lui-même dès qu'elle retombe**, parce que sans hôte
personne ne peut plus envoyer `STOP`. Conséquence pratique : `PWM ON` envoyé par un outil qui
ouvre puis referme le port (le `console` du CLI) est coupé dans la foulée ; une mesure demande
une session qui garde le port ouvert — la console de l'interface, ou un terminal. Ce n'est pas
le watchdog de flux de commandes prévu pour M3 ; celui-là viendra en plus. Sur une carte saine et jamais configurée, `csa` vaut `283`, la
valeur de reset de la fiche technique — c'est le test de présence le plus simple qui soit.

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
