# AGENTS.md — interface (poste PC)

Interface PC de pilotage, réglage et instrumentation pour le contrôleur A2N BLDC.
**Lire d'abord `../AGENTS.md`** : matériel, protocole partagé, règles de sécurité et conventions y
sont définis une seule fois et ne sont pas répétés ici.

---

> **Avancement.** `shared/` (codec, client, device simulé), `node/` (transport série),
> `cli/` (bring-up) et le socle Electron — `main/device/DeviceCore`, `preload/`,
> `renderer/` avec les vues Dashboard, Tuning et Console — sont écrits et testés contre le
> device simulé (145 tests). Les vues Control, Scope, Recipes et Firmware sont présentes
> dans la navigation mais grisées, avec le jalon qui les débloquera : elles n'auraient
> rien à piloter aujourd'hui. Le serveur MCP n'est pas commencé, mais la barrière qu'il
> exige — le refus d'une commande d'origine agent tant que « AI control » est off —
> existe déjà dans le DeviceCore, testée.

## 1. Objectif et périmètre

C'est un **poste de réglage et d'essai**, pas une IHM d'exploitation. Il sert à :

- régler les paramètres du contrôleur **en mode standalone**, sans recompiler le firmware ;
- gérer des **recettes de configuration** sauvegardées sur le PC, avec diff avant application ;
- **commander le moteur** : position, vitesse, accélération, couple, sens, jog, séquences ;
- **observer** : lecture live des grandeurs de monitoring et cinétiques, courbes temps réel,
  captures scope à la cadence de la boucle ;
- **journaliser** tout ce que dit le contrôleur et tout ce qu'on lui envoie ;
- exposer un **serveur MCP** pour qu'un agent IA conduise le banc exactement comme un humain.

Hors périmètre : IHM de production, supervision multi-axes, configuration du bus CAN entre nœuds.
Le CAN n'est pas utilisé par cette interface (sauf plus tard pour le flashage).

---

> **Ordre de construction.** Le firmware v2 démarre en premier, et sa mise au point a besoin d'un
> outil PC bien avant que cette application existe. Cet outil est une **CLI Node bâtie sur
> `src/shared/`** — le codec protocole définitif, pas un script jetable. L'application Electron se
> construit ensuite par-dessus le même `src/shared/`. Deux conséquences : `src/shared/` est le
> premier répertoire à écrire ici, et **il doit être utilisable sans Electron** — donc le codec y
> vit, pas dans `src/main/`.

## 2. Stack et arborescence

Electron + React 19 + TypeScript + Vite (via `electron-vite`), Tailwind, **uPlot** pour les courbes,
`node-serialport` pour la liaison USB CDC, `zod` pour la validation des données externes.
Cible **Windows d'abord**, sans dépendance Windows-only — on garde Linux/macOS ouverts.
Interface **en anglais**, **thème sombre** par défaut avec bascule clair.

```
src/
  shared/          LE codec protocole : framing cobs+crc16, dictionnaire, client,
                   device simulé, types. Ni Electron ni Node.       ← écrit
  node/            ce qui a besoin de Node : transport série.        ← écrit
  cli/             outil de bring-up firmware, sur shared/.          ← écrit
  main/            processus principal Electron
    device/        DeviceCore — état, machine à états, souscriptions télémétrie
    recipes/       lecture/écriture .a2nrcp, diff, application
    mcp/           serveur MCP et définitions d'outils
    log/           journal unifié (device | gui | mcp)
  preload/         bridge contextIsolation, API typée exposée au renderer
  renderer/
    views/         Dashboard, Control, Tuning, Recipes, Scope, Firmware
    components/    widgets réutilisables (plots, tuiles, champs paramétrés)
    plot/          intégration uPlot, buffers circulaires
docs/
  mockup/          maquette HTML de référence visuelle
```

**Écart assumé avec le plan initial** : le transport série vit dans `src/node/` et non
dans `src/main/transport/`. La raison est la règle ci-dessus — la CLI en a besoin et ne
doit pas dépendre d'Electron. La frontière entre `shared/` et le monde extérieur est
l'interface `Transport` (`shared/transport.ts`), et rien d'autre : le device simulé et le
port série sont strictement interchangeables partout, y compris dans les tests.

---

## 3. Règles d'architecture

**Le renderer ne touche jamais au port série.** Toute communication passe par le `DeviceCore` du
processus principal, seul détenteur de l'état du device. Le renderer est une vue.
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Le preload expose une API
étroite et typée, jamais `ipcRenderer` brut.

**Un seul chemin d'exécution.** L'UI, le serveur MCP et le simulateur attaquent les mêmes fonctions
du `DeviceCore`. Aucun raccourci, aucune API parallèle. Si un outil MCP peut faire quelque chose que
l'UI ne peut pas, c'est que l'UI a un trou — pas que le MCP a besoin d'un chemin dédié.

**Transport interchangeable.** `serial.ts` et `simulator.ts` implémentent la même interface. Le
simulateur n'est pas un mock de l'UI : c'est un **device virtuel complet**, modèle BLDC côté Node
(R, L, J, frottements, paires de pôles, saturation), qui parle le protocole binaire réel et sait
injecter des fautes. Il se choisit comme un port dans le sélecteur de connexion.

**Les paramètres viennent du firmware.** Les panneaux de réglage sont générés depuis le dictionnaire
lu au handshake. **Ne jamais coder en dur une liste de paramètres côté PC** — c'est la garantie
qu'ajouter un paramètre au firmware ne demande aucune modification ici.

**Performance des courbes.** Les échantillons vont dans des buffers circulaires typés
(`Float32Array`), alimentés hors du cycle de rendu React. uPlot est mis à jour par `requestAnimationFrame`,
pas par échantillon reçu. Aucun re-render React déclenché par une trame de télémétrie.
Décimation dès que la densité dépasse la résolution en pixels. Le flux de télémétrie se coupe
automatiquement quand la fenêtre n'est pas visible.

**Résilience.** Une déconnexion USB à chaud, une trame corrompue ou un CRC faux ne font jamais
tomber l'application : elles sont journalisées, l'état passe en `DISCONNECTED`, et la reconnexion
est proposée. Aucune donnée de plot n'est perdue silencieusement — une rupture de flux est visible
sur la courbe.

---

## 4. Recettes de configuration

Format `.a2nrcp` : **JSON lisible et versionné**, diffable sous git.

```jsonc
{
  "schema": 1,
  "name": "gimbal-2208-14pp",
  "created": "2026-09-14T10:22:00Z",
  "fw_version": "2.0.3",
  "param_dict_hash": "a3f1c920",
  "motor": { "pole_pairs": 7, "r_ohm": 0.35, "l_h": 120e-6 },
  "params": { "pid.iq.kp": 0.8, "pid.iq.ki": 220.0, "lim.i_max_a": 5.0 }
}
```

Une recette ne s'applique jamais en aveugle : l'utilisateur voit d'abord un **diff trois colonnes**
`File | Device | Δ`. Si `param_dict_hash` ne correspond pas au device connecté, l'application est
bloquée derrière une confirmation explicite, et les paramètres inconnus sont listés plutôt
qu'ignorés silencieusement. « Save to NVM » est une action distincte de « Write » : écrire en RAM et
persister sont deux décisions différentes.

---

## 5. Serveur MCP

Hébergé **dans le processus principal Electron**, sur le même `DeviceCore` que l'UI. Conséquence :
l'agent et l'humain voient le même état, le même journal, la même connexion device.

**Règles**

- Chaque outil MCP est une fonction du `DeviceCore` déjà utilisée par l'UI.
- **Tout appel MCP est journalisé** dans la console commune, source marquée `mcp`, avec ses
  arguments et son résultat. Rien ne se passe dans le dos de l'utilisateur.
- Les actions de l'agent **se voient dans l'UI en direct** : un paramètre écrit par l'agent s'affiche
  modifié, une consigne posée bouge les champs.
- Les outils qui **mettent le moteur en mouvement** (arm, set setpoint, run sequence, jog, calib)
  **refusent tant que « Enable AI control » est sur off**, avec un message explicite. Le toggle est
  une action humaine dans l'UI ; il n'existe aucun outil MCP pour l'activer.
- Les outils de lecture (état, paramètres, télémétrie, scope, log) sont toujours disponibles.
- Un outil ne contourne jamais une limite firmware. Modifier un paramètre de limite est possible,
  visible et journalisé — pas déguisé en réglage anodin.

**Familles d'outils prévues** : `device.*` (list, connect, status), `param.*` (list, get, set,
save_nvm), `motion.*` (arm, disarm, stop, set_mode, set_target, jog, run_sequence),
`telemetry.*` (subscribe, read, export), `scope.*` (configure, arm, capture, measure),
`recipe.*` (list, load, diff, apply, save), `log.*` (read, clear), `firmware.*` (info, upload,
rollback) — cette dernière famille arrivera avec le bootloader du firmware v2.

---

## 6. Règles de travail

**À faire**

- Développer et tester **contre le simulateur** par défaut. Le hardware sert à valider, pas à
  itérer.
- Garder `docs/mockup/` à jour quand l'UI évolue : c'est la référence visuelle partagée.
- Valider toute donnée entrante avec `zod` avant de l'utiliser — trames device comme fichiers de
  recette.
- Journaliser en clair ce qui a été envoyé et reçu quand un comportement surprend.

**À ne pas faire**

- Ouvrir un port série depuis le renderer, ou exposer `ipcRenderer` au renderer.
- Coder en dur une liste de paramètres, une unité ou une borne connue du firmware.
- Élargir une limite pour faire passer un essai.
- Déclencher un mouvement depuis un outil MCP sans « Enable AI control ».
- Ajouter un décodeur pour une trame absente de `../docs/protocol.md`.
