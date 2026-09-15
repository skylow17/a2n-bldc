# État d'avancement

**Fichier faisant autorité.** L'avancement se note ici et nulle part ailleurs. Les `AGENTS.md`
renvoient à ce fichier plutôt que de recopier un tableau — un état dupliqué diverge, c'est arrivé
dès la troisième passe de travail.

Ce fichier ne contient **aucun chiffre volatil** (nombre de tests, occupation flash, durée d'ISR).
Ces valeurs se mesurent, elles ne se recopient pas : `python tools/status.py` les relève sur le
dépôt réel. Une valeur écrite à la main est fausse le lendemain.

Dernière revue : 2026-09-15.

---

## Firmware — `controller-2/`

| Jalon | Étape | État | Ce qui reste |
|---|---|---|---|
| **M0** | Squelette temps réel : PWM centré 20 kHz, TIM1 TRGO → ADC injecté, ISR | **Validé sur carte** | — |
| **M1a** | Liaison USB CDC non bloquante, console texte | **Validé sur carte** | — |
| **M1b** | Codec binaire COBS + CRC16, dictionnaire de paramètres | **Validé sur carte** | — |
| **M1c** | Télémétrie souscrite + buffer scope | **Validé sur carte** | — |
| **M1d** | CLI de bring-up | Validé sur simulateur et sur carte | Export/plot de capture à ajouter |
| **M2** | Étage de puissance et capteurs (étapes 2 à 9) | Pas commencé | — |
| **M3** | Asservissements (étapes 10 à 13) | Pas commencé | — |

**Aucun moteur n'a encore tourné.** La liaison USB, la console, le codec, le dictionnaire, le
streaming à 500 Hz et une capture scope complète de 2 048 points ont passé leur recette sur la
vraie carte. Les sorties restent en haute impédance ; le reste de la chaîne moteur n'est pas validé.

### Bootloader A/B

Le bootloader USB, les linkers A/B, les métadonnées alternées avec CRC et la probation IWDG sont
construits. Les trois images compilent et le client d'upload passe sur simulateur. **L'installation
initiale sur la carte n'a pas encore été autorisée ni exécutée** : elle efface la flash applicative
avant d'écrire le bootloader et le slot A. La validation matérielle entrée → info → retour app, puis
upload B → probation → confirmation/rollback reste à faire.

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
| `node/` — transport série | Écrit, ouvert et validé sur une vraie carte |
| `cli/` — bring-up | Écrit, validé sur simulateur et sur une vraie carte |
| `main/` — DeviceCore, IPC | Écrit, testé |
| `renderer/` — Dashboard, Tuning, Console | Écrit |
| `renderer/` — Control, Scope, Recipes, Firmware | Vues présentes mais grisées, avec le jalon qui les débloquera |
| `main/recipes/` — `.a2nrcp` | Pas commencé (attend la persistance NVM, M2) |
| `main/mcp/` — serveur MCP | Construit et testé sur simulateur ; validation série réelle à faire. Lecture, télémétrie, scope, console sûre et écriture gated partagent le `DeviceCore` ; aucun outil ne peut activer « AI control » |

### Écarts connus avec la spécification

Relevés lors d'une revue, assumés pour l'instant, à traiter :

| Écart | Spécification | Décision |
|---|---|---|
| Pas de bascule thème clair | « thème sombre par défaut **avec bascule clair** » | À faire ; les variables CSS sont déjà en place |
| `zod` partiel | « valider toute donnée entrante » | Les entrées MCP sont validées ; les futurs fichiers `.a2nrcp` devront l'être aussi |
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

Le motif commun des deux premiers et du quatrième : **le code était juste de chaque côté, c'est la
jonction qui ne l'était pas**. Un test unitaire ne les voyait pas. D'où la règle ci-dessous.

---

## Règle de vérification avant d'annoncer un jalon

1. `cd interface && npm test` — l'ensemble passe
2. `npm run typecheck`
3. `cd controller-2 && make` — build propre, sans avertissement
4. `cd interface && npm run cli -- check --sim` — vert de bout en bout
5. sur carte : `npm run cli -- check` — **le seul qui valide vraiment**

Les quatre premiers ne prouvent que la cohérence interne. Un jalon n'est « passé » que quand le
cinquième l'est, et ce fichier doit le dire ainsi.
