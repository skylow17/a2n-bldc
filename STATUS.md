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
| **M0** | Squelette temps réel : PWM centré 20 kHz, TIM1 TRGO → ADC injecté, ISR | Construit | **Critère matériel non passé** : gigue < 200 ns à l'oscilloscope sur J7 br. 5 |
| **M1a** | Liaison USB CDC non bloquante, console texte | Construit | **Non validé sur carte** : `ticks` mesuré côté PC |
| **M1b** | Codec binaire COBS + CRC16, dictionnaire de paramètres | Construit, testé hors cible | **Non validé sur carte** : `npm run cli -- check` |
| **M1c** | Télémétrie souscrite + buffer scope | Pas commencé | — |
| **M1d** | CLI de bring-up | Construit, validé sur simulateur | — |
| **M2** | Étage de puissance et capteurs (étapes 2 à 9) | Pas commencé | — |
| **M3** | Asservissements (étapes 10 à 13) | Pas commencé | — |

**Rien n'a encore tourné sur le matériel.** Tout ce qui est marqué « construit » l'a été vérifié
par compilation, tests hors cible et simulation. C'est utile et ce n'est pas une validation.

### Bloquants identifiés, à ne pas perdre de vue

- **Watchdog de liaison** — limite dure firmware qui coupe le couple si le flux de commandes
  s'interrompt. Rien ne tourne aujourd'hui, donc rien à couper ; mais c'est le seul filet si un
  câble lâche pendant une rotation. **À implémenter avant M3, pas pendant.**
- **Schéma KiCad** — les affectations SPI2 sont électriquement impossibles (`AGENTS.md` §2). La
  carte a été retouchée à la main et fonctionne ; le schéma reste faux. **À corriger avant toute
  nouvelle fabrication**, sinon le défaut revient.

---

## Interface — `interface/`

| Partie | État |
|---|---|
| `shared/` — codec, client, device simulé | Écrit, testé |
| `node/` — transport série | Écrit ; **jamais ouvert sur une vraie carte** |
| `cli/` — bring-up | Écrit, validé sur simulateur |
| `main/` — DeviceCore, IPC | Écrit, testé |
| `renderer/` — Dashboard, Tuning, Console | Écrit |
| `renderer/` — Control, Scope, Recipes, Firmware | Vues présentes mais grisées, avec le jalon qui les débloquera |
| `main/recipes/` — `.a2nrcp` | Pas commencé (attend la persistance NVM, M2) |
| `main/mcp/` — serveur MCP | Pas commencé. La barrière qu'il exige — refus d'une commande d'origine agent tant que « AI control » est off — existe déjà dans le DeviceCore |

### Écarts connus avec la spécification

Relevés lors d'une revue, assumés pour l'instant, à traiter :

| Écart | Spécification | Décision |
|---|---|---|
| Pas de bascule thème clair | « thème sombre par défaut **avec bascule clair** » | À faire ; les variables CSS sont déjà en place |
| `zod` non utilisé | « valider toute donnée entrante » | Le codec valide déjà structurellement. `zod` prendra son sens pour les fichiers `.a2nrcp`, édités à la main — à faire avec eux |
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
