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
| **M0** | Squelette temps réel : PWM centré 20 kHz, TIM1 TRGO → ADC injecté, ISR | Validé sur une carte, **non reproductible depuis le dépôt** | Reconstruire, puis rejouer la recette |
| **M1a** | Liaison USB CDC non bloquante, console texte | Validé sur une carte, **non reproductible depuis le dépôt** | Reconstruire, puis rejouer la recette |
| **M1b** | Codec binaire COBS + CRC16, dictionnaire de paramètres | Validé sur une carte, **non reproductible depuis le dépôt** | Reconstruire, puis rejouer la recette |
| **M1c** | Télémétrie souscrite + buffer scope | Code réécrit le 2026-09-16, **jamais compilé pour la cible** | Compiler avec la toolchain ARM ; rejouer `telem` et `scope` sur carte |
| **M1d** | CLI de bring-up | Validé sur simulateur | Export de capture (le tracé existe dans l'interface) ; `telem` et `scope` dépendent de M1c côté carte |
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

### Ce qui manque encore au dépôt

Restauré le 2026-09-16 : `Core/Src/comm/signals.c`, `Core/Inc/comm/signals.h`,
`Core/Src/comm/scope.c`, `Core/Inc/comm/scope.h`.

Toujours absent, et cité par le `Makefile` :

| Fichier | Rôle |
|---|---|
| `Core/Src/boot_shared.c` + `.h` | Handshake SRAM avec le bootloader, confirmation de probation. Appelé par `main.c` et `proto.c` |
| `Boot/Src/boot_main.c`, `boot_it.c`, `boot_flash.c`, `boot_proto.c`, `boot_rx.c` | Le bootloader lui-même |
| `Boot/Test/trial_fail.s` | Image inerte du test négatif de rollback |
| `ld/stm32g473ce_boot.ld`, `stm32g473ce_slotB.ld`, `stm32g473ce_trial_fail_A.ld` | Linkers bootloader, slot B, test négatif |

**`boot_shared.c` est le seul qui bloque encore `make` tout court** : les autres ne servent qu'aux
cibles `make boot-images` et `make install-bootloader`.

### Bootloader A/B

Ce qui existe : la spécification (`docs/protocol.md` §8), `MSG_BOOT_ENTER` côté firmware dans
`proto.c`, le linker du slot A, les cibles `make boot-images` / `make install-bootloader`, le codec
et le client d'upload côté PC, et `npm run cli -- boot-check` qui passe sur simulateur.

Ce qui n'existe pas : **le bootloader**. Ni son code, ni ses linkers, ni les métadonnées A/B, ni la
probation IWDG. Rien n'a été installé sur une carte, et l'installation initiale — qui efface la
flash applicative — n'a jamais été ni autorisée ni exécutée.

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
| `renderer/` — Control, Recipes, Firmware | Vues présentes mais grisées, avec le jalon qui les débloquera |
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

Control, Recipes et Firmware restent gardées par un jalon : les capacités correspondantes
n'existent dans aucun firmware, il n'y a rien à interroger.

### Écarts connus avec la spécification

Relevés lors d'une revue, assumés pour l'instant, à traiter :

| Écart | Spécification | Décision |
|---|---|---|
| Pas de bascule thème clair | « thème sombre par défaut **avec bascule clair** » | À faire ; les variables CSS sont déjà en place |
| `zod` partiel | « valider toute donnée entrante » | Le codec valide structurellement, et les entrées des outils MCP passent par un schéma `zod`. Les futurs fichiers `.a2nrcp` devront l'être aussi |
| Polices non embarquées | la maquette utilise Barlow + IBM Plex Mono | Repli sur les polices système ; l'app ne ressemble pas tout à fait à la maquette validée |

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
