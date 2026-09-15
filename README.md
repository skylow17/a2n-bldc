# A2N BLDC

Contrôleur de moteur BLDC en FOC (position, vitesse, couple) sur STM32G473CEU3, et le poste PC qui
sert à le régler et à l'instrumenter.

| Dossier | Contenu |
|---|---|
| `controller-2/` | Firmware. C, HAL STM32G4, build par `make`. |
| `interface/` | Poste PC : codec de protocole, CLI de bring-up, puis application Electron. TypeScript, tests avec `npm test`. |
| `docs/protocol.md` | La liaison USB CDC entre les deux. **Seule autorité** : toute évolution y passe d'abord. |
| `docs/Schematics.pdf` | Schéma du PCB (KiCad, rev A). |
| `AGENTS.md` | Le contrat de travail : matériel, protocole, règles de sécurité, conventions. À lire en premier. |
| `STATUS.md` | Où en est le projet, jalon par jalon, et ce qui reste à valider sur matériel. |

Le firmware historique `a2n-bldc-controller` est **gelé** et vit dans un dépôt séparé ; il sert de
référence matérielle, pas de base de travail. Voir `AGENTS.md` §1.

---

## Mise en route sur un nouveau poste

```
git clone https://github.com/skylow17/a2n-bldc.git
cd a2n-bldc
```

C'est tout ce dont une session a besoin : le contrat, la spécification de protocole et les deux
projets arrivent ensemble et cohérents entre eux.

### Pour compiler le firmware

Une seule dépendance : **STM32CubeIDE**, qui fournit à lui seul le compilateur `arm-none-eabi-gcc`,
`make` et `STM32_Programmer_CLI`. Plus le **paquet HAL STM32G4** (`STM32Cube_FW_G4`), installé par
CubeIDE ou CubeMX. Ni CMake ni Ninja ne sont utilisés.

```
cd controller-2
cp toolchain.local.mk.example toolchain.local.mk   # puis y mettre ses chemins
make
```

`toolchain.local.mk` n'est pas suivi par git : chaque poste garde ses chemins d'installation sans
jamais entrer en conflit avec un autre. Si les chemins ne correspondent pas, `make` s'arrête tout
de suite en le disant, plutôt que de partir en cascade d'erreurs.

`make` doit être dans le `PATH`. Il se trouve sous :

```
<CubeIDE>/plugins/com.st.stm32cube.ide.mcu.externaltools.make.win32_*/tools/bin
```

Cibles disponibles :

| Commande | Effet |
|---|---|
| `make` | Construit `.elf`, `.hex` et `.bin` dans `build/` |
| `make flash` | Programme la carte par SWD (ST-LINK ou Tag-Connect sur J4) |
| `make provision` | Force le boot depuis la Flash principale, une fois par carte |
| `make flash-check` | Programme, redémarre puis valide la carte avec la CLI |
| `make boot-images` | Construit le bootloader et les applications liées pour A et B |
| `make install-bootloader` | **Efface la flash applicative**, puis installe le bootloader et le slot A par SWD |
| `make size` | Occupation flash / RAM |
| `make compdb` | `compile_commands.json` pour clangd |
| `make clean` | Efface `build/` |

Un build propre ne produit **aucun avertissement**. Pour relever l'occupation mémoire du
moment plutôt que de se fier à un chiffre recopié :

```
python tools/status.py fw
```

Le build par défaut reste l'image de bring-up liée à `0x08000000`. `make boot-images` produit
séparément le bootloader à `0x08000000`, l'application A à `0x08008000` et l'application B à
`0x08040000`. L'installation initiale reste une opération SWD explicite et destructive ; les mises
à jour suivantes n'effacent que le slot inactif et passent par CRC + probation + rollback.

La révision A n'a pas de pull-down externe sur `PB8/BOOT0`. Avant le premier flash d'une carte,
exécuter `make provision` : il programme `nSWBOOT0=0` et `nBOOT0=1`, ce qui rend le démarrage
indépendant du niveau de la broche tout en conservant la récupération par SWD. Cette cible est
séparée du flash ordinaire afin de ne pas réécrire les option bytes à chaque build.

Pour la recette courante, préférer `make flash-check`. La cible attend l'énumération USB puis lance
le check matériel complet. Si plusieurs cartes sont branchées, préciser par exemple
`make flash-check BOARD_PORT=COM3`.

### Pour vérifier que la carte répond

Le firmware s'énumère en USB CDC. N'importe quel terminal série fait l'affaire, la vitesse est
ignorée. Une commande par ligne :

```
PING          -> OK
INFO?         -> OK product=A2N-BLDC fw=... sysclk=144000000 pwm_hz=20000 arr=3599 ...
STATS?        -> OK ticks=... last_ns=... max_ns=... load_pm=... ia=... ib=... ic=...
LINK?         -> OK tx_dropped=0 rx_dropped=0
PWM?          -> OK enabled=0
PROTO?        -> OK rx_frames=0 rx_errors=0 tx_dropped=0 overflows=0 params=11 dict_hash=A7C793EB
SELFTEST      -> OK total=43 failed=0 ... dict_ok=1
```

`SELFTEST` fait exécuter au firmware les vecteurs de référence du protocole, sur la cible. C'est
la première chose à lancer si quoi que ce soit de la liaison binaire se comporte bizarrement :
elle sépare un problème de codec d'un problème de câble ou d'hôte.

La procédure de recette complète est dans `controller-2/docs/M0-bringup.md`.

### Pour l'interface PC

La maquette (`interface/docs/mockup/mockup.html`) s'ouvre directement dans un navigateur, sans
rien installer.

Le code commence par `src/shared/`, le codec du protocole — volontairement sans dépendance à
Electron, pour que la CLI de bring-up, le futur serveur MCP et les tests partagent exactement
le même chemin d'exécution que l'application.

```
cd interface
npm install
npm test          # vecteurs partagés + propriétés du codec
npm run typecheck
```

### La CLI de bring-up

C'est l'outil à utiliser pour valider une carte fraîchement flashée. `--sim` remplace la
carte par un device simulé complet : toutes les commandes fonctionnent sans matériel.

```
cd interface
npm run cli -- check            # séquence de validation complète, verdict unique
npm run cli -- check --sim      # la même chose, sans carte
npm run cli -- ports            # repère la carte parmi les ports série
npm run cli -- dict             # dictionnaire de paramètres et valeurs courantes
npm run cli -- get pwm.freq_hz
npm run cli -- set dbg.echo_f32 1.5
npm run cli -- console SELFTEST
npm run cli -- signals          # dictionnaire de signaux M1c
npm run cli -- telem 100 500    # 100 trames à 500 Hz, contrôle des trous
npm run cli -- scope 2048       # capture synchrone complète
npm run cli -- boot-check       # entrée bootloader puis retour à l'application
npm run cli -- monitor          # tout ce qui passe sur le lien
```

La carte est reconnue par ses identifiants USB (VID `0483`, PID `5740`) ; `--port COMx`
force un port précis.

### L'application

```
cd interface
npm run dev        # développement, rechargement à chaud
npm run build      # empaquetage dans out/
```

Elle se connecte au choix à une carte ou au device simulé, par le même sélecteur. Ce qui
est visible correspond à ce que le firmware sait faire : les vues **Control**, **Scope**,
**Recipes** et **Firmware** restent grisées tant que leurs workflows UI ne sont pas raccordés.
Le codec de capture et la première cible bootloader existent déjà en dessous.
Proposer des boutons qui échoueraient serait pire que de ne rien proposer.

### Le serveur MCP

Le serveur MCP tourne dans le processus principal Electron et reçoit le même `DeviceCore` que
l'interface :

```
cd interface
npm run mcp
```

Il expose la connexion, l'identité, les paramètres, la télémétrie, le scope et une console de
diagnostic strictement allow-listée. Une écriture de paramètre d'origine MCP reste refusée tant
que l'humain n'a pas activé « Enable AI control » ; aucun outil MCP ne peut activer ce toggle.
`ARM`, les consignes et le mouvement ne sont pas encore exposés.

### Régénérer les vecteurs de protocole

Si la spécification du protocole change, à la racine du dépôt :

```
python tools/gen_protocol_vectors.py
```

Cela réécrit `docs/protocol-vectors.json` **et** la table C que le firmware embarque. Les deux
sont commités : le script ne tourne que lorsque le protocole bouge.

---

## Un mot sur la structure

Le firmware et le poste PC partagent un protocole binaire dont les deux implémentations, en C et en
TypeScript, doivent rester d'accord à l'octet près. C'est la raison d'être du dépôt unique : une
évolution de la liaison tient dans une seule révision qui touche la spécification et les deux
codecs à la fois. Deux dépôts séparés rendraient ce changement non atomique, et donc tôt ou tard
divergent.
