# AGENTS.md — Groupe de projets A2N BLDC

Ce fichier est le contrat commun aux projets de ce dossier. Tout agent ou contributeur qui
intervient ici le lit en premier, puis le `AGENTS.md` du projet dans lequel il travaille.

---

## 1. Carte du groupe

| Dossier | Rôle | Statut |
|---|---|---|
| `a2n-bldc-controller` | Firmware historique (v1), STM32G473. **Lecture seule.** | Gelé — référence matérielle uniquement |
| `a2n-bldc-controller-2` | Nouveau firmware FOC (position / vitesse / couple) | **Chantier actif** |
| `a2n-bldc-interface` | Interface PC : codec protocole, CLI de bring-up, puis application Electron | Maquette validée ; `shared/` + `cli/` en appui du firmware |

**Règle absolue : `a2n-bldc-controller` ne se modifie pas.** Il sert de source de vérité pour le
brochage et de post-mortem. On le lit, on le cite, on ne le touche pas.

### Pourquoi on repart de zéro

Le firmware v1 n'a jamais permis de faire tourner le moteur comme voulu. Les causes identifiées :

- **la boucle de contrôle n'était pas appelée** : `Core/Src/main.c:485` porte un
  `//MotorFoc_Process();` commenté ;
- **aucune structure temps réel** : angle lu en I2C bloquant à 100 kHz dans la superloop (~1,5 kHz,
  avec gigue) et ADC en conversion continue non synchronisée de la PWM, alors que les shunts sont
  en low-side. Le détail est dans `a2n-bldc-controller-2/AGENTS.md` §2 ;
- le seul mode fonctionnel était un open-loop volontairement bridé (modulation ≤ 8 %, ≤ 5 Hz
  électrique) — utile pour vérifier qu'un champ tourne, inutile pour un axe asservi ;
- **aucune observabilité** : impossible de tracer Iq / Iq_ref pendant une réponse indicielle, donc
  impossible de régler un régulateur autrement qu'à l'aveugle. C'est le défaut central ;
- paramètres en points fixes nus (Q16 / Q15) sans unité ni documentation d'échelle, ce qui rendait
  toute commande manuelle illisible et source d'erreurs ;
- pas de persistance : chaque reset repartait des valeurs compilées.

Le nouveau couple firmware + interface est conçu autour de l'observabilité et du réglage à chaud.

---

## 2. Matériel de référence

Carte inchangée entre v1 et v2. Source de vérité du brochage :
`a2n-bldc-controller/a2n-bldc-controller.ioc`.

**MCU** : STM32G473CEU3, UFQFPN48, HSE + PLL → **SYSCLK 144 MHz**, USB à 48 MHz (PLLQ /6).

### Étage de puissance

| Fonction | Ressource |
|---|---|
| PWM 3-phases complémentaire | TIM1 — CH1/CH1N `PA8`/`PC13`, CH2/CH2N `PA9`/`PB0`, CH3/CH3N `PA10`/`PB1` |
| Driver de grille | DRV8304 sur **SPI2** — SCK `PB13`, MISO `PB14`, MOSI `PB15`, nCS `PB12` |
| Défaut driver | `PB11` — `DRV_nFAULT`, actif bas |
| Calibration offset ampli | `PC4` — `DRV_CAL` |

Référence v1 : ARR = 7199 en comptage montant → **20 kHz**, registre de deadtime = 128.
Le firmware v2 recalculera ces valeurs et passera en **comptage centré** (standard FOC,
échantillonnage du courant au milieu du vecteur nul).

### Mesures

| Grandeur | Voie |
|---|---|
| Courant phase A / B / C | ADC1_IN1 `PA0` / IN2 `PA1` / IN3 `PA2` — 3 shunts |
| Tension d'entrée Vin | ADC2_IN13 `PA5` |
| Tension moteur Vmot | ADC2_IN12 `PB2` |
| Rail 5 V | ADC2_IN3 `PA6` |
| Rail 3V3 | ADC2_IN4 `PA7` |
| Température | capteur interne MCU |

### Écarts connus du schéma

`docs/Schematics.pdf` (KiCad 10, rev A, 2026-06-11) est la référence pour la **topologie** —
étage de puissance, valeurs de composants, diviseurs, connecteurs. Pour le **brochage MCU**,
c'est le `.ioc` du v1 qui fait foi : le schéma comporte des affectations erronées.

| Ce que dit le schéma | Réalité |
|---|---|
| `PB13 = SPI2_MOSI`, `PB15 = SPI2_SCK` | Impossible : en AF5 sur ce boîtier, `PB13` ne peut être que SCK et `PB15` que MOSI. **La carte a été retouchée** (liaisons refaites directement sur le PCB) et le SPI matériel fonctionne avec le brochage du v1. Le schéma reste à corriger avant toute nouvelle fabrication, sinon le défaut revient. |
| `TP1`/`TP2` sur `PB8`/`PB9` | Marqués « ne pas poser » : pas de point de test garanti. On instrumente sur `IO1` (`PC14`), sorti sur J7 broche 5. |
| `R21`/`R22` 4k7, annotés « TBC » | Pull-ups I2C. Valeur limite pour du Fast-mode Plus à 1 MHz. À confirmer. |

Autres points relevés à la lecture :

- **Shunts low-side de 10 mΩ** (`R19`/`R20`/`R25`), lus par les amplificateurs intégrés du
  DRV8304**S** (variante SPI), sortie polarisée à VREF/2. D'où l'échantillonnage obligatoirement
  synchrone de la PWM.
- **VREF = 2,048 V** (MCP1501), et non VDDA. Tous les diviseurs de monitoring sont dimensionnés
  pour cette référence. Le v1 l'avait correctement pris en compte.
- **`PC13` porte `PWM1N`** : broche du domaine sauvegardé, drive et vitesse plafonnés par rapport
  aux cinq autres sorties PWM. Asymétrie de front à mesurer.
- **`DRV_nFAULT` est sur `PB11`**, qui n'offre pas de `TIM1_BKIN` : la coupure du pont sur faute
  driver est logicielle (EXTI), pas matérielle.
- **MOSFET** : `NVMFD024N06CT1G`, doubles canal N 60 V, un boîtier par demi-pont.
- **J4** est une empreinte Tag-Connect TC2050 (pas de connecteur à poser) : c'est l'accès SWD.
- **J3** : CAN et encodeur incrémental. **J7** : `IO1`, `IO2`, +5 V, +3,3 V, GND.

### Capteurs de position

- **AS5600** magnétique absolu sur **I2C4** — SCL `PC6`, SDA `PB7`. Capteur principal.
- **Encodeur incrémental** sur **TIM3** en mode quadrature — ENCA `PB4`, ENCB `PA4`. Présent sur la
  carte, non exploité par le v1.
- `PB6` — `HALL_DIR`.

### Communication et divers

| Fonction | Ressource |
|---|---|
| USB CDC | `PA11` (DM) / `PA12` (DP), détection VBUS sur `PC10` |
| CAN | FDCAN3 — TX `PA15`, RX `PB3`, nominal ≈ 3 Mbit/s en v1 |
| SWD | `PA13` / `PA14` |
| Points de test | `PB8` (`TP1_BOOT`), `PB9` (`TP2`) |
| Entrées libres | `PC14` (`IO1`), `PC15` (`IO2`) |
| Timer libre | TIM2_CH3 `PB10` |

---

## 3. Le protocole est le contrat partagé

La liaison entre le firmware v2 et l'interface est spécifiée dans **un seul fichier faisant
autorité** : `docs/protocol.md`, à la racine de ce groupe.

**Règle : toute évolution du protocole se fait d'abord dans `docs/protocol.md`, puis des deux côtés
dans la même passe de travail.** Une commande qui existe dans le firmware sans entrée dans la spec
est un bug ; un décodeur côté PC pour une trame non spécifiée est un bug.

### Principes retenus

**Transport hybride sur USB CDC** — deux canaux sur le même lien :

- un **canal binaire framé** (COBS + CRC16) pour les paramètres, la télémétrie haute cadence, les
  captures scope et l'upload de firmware ;
- une **console ASCII ligne** conservée pour le diagnostic manuel au terminal, sans aucun outil.
  C'est la seule chose vraiment réussie du v1 et on la garde.

**Auto-découverte des paramètres** — le firmware expose un dictionnaire d'objets : identifiant,
nom, type, **unité**, min / max / défaut, drapeaux (lecture seule, persistant, nécessite DISARM).
L'interface interroge ce dictionnaire à la connexion et construit ses panneaux de réglage
dynamiquement. Conséquence directe : **ajouter un paramètre au firmware suffit, l'interface n'a pas
à être modifiée.** Il n'y a pas de liste de paramètres dupliquée côté PC.

**Télémétrie à deux vitesses** :

- *streaming souscrit*, 100 à 500 Hz — l'interface s'abonne à N signaux, le firmware pousse en
  continu. Alimente les courbes temps réel ;
- *scope burst* — le firmware enregistre en RAM à la cadence de la boucle (≈ 20 kHz) sur condition
  de déclenchement, puis dumpe le buffer. Indispensable pour régler la boucle de courant, et c'est
  exactement ce qui manquait au v1.

**Handshake** — à la connexion, le device annonce version de protocole, version de firmware et
**hash du dictionnaire de paramètres**. L'interface refuse d'appliquer une recette dont le hash ne
correspond pas sans confirmation explicite.

---

## 4. Sécurité — règles non négociables

Le banc entraîne une masse en rotation, et un agent IA pourra le piloter sans humain devant.

1. **Rien ne tourne sans `ARM` explicite.** Un reset, une faute ou une perte de liaison ramènent
   toujours à l'état désarmé.
2. **Les limites vivent dans le firmware** — courant max, vitesse max, température max, tension
   min / max, watchdog de liaison. Elles s'appliquent **quelle que soit la source de commande** :
   USB, CAN, console ASCII, serveur MCP. Le PC n'est jamais la barrière de sécurité.
3. **Watchdog de liaison** : si le flux de commandes s'interrompt pendant qu'un mouvement est en
   cours, le firmware coupe le couple après un délai court. Seul filet contre un agent qui plante
   ou un câble arraché en pleine rotation.
4. **Aucun contournement côté PC.** Élargir une limite pour faire passer un essai est interdit —
   si une limite bloque un essai légitime, on change le paramètre de limite explicitement, on le
   journalise, et on le dit dans le compte rendu.
5. **Toute faute est latchée** et exige un acquittement explicite. Pas d'auto-reprise silencieuse.
6. Côté interface : un **bouton STOP** et un **toggle « Enable AI control »** sont visibles en
   permanence. Les outils MCP qui mettent le moteur en mouvement refusent tant que le toggle est
   sur off.

---

## 5. Conventions

**Langues** — anglais pour le code, les identifiants, les noms de paramètres, les messages du
protocole et les libellés d'interface. Français pour les échanges avec l'utilisateur, les documents
de conception et les commentaires expliquant un choix.

**Unités** — grandeurs physiques en **flottant, unités SI, unité dans le nom** :
`i_max_a`, `vel_max_rad_s`, `accel_max_rad_s2`, `vbus_v`, `temp_c`, `pos_rad`.
On abandonne le Q16 / Q15 nu du v1 dans toute interface externe. Le point fixe reste autorisé
*à l'intérieur* d'une boucle temps réel si le profilage le justifie, jamais dans le protocole.

**Nommage des paramètres** — `groupe.sous_groupe.nom_unite`, minuscules et underscores :
`pid.iq.kp`, `lim.i_max_a`, `motor.pole_pairs`, `enc.offset_rad`.

**Git** — un dépôt par projet. Messages de commit en anglais, à l'impératif, préfixés par le
domaine touché (`foc:`, `proto:`, `ui:`, `mcp:`). Les artefacts de build ne sont jamais versionnés.

---

## 6. Ce qu'on attend d'un agent dans ce groupe

**À faire**

- Lire `docs/protocol.md` avant toute modification de la liaison, des deux côtés.
- Reproduire d'abord sur le **simulateur** de l'interface : il parle le même protocole et permet de
  valider une séquence sans risque matériel.
- Rendre compte fidèlement d'un essai : ce qui a été mesuré, pas ce qui était attendu. Un réglage
  qui ne converge pas se dit.
- Suivre la **procédure de bring-up** documentée dans `a2n-bldc-controller-2/AGENTS.md` quand on
  touche à la chaîne moteur — chaque étape a un critère de validation observable.

**À ne pas faire**

- Modifier `a2n-bldc-controller`.
- Désactiver, contourner ou élargir silencieusement une limite de sécurité.
- Ajouter une commande, un paramètre ou une trame sans mettre à jour `docs/protocol.md`.
- Dupliquer la description des paramètres côté PC : elle vient du firmware, point.
- Mettre le moteur en mouvement depuis un outil MCP sans que « Enable AI control » soit activé.
