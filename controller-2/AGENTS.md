# AGENTS.md — a2n-bldc-controller-2

Firmware FOC pour la carte A2N BLDC (STM32G473CEU3).
**Lire d'abord `../AGENTS.md`** : matériel, protocole partagé, règles de sécurité et conventions y
sont définis une seule fois et ne sont pas répétés ici.

> **Statut : chantier actif.** Ce document pose les bases avant la première ligne de code.
> L'ordre de travail est : squelette temps réel mesuré → observabilité (protocole + CLI de
> bring-up côté PC) → chaîne capteur → asservissements. L'application Electron de
> `../a2n-bldc-interface` vient après, sur le codec écrit pendant l'étape observabilité.

---

## 1. Objectif

Un axe asservi réellement réglable : contrôle en **couple**, **vitesse** et **position**, avec
générateur de profil de mouvement, et surtout **l'observabilité qui manquait au v1** — pouvoir
tracer n'importe quelle grandeur interne à la cadence de la boucle pendant un essai.

Critère de réussite du projet : régler la boucle de courant puis la boucle de position en regardant
des courbes, depuis l'interface PC, sans recompiler.

---

## 2. Post-mortem du v1 — ce qu'on ne refait pas

### Cause racine : il n'y avait aucune structure temps réel

Relecture du code v1, trois défauts dont **chacun suffit seul** à empêcher toute FOC de fonctionner.
Ce n'était pas un problème de réglage.

1. **La boucle de contrôle n'était pas appelée.** `Core/Src/main.c:485` — `//MotorFoc_Process();`
   est commenté. La FOC n'a jamais tourné.
2. **L'angle était lu en bloquant dans la superloop.** `As5600_ReadRawAngle` appelle
   `HAL_I2C_Mem_Read` bloquant (`Core/Src/as5600.c:27`), et I2C4 tourne à **100 kHz**
   (`Timing=0x60715075`). Une lecture de 2 octets coûte ~600 µs : la boucle principale tournait
   autour de 1,5 kHz, avec de la gigue. Sur un moteur à 7 paires de pôles, à 10 tr/s mécaniques,
   cela fait **17° électriques d'erreur entre deux échantillons d'angle**.
3. **L'ADC tournait en roue libre.** `ADC1.ContinuousConvMode=ENABLE` avec DMA circulaire, sans
   déclenchement par TIM1. Or les shunts sont en *low-side* (amplificateurs intégrés du DRV8304,
   d'où `DRV_CAL` sur `PC4`) : le courant ne les traverse que pendant la conduction du transistor
   bas. Échantillonner à un instant arbitraire du cycle PWM donne des mesures sans signification.

**Conséquence pour le v2 : le squelette temps réel se construit et se mesure avant la première
ligne de régulateur** (voir §5, étape 0). Aucun code de contrôle tant que l'ISR n'est pas validée
à l'oscilloscope.

### Le reste de ce qu'on ne refait pas

| Problème v1 | Réponse v2 |
|---|---|
| Aucun moyen de voir Iq / Iq_ref pendant un transitoire | Buffer scope en RAM à la cadence de boucle, déclenché sur condition |
| Gains figés à la compilation | Dictionnaire de paramètres modifiable à chaud, persistant en NVM |
| Paramètres Q16 / Q15 sans unité | Flottants SI, unité dans le nom, bornes déclarées |
| FOC inachevée à côté d'un open-loop bridé | Une seule chaîne de contrôle, l'open-loop n'est qu'un mode de cette chaîne |
| Pas de machine à états claire, ARM géré à part | Machine à états unique et explicite, tout mode y passe |
| Calibration encodeur manuelle et non mémorisée | Routine de calibration commandée, résultat stocké en NVM |
| Reflash obligatoirement par sonde SWD | Bootloader USB / CAN avec slots A/B |

Le v1 reste consultable en `../a2n-bldc-controller` (lecture seule). Deux choses méritent d'être
reprises telles quelles dans l'esprit : la **console ASCII** (`docs/COMMANDS.md`) et la discipline
de **limites logicielles conservatrices** au démarrage.

---

## 3. Architecture cible

### Couches

```
app/        machine à états, séquenceur, gestion des fautes
control/    foc (clarke/park/svpwm), boucles i/vel/pos, générateur de profil, observateur
drivers/    drv8304, as5600, encoder, adc, pwm, flash/nvm
comm/       framing binaire, dictionnaire de params, télémétrie, scope, console ascii, can
boot/       bootloader séparé (projet distinct ou cible CMake dédiée)
```

Règle de dépendance : `drivers` ne connaît pas `control`, `control` ne connaît pas `comm`.
`comm` ne fait qu'exposer des valeurs et poser des consignes via une API explicite de `app`.
Pas de variable globale partagée entre une ISR et la boucle principale sans discipline de
publication (double buffer ou snapshot atomique).

### Cadences

| Boucle | Cadence | Contexte |
|---|---|---|
| Courant (Id / Iq) + SVPWM | **20 kHz**, synchrone PWM | ISR de fin de conversion ADC, déclenchée par TIM1 TRGO |
| Vitesse | 1 à 2 kHz | décimation depuis l'ISR courant |
| Position + profil | 500 Hz à 1 kHz | décimation |
| Supervision, comm, console | boucle principale | non temps réel |

**PWM en comptage centré**, contrairement au v1 : `ARR = 144e6 / (2 × 20e3) − 1 = 3599`
(le v1 était en comptage montant avec `ARR = 7199`). Le comptage centré place naturellement
l'échantillonnage du courant au milieu du vecteur nul, quand les trois transistors bas conduisent —
c'est la condition pour que des shunts low-side mesurent quelque chose.

**Conversions ADC injectées déclenchées par TIM1**, jamais en mode continu. L'ISR de contrôle est la
fin de conversion injectée.

**Rien de lourd dans l'ISR** : pas d'appel HAL bloquant, pas de parsing, pas de `printf`, pas de
division non nécessaire.

**Capteur de position — décision actée : AS5600 seul, lu en DMA, jamais en bloquant.** I2C4 poussé à
1 MHz, lecture continue en DMA circulaire (~70 µs par lecture, soit ~10 kHz effectif), et l'ISR à
20 kHz extrapole l'angle entre deux échantillons à partir de la vitesse estimée :
`theta ≈ theta_mes + omega × dt`. Le retard total (bus + filtre interne du capteur + extrapolation)
est de l'ordre de 100 à 300 µs : **il doit être mesuré et documenté**, car c'est lui qui fixe le
plafond de vitesse exploitable. L'entrée quadrature sur TIM3 (`ENCA PB4` / `ENCB PA4`) reste câblée
et disponible si ce plafond devient gênant — ne pas la supprimer du `.ioc`.

### Machine à états

```
INIT → IDLE → CALIB → IDLE
        ↓
      ARMED → RUN
        ↓       ↓
       FAULT ←──┘   (latché, sortie par acquittement explicite → IDLE)
```

Toute transition est journalisée et lisible depuis l'interface. `ARMED` n'applique aucun couple ;
c'est `RUN` qui exécute une consigne.

### Modes de contrôle

Un seul pipeline, on choisit où on entre dedans :

```
pos_ref → [profil] → [PI pos] → vel_ref → [PI vel] → iq_ref → [PI iq] → vq → [SVPWM]
                                                                 id_ref → [PI id] → vd ↗
```

- `MODE_TORQUE` — entrée directe sur `iq_ref`
- `MODE_VELOCITY` — entrée sur `vel_ref`, profil en accélération
- `MODE_POSITION` — entrée sur `pos_ref`, profil trapèze ou S-curve complet
- `MODE_OPEN_LOOP` — angle imposé en rampe, pour bring-up et diagnostic
- `MODE_CALIB` — routines de caractérisation

### Paramètres et NVM

Le dictionnaire est **la** description des paramètres (voir `../docs/protocol.md`). Il est déclaré
en une seule table statique dans `comm/param_table.c` ; ajouter un paramètre = ajouter une ligne.
Le hash du dictionnaire est calculé au build et exposé au handshake.

Persistance en flash (page dédiée hors slots applicatifs), écriture par enregistrement avec CRC et
compteur de version pour tolérer une coupure en cours d'écriture.

---

## 4. Découpage flash

**Bring-up actuel sans bootloader** : le build utilise `ld/stm32g473ce_standalone.ld`, avec
les vecteurs a `0x08000000`. `make flash` charge le HEX adresse. Le plan A/B ci-dessous
reste une cible future : une image liee a `0x08008000` seule ne fournit pas de demarrage
autonome au reset standard. VTOR est initialise depuis `g_pfnVectors` avant HAL_Init et
les interruptions sont explicitement reactivees. Validation USB sur carte encore requise.


À figer dans le linker script dès le premier commit, même si le bootloader n'est écrit que plus tard.

```
0x08000000  bootloader    32 ko   ┐ banque 1
0x08008000  slot A (app) 224 ko   ┘  ← application en cours d'exécution
0x08040000  slot B (dl)  224 ko   ┐ banque 2
0x08078000  nvm params    16 ko   │  ← dictionnaire persistant
0x0807C000  metadata      16 ko   ┘  ← crc, version, valid, boot_count par slot
```

Le découpage suit la frontière des deux banques de 256 ko plutôt que de la traverser : le
slot A vit entièrement en banque 1, le slot B en banque 2. Le bootloader peut donc effacer
et écrire le slot B pendant qu'il s'exécute depuis la banque 1, sans stall de lecture — et
un basculement par le bit d'option BFB2 reste possible. Les 512 ko sont couverts exactement.
Implémenté dans `ld/stm32g473ce_slotA.ld`.

**Mise à jour sans sonde** — le bootloader parle le même framing binaire que l'application, sur
**USB CDC et sur CAN** :

1. l'application reçoit l'ordre de reboot en bootloader (ou le bootloader est atteint au reset) ;
2. le nouveau firmware est écrit dans le slot inactif, vérifié par CRC ;
3. les métadonnées marquent le slot comme candidat ;
4. au reboot, le bootloader démarre le candidat ; si l'application ne confirme pas son bon
   fonctionnement dans un délai imparti, **rollback automatique** sur le slot précédent.

Le bootloader n'exécute jamais de code applicatif et ne dépend d'aucun périphérique moteur : au
démarrage, PWM en haute impédance, DRV8304 désactivé, avant toute autre chose.

---

## 5. Jalons et procédure de bring-up

Une seule référence pour l'avancement. Les jalons `M0`–`M3` regroupent les étapes ; les
étapes portent le critère de validation. **Ordre imposé** : on ne passe pas à la suivante
tant que la précédente n'est pas verte.

La logique de cet ordre est l'inverse de celle du v1 : **l'outil de mesure avant le
régulateur**. Le v1 n'avait aucun moyen de voir Iq pendant un transitoire, donc aucun moyen
de régler autrement qu'à l'aveugle. Ici l'observabilité (M1) est acquise avant qu'on écrive
la première boucle d'asservissement (M3).

| Jalon | # | Étape | Critère de validation |
|---|---|---|---|
| **M0** — squelette temps réel | 0 | PWM centré 20 kHz, TIM1 TRGO → ADC injecté, ISR de contrôle vide | Sortie d'instrumentation `PC14` (J7 br. 5) basculée en entrée/sortie d'ISR : **20 000 Hz, gigue < 200 ns, durée < 10 µs, aucune impulsion manquante**. Détail et modes de défaillance dans `docs/M0-bringup.md` |
| **M1** — observabilité | 1a | Liaison USB CDC, émission non bloquante, console texte | `INFO?` et `STATS?` répondent ; `ticks` progresse de 20 000 par seconde mesurée **côté PC** |
| | 1b | Codec binaire (COBS + CRC16) et dictionnaire de paramètres, écrits en C **et** en TypeScript | L'hôte lit le dictionnaire et le hash du handshake correspond |
| | 1c | Télémétrie souscrite + buffer scope en RAM | Capture de 2048 points à 20 kHz, relue intégralement |
| | 1d | CLI Node de bring-up, sur `../a2n-bldc-interface/src/shared/` | Une capture tracée depuis le PC |
| **M2** — étage de puissance et capteurs | 2 | DRV8304 : SPI, registres, nFAULT | Écriture puis relecture cohérente d'un registre, fautes remontées |
| | 3 | PWM à vide, haute impédance, temps mort | Formes correctes à l'oscilloscope, aucun bras en conduction croisée. Comparer le front de `PC13` à celui de `PB0` |
| | 4 | ADC synchrone PWM, offsets des amplis de courant (`DRV_CAL`) | Offsets stables moteur à l'arrêt, bruit mesuré et documenté |
| | 5 | Mesure des courants sous rapport cyclique fixe | Somme Ia+Ib+Ic ≈ 0, cohérence avec le courant d'alimentation |
| | 6 | AS5600 en DMA à 1 MHz + extrapolation d'angle | Angle croissant monotone à la main, aucun blocage de l'ISR, **retard total mesuré et documenté** |
| | 7 | Identification R et L de phase | Valeurs plausibles, stockées en NVM |
| | 8 | Alignement et offset électrique du capteur | Offset reproductible entre deux calibrations |
| | 9 | Détection du nombre de paires de pôles | Valeur entière stable sur plusieurs essais |
| **M3** — asservissements | 10 | Open-loop : le champ tourne, l'arbre suit | Rotation propre, courant maîtrisé |
| | 11 | Boucle de courant Id/Iq | Réponse indicielle au scope : dépassement et temps de montée conformes |
| | 12 | Boucle de vitesse | Poursuite d'une rampe, erreur statique nulle |
| | 13 | Boucle de position + profil | Point à point sans dépassement, position tenue à l'arrêt |

L'étape 11 est le point de bascule par rapport au v1 : elle est **infaisable sans le scope
burst**, donc M1 doit être entièrement acquis avant d'y arriver.

L'application Electron de `../a2n-bldc-interface` se construit après M3, sur le codec écrit
en M1b — la CLI de M1d et elle partagent le même `src/shared/`.

---

## 6. Environnement et règles de travail

**Toolchain** — `make` + arm-none-eabi-gcc 13.3.1, tous deux pris dans l'installation
STM32CubeIDE (chemins en tête du `Makefile`). Le HAL et le CMSIS sont lus directement depuis
le dépôt CubeMX local `STM32Cube_FW_G4_V1.6.1` : rien n'est recopié dans le projet.

**Pas de code généré par CubeMX.** L'initialisation est écrite à la main, périphérique par
périphérique, dans `Core/Src/`. Le v1 mélangeait code généré et code utilisateur, ce qui
rendait toute relecture du chemin temps réel pénible ; ici chaque registre configuré est
visible et commenté. Le `.ioc` du v1 reste la référence du brochage, pas une source de
génération.

**Règles agent**

- **Build** : `make` à la racine du projet. Pas de CMake — la machine de développement n'a
  que le GCC 13.3.1 et le `make` fournis par STM32CubeIDE, et le `CMakePresets.json` du v1
  n'y était donc pas utilisable. `make flash` programme le firmware autonome par SWD, `make compdb`
  régénère `compile_commands.json` pour clangd.
- Ne jamais committer `build/`.
- Toute nouvelle commande, trame ou paramètre du protocole arrive **avec** son entrée dans
  `../docs/protocol.md`, dans la même passe.
- Toute grandeur qu'on aimerait voir dans un plot doit être **déclarée comme signal de télémétrie**
  au moment où on l'introduit, pas après coup. C'est la règle qui évite de refaire le v1.
- Pas de `HAL_Delay` ni de blocage dans un chemin appelé depuis une ISR ou depuis la supervision.
- Les valeurs par défaut au premier boot sont **conservatrices** : courant faible, vitesse faible,
  toutes les limites actives. On les desserre paramètre par paramètre depuis l'interface.
- Les modifications de la chaîne de puissance (deadtime, fréquence PWM, limites de courant) se
  testent alimentation basse tension et courant limité avant tout essai nominal.
- Avant de proposer un réglage de régulateur, fournir la capture scope qui le justifie.
