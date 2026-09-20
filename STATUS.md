# État d'avancement

**Fichier faisant autorité.** L'avancement se note ici et nulle part ailleurs. Les `AGENTS.md`
renvoient à ce fichier plutôt que de recopier un tableau — un état dupliqué diverge, c'est arrivé
dès la troisième passe de travail.

Ce fichier ne contient **aucun chiffre volatil** (nombre de tests, occupation flash, durée d'ISR).
Ces valeurs se mesurent, elles ne se recopient pas : `python tools/status.py` les relève sur le
dépôt réel. Une valeur écrite à la main est fausse le lendemain.

Dernière revue : 2026-09-20, sur carte, après remplacement de U3.

> **Reprise suivante — par où commencer.** Une seule mesure à faire, à l'ohmmètre, carte
> éteinte : **continuité entre `U5` broche 1 (sortie du MCP1501) et `U4` broche 20 (`VREF+`)**.
> Tout désigne une liaison ouverte — voir « VREF+ n'est tenu par personne ». Dans la même
> séance, tant que l'ohmmètre est sorti : continuité `U3` 23/22/21 → `U4` 8/9/10, et
> résistance de `U3` broche 32 et du pad thermique vers la masse. Le DRV8304 est **hors de
> cause**, remplacé sans effet, et la référence du sachet est bien `DRV8304SRHAR`. En
> attendant, `VREF.BUF ON` rend la carte mesurable : le tampon interne du MCU tient `VREF+`
> à 2,048 V et tous les rails se lisent juste.

> **Cette revue a repris des états faux.** La passe du 2026-09-15 a marqué « validé sur carte » des
> jalons dont le code n'a jamais été commité. Le détail est plus bas, section
> [« Ce que la revue du 2026-09-16 a trouvé »](#ce-que-la-revue-du-2026-09-16-a-trouvé). La règle
> qui en sort : un état ne se note ici qu'après avoir été **mesuré sur le dépôt**, pas sur un arbre
> de travail local.

---

## Firmware — `controller-2/`

| Jalon | Étape | État | Ce qui reste |
|---|---|---|---|
| **M0** | Squelette temps réel : PWM centré 20 kHz, TIM1 TRGO → ADC injecté, ISR | **Rejoué sur carte le 2026-09-16, depuis un clone frais.** Deux défauts d'origine trouvés depuis, à l'étape 3 et à l'étape 4 : les sorties basses n'étaient pas activées, et une seule voie de courant convertissait | — |
| **M1a** | Liaison USB CDC non bloquante, console texte | **Rejoué sur carte le 2026-09-16, depuis un clone frais** | — |
| **M1b** | Codec binaire COBS + CRC16, dictionnaire de paramètres | **Rejoué sur carte le 2026-09-16, depuis un clone frais** (`check` vert) | — |
| **M1c** | Télémétrie souscrite + buffer scope | **Validé sur carte le 2026-09-16** : `telem` sans trou, `scope` 2048 points sur 4 signaux à la cadence de boucle | Coût de l'échantillonnage scope dans l'ISR, voir la piste plus bas |
| **M1d** | CLI de bring-up | Validé sur simulateur **et sur carte** — toutes les commandes, `firmware-update` compris | — |
| **Boot** | Bootloader A/B, probation et rollback | **Validé sur carte le 2026-09-16** : installation SWD, `BOOT_INFO`, mise à jour nominale promue, rollback sur image qui ne confirme jamais | Rien ; un défaut trouvé sur carte, corrigé, rejoué |
| **M2** | Étage de puissance et capteurs (étapes 2 à 9) | **Étape 2 validée sur carte le 2026-09-16** : le DRV8304 répond en SPI, sept registres relus cohérents avec la fiche technique, écriture-relecture par `DRV.PROBE`, fautes lisibles. **Étape 3 validée à l'oscilloscope le 2026-09-18** : trois bras complémentaires à 20 kHz, temps mort 500 ns aux deux fronts, rapports 20/50/80 % suivis, aucune conduction croisée — après avoir trouvé que les sorties basses n'avaient jamais été activées. **Étape 4 entamée le 2026-09-18**, puis reprise le 2026-09-20 après remplacement de U3 : un défaut d'acquisition corrigé, et **deux défauts matériels isolés** — voir plus bas | Étape 4 : **bloquée par le matériel**. D'abord `VREF` qui oscille de ±370 mV, ce qui fausse toute mesure de tension de la carte ; ensuite les trois entrées de courant flottantes, que le remplacement du DRV n'a pas corrigées — continuité et masse à vérifier à l'ohmmètre. Le chemin nFAULT → coupure de `MOE` est écrit mais **jamais déclenché** |
| **M3** | Asservissements (étapes 10 à 13) | Pas commencé | — |

**Aucun moteur n'a encore tourné**, et les sorties restent en haute impédance.

La seconde passe du 2026-09-16 a rejoué sur la carte tout ce que la première n'avait fait que
compiler : les huit étapes de la [règle de vérification](#règle-de-vérification-avant-dannoncer-un-jalon),
la dernière comprise. La carte porte désormais le bootloader du dépôt et, dans ses deux slots,
l'application construite depuis un clone frais. C'est la première fois que **tout** ce qui tourne
sur la carte est reconstructible depuis le dépôt.

### Ce que la passe sur carte a trouvé

**Un bootloader était déjà installé, et ce fichier disait le contraire.** La carte portait un
bootloader `0.1.0` et deux slots valides, construits depuis l'arbre perdu du 2026-09-15 — donc
depuis des sources que personne n'a plus. La ligne « rien n'a été installé sur une carte » était
fausse ; elle a été écrite depuis le dépôt, pas depuis la carte. La règle de la première passe
(« un état ne se note qu'après avoir été mesuré ») vaut dans les deux sens : mesurer le dépôt
ne dit pas ce que la carte contient.

Ce bootloader orphelin a coûté une mise à jour : l'application du dépôt, écrite en slot B, a
été démarrée en probation puis **rejetée** — elle ne partageait pas la poignée de main SRAM de
ce bootloader-là, ne se savait pas candidate, n'a donc jamais confirmé, et l'IWDG a fait son
travail. Le rollback fonctionnait ; il n'était juste pas le bienvenu. La flash complète a été
relue par SWD avant de l'effacer (`build/flash-full-before-boot-install-2026-09-16.bin`, hors
dépôt), puis `make install-bootloader` a mis la carte au niveau du dépôt.

**`BOOT_REBOOT` redémarrait avant d'avoir répondu, une fois sur deux.** Trouvé parce que
`boot-check` échouait par intermittence sur `port fermé`. Le bootloader stockait l'instant de
la demande forcé impair — `HAL_GetTick() | 1U` — pour le distinguer de « rien en cours ». Sur un
tick pair, cet instant tombe 1 ms *dans le futur* ; la soustraction non signée qui mesure le
délai écoulé déborde, le délai de vidage est considéré comme passé, et la carte se réinitialise
avant que l'USB ait sorti la réponse. Un tick impair, et tout va bien : exactement 50 %. Les
octets bruts l'ont montré — le port disparaissait 8 ms après la requête, pas 50. Corrigé avec
l'idiome déjà en place côté application (échéance dans le futur, comparaison signée, drapeau
explicite) ; douze `boot-check` consécutifs verts depuis, contre six sur dix avant.

Les 117 vérifications hors cible ne pouvaient pas le voir : elles couvrent `boot_flash.c`,
et ce défaut vivait dans `boot_proto.c`, dans la seule ligne qui touche à l'horloge.

**Le premier démarrage après `make install-bootloader` reste en mode mise à jour.** Un seul cas,
non reproduit ensuite : un reset par la sonde ou par `BOOT_REBOOT` démarre l'application
normalement. L'explication la plus simple est un reste de poignée de main en SRAM laissé par
l'ancienne image — la SRAM survit à un effacement de flash. À garder en tête pour la prochaine
installation initiale : si `HELLO` répond `ERR_ID`, c'est le bootloader qui parle, et un reset
suffit.

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

Ce qui est vérifié **sur carte** depuis la seconde passe : l'installation initiale par SWD,
l'énumération USB du bootloader, l'effacement et la programmation d'un slot, la vérification
CRC, le saut vers un slot, la probation confirmée et promue, et le rollback par IWDG sur une
image qui ne confirme jamais — dans cet ordre, le nominal avant le négatif.

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

**Recette, telle qu'elle a été passée le 2026-09-16** : compiler les trois images ; vérifier la
taille du bootloader ; relire la flash par SWD ; `make install-bootloader` ; `BOOT_INFO` répond
(métadonnées vierges, slot A implicite) ; `firmware-update` du slot inactif avec un firmware
sain → promotion ; **puis seulement** `firmware-update` avec `make boot-trial-fail-a`, qui ne
confirme jamais → rollback, code de retour 1 comme sur simulateur. Le test négatif en dernier :
il n'a de valeur que si le chemin nominal a déjà marché. L'image de test est liée pour le slot A,
donc le test négatif se joue quand **B** est actif.

### Étape 3 : les sorties basses n'existaient pas (2026-09-18)

Première mesure à l'oscilloscope du projet, et premier défaut qu'elle a trouvé en une minute :
les trois sorties hautes propres à 20 kHz, 50 % ; les trois sorties basses muettes, avec un
petit signal en dent de scie — la diaphonie du P sur une broche en l'air. `Pwm_Init` démarrait
les canaux avec `HAL_TIM_PWM_Start`, qui n'active que `CCxE` ; les sorties complémentaires ont
leur propre bit, `CCxNE`, et leur propre appel, `HAL_TIMEx_PWMN_Start`. Sans lui, le timer ne
pilote pas `OCxN` du tout. Les GPIO étaient bons (AF6, AF4 sur `PC13`), le temps mort était
configuré : tout était prêt sauf le bit qui rend le bas réel. Le squelette M0 « validé à
l'oscilloscope » ne l'avait été que sur la broche d'instrumentation, jamais sur les six
sorties.

Après correction, mesuré sur les trois bras : complémentarité, **500 ns de temps mort aux deux
transitions** (72 ticks à 144 MHz, comme calculé), rapports 20 / 50 / 80 % suivis avec le temps
mort conservé, aucun recouvrement. Le front de `PC13` (domaine sauvegardé) n'a pas posé de
problème visible à cette échelle. Le DRV8304 a vu ses six entrées commuter pour la première
fois sans lever de faute.

Relevé au passage sur U3 pin 24 : **VREF vaut 2 V avec 200 mV de ripple, période ~40 µs**.
C'est 10 % sur la référence des CSA *et* de l'ADC du MCU, alors que rien ne commutait. La
période est celle de la salve injectée ; l'hypothèse est le courant impulsionnel de `VREF+`
à chaque conversion, que le MCP1501 n'encaisse pas avec 100 nF (C15, C9). À confirmer en
coupant l'ADC, puis un condensateur de 1 à 10 µF sur VREF. Ça compte pour le bruit de
l'étape 4, et pour toute mesure en A ensuite.

### Les courants « à zéro » : deux causes, pas une (2026-09-18)

Le point ouvert depuis M1c — trois voies de courant à 0 — vient d'être démonté sans oscilloscope,
et il cachait deux défauts indépendants.

**Le premier était dans le firmware, depuis M0.** `adc_sync.c` initialisait ADC1 avec
`ScanConvMode = ADC_SCAN_DISABLE` en croyant ne parler que du groupe régulier. Pour le HAL,
« scan désactivé » veut dire « rang 1 seulement », **groupe injecté compris** :
`InjectedNbrOfConversion = 3` était ignoré en silence et `JSQR` ne portait qu'une voie. Relu
sur la carte avec `ADC?` : `JL = 0`, `JSQ1 = 1`. Seule la phase A a jamais été convertie ; B et
C lisaient les `JDR` jamais écrits, donc zéro. Corrigé (`ADC_SCAN_ENABLE`), vérifié : `JL = 2`,
trois voies, trois `JDR` vivants. Le mot « scan » n'a aucun effet matériel sur cette famille.

**Le second est dans le matériel.** Une fois les trois voies converties, elles lisent des
valeurs statiques, différentes par voie (0,9 / 0,8 / 0,06 V), qui ne réagissent à **rien** :
ni la calibration des CSA par la broche `CAL`, ni par SPI (`CSA_CAL_x`), ni les transistors bas
passants (vecteur nul, `PWM 0 0 0` + `MOE`), ni les hauts, ni `MOE` coupé. Un CSA alimenté sort
VREF/2 ≈ 1,02 V dans tous ces cas. Puis `ADC.PROBE` a tranché : en entrée numérique, les trois
broches **suivent la résistance de tirage interne** — un nœud flottant, pas une sortie
d'amplificateur. Le schéma (lu, finalement : PyMuPDF ouvre le PDF « protégé ») relie
`SOA/SOB/SOC` de U3 directement à `PA0/PA1/PA2`. Donc : les sorties CSA du DRV8304 ne pilotent
pas ces nœuds. Le DRV est pourtant réveillé et sain (SPI, aucune faute, `CSA_CONTROL` à sa
valeur de reset).

Mesuré ensuite à l'oscilloscope, le même jour :

- **U3 pin 24 (VREF)** : 2 V présents (avec le ripple décrit à l'étape 3). Les CSA ont leur
  référence.
- **U3 pins 23/22/21 (SOA/SOB/SOC)** : SOA « carré » entre 0,5 et 1 V, SOB pareil plus bas,
  SOC à 0 V — **identiques côté U4 (MCU)**. La piste est bonne ; le carré est le condensateur
  d'échantillonnage de l'ADC qui fait sauter un nœud en haute impédance à chaque conversion,
  ce qu'une sortie d'amplificateur (< 1 kΩ) ne laisserait jamais voir.
- `CAL` haut par la broche pendant 5 s, puis `CSA_CAL_A/B/C` par SPI pendant 5 s, deux fois :
  **SOA n'a pas bougé d'un millivolt.**

Conclusion tirée ce jour-là, et **infirmée depuis** : la section analogique de U3 serait morte.
L'utilisateur a dessoudé U3 et soudé un DRV8304 neuf le 2026-09-20. **Rien n'a changé.** La
suite est plus bas, « Le DRV n'y est pour rien » et « VREF n'est pas une référence ».

Le monitoring 3V3 (`R10`/`R9` vers `PA7`) lisait zéro : **résistance mal soudée, corrigée le
2026-09-18**, lit 3,1 V depuis.

Au passage, mesuré et non supposé : VREF+ du MCU vaut bien 2,0 V (MCP1501, lu par VREFINT),
et les rails sont là — 15 V d'entrée, 14,4 V moteur, 4,9 V. La valeur de VREFINT oscille
entre deux lectures (≈ 2,00 et 2,10 V calculés) d'une passe à l'autre : probablement la
conversion régulière interrompue par la salve injectée pendant son échantillonnage long.
À régler avec l'étape 4, quand les entrées de courant existeront.

Le temps d'échantillonnage des voies injectées (6,5 cycles) est maintenant une constante
de `board.h`, `ADC_IMOT_SAMPLETIME`, prête à être ajustée contre une relecture lente — ce
réglage n'a de sens qu'avec une source réelle.

### VREF+ n'est tenu par personne (2026-09-20)

Le « ripple de 200 mV » noté à l'étape 3 n'était pas un défaut de découplage à traiter un jour :
c'est **le** défaut qui rendait toutes les mesures de cette carte fausses. Quatre commandes
neuves le démontent, sans oscilloscope.

`VREF.SCAN` enchaîne 64 conversions serrées par voie, sur quatre voies et deux convertisseurs.
Sur cette carte, VREFINT va de 2048 à 2930 counts d'une conversion à l'autre, soit un `VREF+`
qui balaie **1,70 V à 2,43 V**. Quatre faits enlèvent l'ambiguïté :

- **Toutes les voies sont dispersées du même facteur.** `vrefint` 1,430, `vin` 1,437, `vmot`
  1,433 — le bandgap interne et deux diviseurs résistifs sur deux broches différentes. C'est la
  signature d'une référence ratiométrique qui bouge. (`v3v3` et `v5` affichent moins : leurs
  diviseurs les amènent tous deux vers 1,95 V, au-dessus du creux de `VREF+`, donc elles
  **saturent** — elles ne font pas foi, `vin` et `vmot` si.)
- **La séquence brute est une sinusoïde repliée**, pas un nuage. Une oscillation entretenue.
- **Ni l'ADC ni le DRV n'y sont pour rien.** `ADC.HOLD ON` fige le groupe injecté : identique au
  count près. Broche `CAL`, `CSA_CAL` par SPI, `VREF_DIV`, `COAST` : onze balayages superposables.
- **Et ce n'est pas l'échantillonnage qui pompe le nœud.** `VREF.SCAN <écart_µs>` espace les
  conversions : de 0 à 2000 µs, la dispersion ne bouge pas d'un millième. Un nœud pompé par
  l'ADC se rétablirait entre deux conversions.

`VREF.RATIO` convertit chaque rail sur ADC2 **au même instant** que VREFINT sur ADC1 et publie
le rapport, où `VREF+` se simplifie : `vin/vrefint` tient à ±1,8 %, `vmot/vrefint` à ±1,1 %.
**Les rails sont sains ; seule la référence bouge.**

Le dernier test tranche. `VREF.BUF ON` branche le tampon de référence interne du MCU sur la même
broche, réglé sur **2,048 V — la tension que vise le MCP1501**, donc sans que l'une tire contre
l'autre si elles sont reliées. La dispersion tombe de **1,430 à 1,025**, `v3v3` cesse de saturer,
et `VREF.RATIO` passe de 1398-1625 à **1613-1620**. Coupé, tout revient. Autrement dit : dès
qu'une source basse impédance tient cette broche, tout est propre.

Or l'utilisateur avait ajouté **4,7 µF** en parallèle du 100 nF sans rien changer, à l'oscilloscope
comme ici. Faire osciller 4,7 µF de 0,74 V crête à crête à 25 kHz demanderait **0,55 A** — aucune
référence ne fait ça. Les deux observations ne peuvent tenir ensemble que d'une façon : **la
broche `VREF+` du MCU n'est pas reliée électriquement au réseau qui porte `U5` et ces
condensateurs.** Piste coupée, via percée, ou broche non soudée. D'où la mesure à faire :
ohmmètre entre `U5` broche 1 et `U4` broche 20.

Ce que ça vaut, une fois `VREF+` tenu — et c'est la première fois que ces chiffres veulent dire
quelque chose : `vref 2,053 V`, `vin 15,20 V`, `vmot 14,95 V`, `5 V 4,92 V`, `3V3 3,30 V`, stables
au millivolt. **L'alimentation de cette carte n'a jamais eu le moindre problème.** Tout ce que
`SENS.ALL?` a publié avant le 2026-09-20 est à jeter, y compris les « 2,0 V de VREF+ » du 18.

### Le DRV n'y est pour rien (2026-09-20)

U3 remplacé par un `DRV8304SRHAR` neuf — la référence du sachet a été vérifiée — la carte répond
exactement comme avant. La commande `IMOT.Z` le montre sans oscilloscope : chaque entrée de
courant est forcée 20 µs en sortie, relâchée en analogique, convertie tout de suite puis 2 ms plus
tard, vers le bas puis vers le haut. Relevé avec `VREF.BUF ON`, donc avec une référence qui tient :

| Voie | forcée bas → 0 µs, 2 ms | forcée haut → 0 µs, 2 ms |
|---|---|---|
| A | 1864, 0 | 3819, 124 |
| B | 1536, 0 | 3899, 90 |
| C | 1291, 5 | 4095, 5 |

Les deux colonnes racontent la même chose. Le premier échantillon n'est pas la tension de la
broche : forcée à 0 V puis convertie, elle lit 1864 counts, ce qui est exactement le **partage de
charge** entre le condensateur d'échantillonnage de l'ADC et une capacité de nœud d'une dizaine de
picofarads — la signature d'un nœud qui n'a aucune source. Et 2 ms plus tard, tout est retombé à
zéro, **quel que soit le sens du forçage** : une fuite, rien d'autre. Une sortie d'amplificateur —
quelques centaines d'ohms, polarisée à `VREF/2` ≈ 1,02 V — aurait imposé sa valeur dès le premier
échantillon et l'aurait tenue. Identique avec `CAL` haut, à la broche comme par SPI.

Ces trois broches ne sont reliées à aucune source, et le chip n'est pas en cause.

Ce qui n'a jamais été mesuré, et qui doit l'être maintenant, à l'ohmmètre et carte éteinte :

1. **Continuité `U3` 23/22/21 → `U4` 8/9/10.** Le 2026-09-18, « SOA identique en U3 et en U4 »
   avait été pris pour une preuve de continuité. C'en était une mauvaise : deux nœuds flottants
   voisins de l'ADC montrent le même carré d'échantillonnage. Une piste coupée expliquerait
   tout, et survivrait évidemment à un changement de puce.
2. **`U3` broche 32 (AGND) et pad thermique vers la masse.** Lire 0 V au voltmètre ne distingue
   pas « à la masse » de « en l'air » : il faut une résistance. AGND en l'air tue l'analogique
   en laissant le numérique vivre — ce qui est exactement le tableau observé.
La piste « mauvaise pièce » — `DRV8320S` partage le brochage `RHA` et n'a aucun amplificateur
de courant — est **écartée** : la référence du sachet est bien `DRV8304SRHAR`.

### Coût de l'ISR — mesuré, en partie réglé, le reste attend la FOC

La télémétrie donne la durée de l'ISR de contrôle, et le scope la donne *pendant* qu'il
échantillonne. Trois configurations ont été comparées le 2026-09-16, même carte, même capture
de 2048 points sur 4 signaux, ordres de grandeur : au repos, l'ISR vaut une fraction de
microseconde ; l'échantillonnage scope lui ajoutait environ 3,3 µs avec la configuration
d'origine (`-Og`, prefetch flash désactivé — le défaut CubeMX). Activer le prefetch retire
environ un tiers de ce surcoût ; `-O2` en retire encore un sixième. Le prefetch est acquis
(`PREFETCH_ENABLE 1` dans `stm32g4xx_hal_conf.h`). `-O2` n'est pas retenu par défaut : il
change ce qu'on voit au débogueur, et la décision appartient au moment où la FOC existera.

Ce qui reste — environ 1,8 µs pour copier quatre flottants — ne s'explique ni par le calcul ni
par la SRAM. L'hypothèse la plus probable est le cache d'instructions de 1 Ko de l'ART, dépassé
par le chemin ISR → scope → quatre lecteurs indirects : chaque passage repaye des wait-states.
La réponse classique sur G4 est de faire tourner le chemin de contrôle depuis la CCM-SRAM.
À faire avec la FOC, pas avant : c'est son budget, et son code, qui trancheront.

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
  s'interrompt. **Première moitié en place depuis le 2026-09-16** : le firmware suit DTR et la
  suspension du bus, et coupe `MOE` de lui-même dès que l'hôte disparaît — port fermé, câble
  parti. Éprouvé sur carte : un `PWM ON` envoyé par un outil qui referme le port est coupé
  dans la foulée. La seconde moitié, sur le *flux* de commandes (un hôte présent mais figé),
  reste **à implémenter avant M3, pas pendant.**
- **Schéma KiCad** — les affectations SPI2 sont électriquement impossibles (`AGENTS.md` §2). La
  carte a été retouchée à la main et fonctionne ; le schéma reste faux. **À corriger avant toute
  nouvelle fabrication**, sinon le défaut revient.
- **BOOT0 révision A** — `PB8/BOOT0` n'a pas de pull-down externe. La carte de bring-up a été
  provisionnée pour ignorer la broche et `make provision` rend l'opération reproductible. Ajouter
  un pull-down de 10 kΩ sur la prochaine révision matérielle.
- **`VREF+` du MCU n'est relié à rien qui le tienne.** La broche balaie 1,70 → 2,43 V ; le
  tampon interne posé dessus à la même tension fait tomber la dispersion de 1,430 à 1,025 ;
  4,7 µF ajoutés sur le réseau VREF n'ont rien changé, et ne le pourraient pas (2026-09-20,
  voir « `VREF+` n'est tenu par personne »). **Mesure à faire : ohmmètre entre `U5` broche 1
  et `U4` broche 20.** Les rails, eux, sont sains. Contournement disponible : `VREF.BUF ON`.
- **Entrées de courant flottantes — cause inconnue, le DRV est hors de cause.** Remplacer U3
  par un `DRV8304SRHAR` neuf n'a rien changé (2026-09-20), et `IMOT.Z` relu avec une
  référence propre montre trois nœuds sans source : après forçage, le premier échantillon
  n'est que le partage de charge du condensateur de l'ADC, et 2 ms plus tard tout est
  retombé à zéro, quel que soit le sens. Restent à l'ohmmètre : continuité `U3` 23/22/21 →
  `U4` 8/9/10, et masse sur `U3` broche 32 et pad thermique. **Bloque l'étape 4 et la suite.**

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
| `main/mcp/` — serveur MCP | Écrit, testé sur simulateur **et sur carte** (`mcp:check --port`, 2026-09-16) ; **piloté en live par un agent** le soir même, en HTTP local |

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
sans option, contre une carte avec `--port`. Passée sur carte le 2026-09-16, dix-sept points verts.

**Le serveur est en HTTP local, dans le processus de la fenêtre.** Le mode `electron . --mcp`
livré la veille n'a jamais pu fonctionner, pour deux raisons dont chacune suffisait : il tournait
sans fenêtre, donc sans aucun chemin vers « Enable AI control » — un serveur que personne ne
pouvait autoriser à écrire ; et sous Windows, Electron ferme le stdin de son processus principal
avant le premier octet, donc le transport stdio ne recevait rien. `mcp:check` ne voyait ni l'un
ni l'autre : il instancie le serveur en mémoire. Trouvé en essayant de faire la démo. Depuis, un
agent s'est connecté sur `http://127.0.0.1:4817/mcp` pendant que l'interface tournait, a écrit un
paramètre autorisé, s'est vu refuser une lecture seule par la carte et une commande hors liste
par le PC — tout dans la console commune.

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
| **`STATUS.md` disait « rien n'a été installé sur une carte »** alors qu'un bootloader d'un arbre perdu y tournait — et rejetait toute application du dépôt | Première mise à jour A/B sur carte : rollback inattendu, puis `BOOT_INFO` lu avant d'y toucher |
| **`BOOT_REBOOT` se réinitialisait avant d'avoir répondu, sur les ticks pairs** — `HAL_GetTick() \| 1U` comme sentinelle, soustraction non signée qui déborde | `boot-check` rouge une fois sur deux ; les octets bruts ont montré le port disparaître à 8 ms au lieu de 50 |
| `tools/status.py` ne trouvait pas le `make` de CubeIDE sans `toolchain.local.mk`, alors que le `Makefile` a des défauts valables | Sa sortie « build impossible » sur un poste qui venait de compiler |
| **Le serveur MCP stdio ne pouvait ni être autorisé (pas de fenêtre) ni recevoir un octet (Electron ferme stdin sous Windows)** — deux défauts invisibles à `mcp:check`, qui instancie le serveur en mémoire | Première démo à un humain : le toggle activé dans la fenêtre n'atteignait rien, puis `initialize` restait sans réponse |
| **Le tourniquet de `sensors.c` se figeait dès qu'une commande de diagnostic convertissait** — lire `DR` efface `EOC`, donc la conversion volée laissait le tourniquet attendre un drapeau perdu, et `SENS.ALL?` republiait indéfiniment le même tour | `rounds` immobile entre deux appels espacés de plusieurs secondes, 2026-09-20. Corrigé par `Sensors_Restart()` |
| **`INFO?` annonçait un temps mort de 22 ns au lieu de 500** — `DTG * 1000000000UL` déborde un `uint32_t`. La valeur affichée n'avait jamais servi à rien, ce qui l'a gardée fausse | Relevé en relisant `INFO?` à côté d'une trace d'oscilloscope, 2026-09-20 |
| **Les sorties PWM basses n'étaient jamais activées** — `HAL_TIM_PWM_Start` sans `HAL_TIMEx_PWMN_Start`, donc `CCxNE = 0` sur les trois canaux, broches en l'air | Première sonde sur `PC13` : dent de scie de diaphonie au lieu d'un carré. Étape 3, à l'oscilloscope |
| **`ADC_SCAN_DISABLE` tronquait la séquence injectée à une voie** — depuis M0, seule la phase A était convertie, B et C lisaient zéro, et zéro ressemblait à un étage de puissance éteint | La phase A s'est mise à lire *quelque chose* quand le groupe régulier a commencé à tourner à côté ; `JSQR` relu sur la carte : `JL = 0` |

Le motif commun des deux premiers et du quatrième : **le code était juste de chaque côté, c'est la
jonction qui ne l'était pas**. Un test unitaire ne les voyait pas.

Les suivants ajoutent un second motif, plus bête et plus coûteux : **ce qui n'est pas mesuré
dérive, y compris l'état d'avancement lui-même**. Et le défaut de `BOOT_REBOOT` en donne un
troisième : **une sentinelle qui altère la valeur qu'elle marque** — forcer un bit pour dire
« en cours » a déplacé l'instant qu'on voulait garder. Une variable de plus aurait coûté un octet. Un fichier qui n'existe que dans un arbre de
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
8. sur carte : `npm run cli -- check`, `telem`, `scope`, `boot-check`, puis
   `npm run mcp:check -- --port COMx` — **les seuls qui valident vraiment**

Passées toutes les huit le 2026-09-16, sauf la quatrième : ce poste n'a pas de compilateur C
hôte. Elle reste due.

Les sept premiers ne prouvent que la cohérence interne. Un jalon n'est « passé » que quand le
huitième l'est, et ce fichier doit le dire ainsi.

**Et la règle que cette revue ajoute :** l'état noté ici doit être vrai **pour un clone frais du
dépôt**, pas pour l'arbre de travail de celui qui écrit. `git status` propre ne suffit pas — un
fichier jamais ajouté n'y apparaît pas.
