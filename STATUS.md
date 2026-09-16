# État d'avancement

**Fichier faisant autorité.** L'avancement se note ici et nulle part ailleurs. Les `AGENTS.md`
renvoient à ce fichier plutôt que de recopier un tableau — un état dupliqué diverge, c'est arrivé
dès la troisième passe de travail.

Ce fichier ne contient **aucun chiffre volatil** (nombre de tests, occupation flash, durée d'ISR).
Ces valeurs se mesurent, elles ne se recopient pas : `python tools/status.py` les relève sur le
dépôt réel. Une valeur écrite à la main est fausse le lendemain.

Dernière revue : 2026-09-16.

> **Cette revue a repris des états faux.** La passe du 2026-09-15 a marqué « validé sur carte » des
> jalons dont le code n'a jamais été commité. Le détail est plus bas, section
> [« Ce que la revue du 2026-09-16 a trouvé »](#ce-que-la-revue-du-2026-09-16-a-trouvé). La règle
> qui en sort : un état ne se note ici qu'après avoir été **mesuré sur le dépôt**, pas sur un arbre
> de travail local.

---

## Firmware — `controller-2/`

| Jalon | Étape | État | Ce qui reste |
|---|---|---|---|
| **M0** | Squelette temps réel : PWM centré 20 kHz, TIM1 TRGO → ADC injecté, ISR | Validé sur une carte, **et reproductible depuis le 2026-09-16** | Rejouer la recette sur carte |
| **M1a** | Liaison USB CDC non bloquante, console texte | Validé sur une carte, **et reproductible depuis le 2026-09-16** | Rejouer la recette sur carte |
| **M1b** | Codec binaire COBS + CRC16, dictionnaire de paramètres | Validé sur une carte, **et reproductible depuis le 2026-09-16** | Rejouer la recette sur carte |
| **M1c** | Télémétrie souscrite + buffer scope | Réécrit et **compilé** le 2026-09-16, testé hors cible ; jamais exécuté sur carte | Rejouer `telem` et `scope` sur carte |
| **M1d** | CLI de bring-up | Validé sur simulateur | Export de capture (le tracé existe dans l'interface) ; `telem` et `scope` dépendent de M1c côté carte |
| **Boot** | Bootloader A/B, probation et rollback | Écrit et **compilé** le 2026-09-16 (24 608 o sur 32 768) ; logique testée hors cible, chemin d'''écriture éprouvé sur simulateur | Installer par SWD ; recette nominale puis test négatif |
| **M2** | Étage de puissance et capteurs (étapes 2 à 9) | Pas commencé | — |
| **M3** | Asservissements (étapes 10 à 13) | Pas commencé | — |

**Aucun moteur n'a encore tourné**, et les sorties restent en haute impédance.

La nuance sur M0 à M1b compte : la liaison USB, la console, le codec et le dictionnaire **ont**
répondu sur la vraie carte. Mais l'image qui tournait ce jour-là a été construite depuis un arbre
de travail qui contenait des fichiers absents du dépôt. Un clone frais ne produit pas ce binaire —
il ne produit aucun binaire. Ces jalons ne sont donc pas à refaire depuis zéro ; ils sont à
**reconstruire et à rejouer**, ce qui est court, mais ce n'est pas rien.

### Ce que cette revue a trouvé

La passe du 2026-09-15 (`1e93ec7 started bootloader and mcp implementation`) a commité un
`Makefile`, des `#include` et du code d'aiguillage dans `proto.c` qui référencent **douze fichiers
qui n'ont jamais existé dans le dépôt** — `git log --all` sur chacun ne rend rien, et ils ne sont
nulle part sur le poste. Conséquences vérifiées :

- `make` ne peut aboutir sur aucun poste, même correctement outillé ;
- `npm run typecheck` échouait sur un import manquant, et avec lui `npm run build`, `npm run dev`
  et `npm run mcp` — le serveur MCP a été écrit depuis, ce point est levé ;
- `tools/status.py` annonçait pourtant « build à jour, 0 avertissement » : sa fonction `firmware()`
  ne distinguait pas un `make` absent du `PATH` d'un build réussi.

Le même défaut avait déjà été relevé une fois, sur un seul fichier
(`ld/stm32g473ce_standalone.ld`). Il est revenu en douze exemplaires parce que rien ne le
surveillait. C'est maintenant le cas : `python tools/status.py sources` lit le `Makefile` et
vérifie que chaque fichier du dépôt qu'il cite existe — sans toolchain, donc exécutable partout.

### Ce qui manquait au dépôt

**Plus rien** : `python tools/status.py sources` lit le `Makefile` et confirme que chacun des
fichiers qu'il cite existe. Les douze manquants ont été écrits le 2026-09-16 — `comm/signals`,
`comm/scope` et `boot_shared` d'abord, puis les neuf que réclamaient `make boot-images` et
`make install-bootloader`.

Et depuis l'installation de STM32CubeIDE 2.2.0, elles compilent. Les cinq images sortent sans
un seul avertissement — `-Wall -Wextra -Wshadow -Wundef -Wdouble-promotion` :

| Image | Flash utilisée | Capacité |
|---|---|---|
| autonome | 48 652 o | 256 ko |
| bootloader | 24 608 o | **32 ko (75 %)** |
| slot A | 48 692 o | 224 ko |
| slot B | 48 692 o | 224 ko |
| image de probation défaillante | 12 o | — |

C'est la première fois que le dépôt produit son propre firmware. M0 à M1c cessent d'être
« validés sur une carte qu'on ne sait plus reconstruire ».

Les vecteurs des cinq images ont été relus dans les binaires : chacune porte
`_estack = 0x2001FF00` — les quatre linkers amputent bien les 256 octets de la poignée de
main — et chaque point d'entrée tombe dans son propre slot. Les slots A et B font exactement
la même taille, ce qui aurait pu masquer une erreur d'adresse de link ; les adresses réelles
(`0x08010931` et `0x08048931`) montrent qu'il n'y en a pas.

Ce qui reste hors de portée sans carte : que ces images **fonctionnent**. Rien de tout cela
n'a encore été exécuté.

### Bootloader A/B

Ce qui existe désormais, **écrit sans toolchain ARM et donc jamais compilé** :

| Fichier | Rôle |
|---|---|
| `Boot/Src/boot_flash.c` | Géométrie, métadonnées alternées, règles de validation |
| `Boot/Src/boot_proto.c` | Les six messages de la §8 |
| `Boot/Src/boot_rx.c` | Réception, canal binaire seul |
| `Boot/Src/boot_main.c` | Séquence de démarrage, probation, saut |
| `Boot/Src/boot_it.c` | Deux vecteurs : SysTick et USB |
| `Boot/Test/trial_fail.s` | Image inerte du test négatif de rollback |
| `ld/stm32g473ce_boot.ld`, `stm32g473ce_slotB.ld`, `stm32g473ce_trial_fail_A.ld` | Linkers |
| `Core/Src/boot_shared.c` | La poignée de main SRAM, maintenant des **deux** côtés |

Ce qui est **vérifié** : la logique de `boot_flash.c` — CRC-32, géométrie, plausibilité des
vecteurs, encodage et relecture des métadonnées, choix entre les deux pages y compris au
rebouclage du compteur de génération, règles d'effacement, d'écriture et de vérification,
séquence candidat / probation / rollback, réponse `BOOT_INFO`. 117 vérifications hors cible,
`python controller-2/tools/hosttest/run.py`. C'est là que vivent les décisions qui peuvent
briquer une carte, et c'est pour cela qu'elles sont écrites séparées du matériel.

Ce qui n'est **pas** vérifié : l'effacement et la programmation réels, l'armement IWDG, le saut
vers un slot, l'énumération USB du bootloader. Rien n'a été installé sur une carte, et
l'installation initiale — qui efface la flash applicative — n'a jamais été ni autorisée ni
exécutée.

La taille, elle, n'est plus une inconnue : 24 608 o sur 32 768, soit **75 %**. Ça passe, avec
8 ko de marge, mais c'est le seul binaire du dépôt qui soit à l'étroit et son slot ne peut pas
grandir — il précède le slot A, dont l'adresse est figée dans trois linkers. `python
tools/status.py boot` affiche ce pourcentage à chaque passage, pour qu'on voie venir le mur
plutôt que de le toucher.

**Le chemin d'écriture, lui, tourne maintenant.** Il n'avait jamais été exécuté nulle part :
pas sur carte faute de bootloader, et pas sur simulateur non plus, parce que celui-ci
implémentait les six messages de la §8 sans jamais lever `PROTO_CAP.BOOTLOADER` —
`firmware-update` refusait donc de démarrer. Le simulateur modélise désormais la séquence A/B
complète, y compris la distinction entre **rebrancher un câble** et **redémarrer** : les
confondre fait disparaître la probation, donc le rollback, donc la raison d'avoir deux slots.

```bash
npm run cli -- firmware-update --sim ../controller-2/build/slot-b/a2n-bldc-slot-b.bin 2.1.0
npm run cli -- firmware-update --sim --sim-trial-fail ../controller-2/build/slot-b/a2n-bldc-slot-b.bin 2.1.0
```

Le premier promeut le candidat et rend 0 ; le second laisse le slot A actif et rend 1. C'est
`Boot/Test/trial_fail.s` sans carte — et le seul moyen d'éprouver un rollback, qui repose sur
l'**absence** d'une confirmation et ne peut donc pas se provoquer en injectant une panne.

Ce que ça ne prouve toujours pas : que le firmware réel se comporte comme le simulateur. Les
deux suivent la même spécification et les mêmes codes d'erreur, désormais figés au §8 — c'est
une présomption sérieuse, pas une preuve.

**Ordre de recette, quand la toolchain sera là** : compiler les trois images ; vérifier la taille
du bootloader ; installer par SWD sur une carte dont on accepte de perdre le contenu ; `BOOT_INFO`
doit répondre ; mettre à jour le slot inactif avec un firmware sain et confirmer la promotion ;
**puis seulement** rejouer la même séquence avec `make boot-trial-fail-a`, qui ne confirme jamais,
pour prouver le rollback. Le test négatif en dernier : il n'a de valeur que si le chemin nominal a
déjà marché.

### Questions de protocole ouvertes

Relevées en écrivant M1c, à trancher dans `docs/protocol.md` avant d'y toucher des deux côtés :

- **Pas de désarmement du scope.** `SCOPE_CONFIG` répond `ERR_BUSY` pendant une capture (§6), et
  aucun message ne permet d'annuler un armement. Un scope armé sur un front qui n'arrive jamais
  n'est donc plus reconfigurable jusqu'au reset. Le firmware implémente la spécification telle
  qu'elle est écrite ; le test hors cible fige ce comportement pour qu'un changement se voie.
- **`SCOPE_ARM` pendant une capture n'est pas spécifié.** Le device simulé accepte le réarmement,
  `proto.c` prévoit un `ERR_BUSY`. Le firmware suit le simulateur — réarmer relance la capture —
  parce qu'un écart de comportement entre carte et simulateur est exactement ce qui a déjà coûté
  deux défauts à ce projet. À écrire dans la spécification dans un sens ou dans l'autre.

### Bloquants identifiés, à ne pas perdre de vue

- **Watchdog de liaison** — limite dure firmware qui coupe le couple si le flux de commandes
  s'interrompt. Rien ne tourne aujourd'hui, donc rien à couper ; mais c'est le seul filet si un
  câble lâche pendant une rotation. **À implémenter avant M3, pas pendant.**
- **Schéma KiCad** — les affectations SPI2 sont électriquement impossibles (`AGENTS.md` §2). La
  carte a été retouchée à la main et fonctionne ; le schéma reste faux. **À corriger avant toute
  nouvelle fabrication**, sinon le défaut revient.
- **BOOT0 révision A** — `PB8/BOOT0` n'a pas de pull-down externe. La carte de bring-up a été
  provisionnée pour ignorer la broche et `make provision` rend l'opération reproductible. Ajouter
  un pull-down de 10 kΩ sur la prochaine révision matérielle.
- **Courants bruts à zéro pendant la recette M1c** — les trois voies ont renvoyé 0 avec l'étage
  de puissance non activé. Ce résultat est conservé tel quel ; distinguer alimentation/état du
  DRV, configuration analogique et acquisition ADC fait partie de M2, avant toute conversion en A.

---

## Interface — `interface/`

| Partie | État |
|---|---|
| `shared/` — codec, client, device simulé | Écrit, testé |
| `node/` — transport série | Écrit, ouvert sur une vraie carte |
| `cli/` — bring-up | Écrit, validé sur simulateur |
| `main/` — DeviceCore, IPC | Écrit, testé |
| `renderer/` — Dashboard, Tuning, Console | Écrit ; le Dashboard trace la télémétrie souscrite |
| `renderer/` — Scope | Écrit : configuration, déclenchement, pré-trigger, tracé. Validé sur simulateur |
| `renderer/` — Control, Recipes | Vues présentes mais grisées, avec le jalon qui les débloquera |
| `renderer/views/Firmware.tsx` | Mise à jour A/B depuis l'interface, gardée par la capacité annoncée |
| `main/recipes/` — `.a2nrcp` | Pas commencé (attend la persistance NVM, M2) |
| `main/mcp/` — serveur MCP | Écrit, testé sur simulateur ; **validation sur liaison série réelle à faire** |

### Serveur MCP

Treize outils, tous branchés sur des méthodes du `DeviceCore` que l'interface utilise déjà :
`device_*` (ports, connexion, état), `param_*` (liste, lecture, écriture, remise aux défauts),
`telemetry_*` (signaux, échantillon résumé), `scope_capture`, `console_send` et `log_read`.

Ce qui n'est **pas** exposé, et pourquoi : ni `ARM`, ni consigne, ni mouvement — ces fonctions
n'existent pas encore dans le firmware (M3), et elles arriveront gated. Aucun outil ne peut activer
« Enable AI control » : le toggle reste une action humaine dans l'UI. La barrière elle-même vit
dans le `DeviceCore` et n'est pas recopiée dans le serveur ; `resetDefaults` y a été ajouté au
même contrôle que `writeParam`, étant l'écriture la plus large qui soit.

Tout appel MCP est journalisé dans la console commune, source `mcp`, avec ses arguments et son
résultat. `scope_capture` ne rend par défaut que des statistiques par signal : une capture pleine
fait 8 192 flottants, qu'aucun agent ne lit utilement.

`npm run mcp:check` rejoue la surface complète à travers un vrai client MCP — contre le simulateur
sans option, contre une carte avec `--port`. C'est la recette qui reste à passer sur matériel.

**Écart assumé avec `interface/AGENTS.md` §5** : les familles y sont écrites `device.*`, `param.*` ;
les outils s'appellent `device_connect`, `param_set`. Les clients MCP courants n'acceptent que
`[a-zA-Z0-9_-]` dans un nom d'outil. Les familles sont inchangées, seul le séparateur diffère.

### Verrouillage des vues par capacité annoncée

Une vue n'est plus grisée par un jalon écrit en dur mais par le **bit de capacité que le device
annonce au handshake**. Le firmware ne lève un bit que pour ce qui est réellement implémenté :
l'interface dit donc la vérité sur le firmware branché, et pas sur celui qu'on croyait avoir
compilé. La vue Scope se débloque d'elle-même dès que la carte annonce `SCOPE`.

La vue **Firmware** a rejoint Scope le 2026-09-16 : elle est gardée par `BOOTLOADER` et non
plus par un jalon écrit en dur. Elle choisit un `.bin`, demande une version, exige une
confirmation qui cite le fichier, et suit les six phases de la mise à jour — `entering`,
`erasing`, `writing`, `verifying`, `rebooting`, `confirming`. Nommer ces phases n'est pas
cosmétique : une mise à jour A/B traverse trois re-énumérations USB, et sans les annoncer une
déconnexion parfaitement normale se lit comme une panne — on débranche alors au pire moment.

**Écrire un firmware est refusé aux agents**, et pas au titre de l'interrupteur de pilotage :
refusé quoi qu'il arrive, comme le mouvement. Un mauvais paramètre asservit mal un moteur ;
une mauvaise image demande une sonde et un tournevis.

Control et Recipes restent gardées par un jalon : les capacités correspondantes n'existent
dans aucun firmware, il n'y a rien à interroger.

### Écarts connus avec la spécification

Relevés lors d'une revue, assumés pour l'instant, à traiter :

| Écart | Spécification | Décision |
|---|---|---|
| `zod` partiel | « valider toute donnée entrante » | Le codec valide structurellement, et les entrées des outils MCP passent par un schéma `zod`. Les futurs fichiers `.a2nrcp` devront l'être aussi |

Réglés le 2026-09-16 :

- **Bascule thème clair.** Un attribut sur la racine, rien d'autre : toutes les couleurs sont des
  variables CSS. Le clair n'est pas une inversion du sombre — chaque valeur est choisie pour sa
  propre surface, y compris les huit couleurs de courbe, validées comme ensemble dans les deux
  modes. Le choix est retenu d'une session à l'autre.
- **Polices embarquées.** Barlow et IBM Plex Mono arrivent par `@fontsource`, empaquetées dans
  l'application : un poste de banc n'a pas toujours de réseau, et une police absente changerait la
  métrique de toute l'interface.
- **Export de capture.** La vue Scope écrit un CSV — colonne de temps relative au déclenchement,
  une colonne par signal, unité dans l'en-tête. Pas de ligne de commentaire : un en-tête décoratif
  oblige chaque outil qui relit le fichier à savoir le sauter.

Un défaut trouvé en regardant le thème clair : le bouton **STOP** y était délavé. La recette
`fault` à 15 % d'opacité donne un rouge franc sur fond sombre et un rose pâle sur fond clair. Les
trois tons de bouton sont passés en variables CSS, et le clair reçoit un aplat. Pour une commande
d'arrêt, délavé n'est pas une nuance esthétique.

---

## Défauts trouvés et corrigés

Gardés ici parce qu'ils décrivent **comment** les erreurs arrivent sur ce projet, ce qui est plus
utile que la liste de ce qui marche.

| Défaut | Comment il a été trouvé |
|---|---|
| Image liée en slot A alors que le MCU démarre à `0x08000000` — le firmware ne s'exécutait pas du tout | Le COM port n'apparaissait pas |
| Discrimination des canaux sur le terminateur : COBS n'exclut que `0x00`, pas `0x0A` ni `0x0D`. Le canal binaire était inutilisable au-delà de quelques dizaines d'octets | **Premier échange réel** avec le device simulé. Les vecteurs figés passaient — aucun ne contenait de CR/LF |
| `ld/stm32g473ce_standalone.ld` référencé par le Makefile mais jamais commité : un clone frais ne compilait pas | Migration vers le dépôt unique |
| Bouton STOP envoyant une commande absente du firmware : réponse `ERR CMD`, donc aucun effet tout en paraissant agir | Revue des écarts avec la spécification |
| Interface écrite en français alors que la spec impose l'anglais pour les libellés | Relevé par l'utilisateur |
| `PB8/BOOT0` échantillonné haut : démarrage dans la ROM système et disparition du COM | Lecture du PC par SWD (`0x1FFF41C4`), puis retour immédiat après reset avec BOOT0 bas |
| **Douze fichiers référencés par le `Makefile` et par `proto.c`, jamais commités** — le firmware ne compile sur aucun poste, et `STATUS.md` annonçait ces jalons validés | Reprise d'une session interrompue : lecture du `Makefile` contre le contenu réel du dépôt |
| **`tools/status.py` rapportait « build à jour » quand `make` était absent du `PATH`** — l'outil censé mesurer la réalité validait le silence | Même reprise : son verdict contredisait le dépôt |

Le motif commun des deux premiers et du quatrième : **le code était juste de chaque côté, c'est la
jonction qui ne l'était pas**. Un test unitaire ne les voyait pas.

Les deux derniers ajoutent un second motif, plus bête et plus coûteux : **ce qui n'est pas mesuré
dérive, y compris l'état d'avancement lui-même**. Un fichier qui n'existe que dans un arbre de
travail local n'existe pas. Un outil de constat qui ne distingue pas l'absence du succès ne
constate rien. D'où les deux règles ci-dessous.

---

## Règle de vérification avant d'annoncer un jalon

1. `python tools/status.py sources` — aucun fichier cité par le `Makefile` ne manque
2. `cd interface && npm test` — l'ensemble passe
3. `npm run typecheck`
4. `python controller-2/tools/hosttest/run.py` — logique firmware testable hors cible
5. `cd controller-2 && make` — build propre, sans avertissement
6. `cd interface && npm run cli -- check --sim` — vert de bout en bout
7. `npm run mcp:check` — surface MCP complète, sur simulateur
8. sur carte : `npm run cli -- check`, puis `npm run mcp:check -- --port COMx` —
   **les seuls qui valident vraiment**

Les sept premiers ne prouvent que la cohérence interne. Un jalon n'est « passé » que quand le
huitième l'est, et ce fichier doit le dire ainsi.

**Et la règle que cette revue ajoute :** l'état noté ici doit être vrai **pour un clone frais du
dépôt**, pas pour l'arbre de travail de celui qui écrit. `git status` propre ne suffit pas — un
fichier jamais ajouté n'y apparaît pas.
