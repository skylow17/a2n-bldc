# État d'avancement

**Fichier faisant autorité.** L'avancement se note ici et nulle part ailleurs. Les `AGENTS.md`
renvoient à ce fichier plutôt que de recopier un tableau — un état dupliqué diverge, c'est arrivé
dès la troisième passe de travail.

Ce fichier ne contient **aucun chiffre volatil** (nombre de tests, occupation flash, durée d'ISR).
Ces valeurs se mesurent, elles ne se recopient pas : `python tools/status.py` les relève sur le
dépôt réel. Une valeur écrite à la main est fausse le lendemain.

Dernière revue : 2026-09-21, sur carte — deux causes matérielles trouvées dans les datasheets, la retouche de la référence vérifiée, les étapes 4 et 6 mesurées, et une passe de fond sur l'interface.

> **Reprise suivante — par où commencer.** Les deux défauts matériels sont **expliqués**, et
> aucun des deux n'est une panne : ce sont deux erreurs de conception, l'une et l'autre
> lisibles dans la datasheet du composant concerné. Voir
> [« Une référence à 2,048 V, deux composants qui ne peuvent pas s'en contenter »](#une-référence-à-2048-v-deux-composants-qui-ne-peuvent-pas-sen-contenter).
>
> **C'est fait, et ça a marché.** `U5` est déposé, ses pastilles 1 et 6 pontées, le net
> `VREF` est passé à 3,3 V : les trois amplis de shunt fonctionnent pour la première fois,
> `csa_raw` groupés à 2 counts près autour de la mi-échelle, et l'oscillation a disparu avec
> son oscillateur. L'étape 4 n'est plus bloquée par le matériel.
>
> **Un défaut a été trouvé dans la foulée : le SPI du DRV ne répond plus.** Tous les
> registres se relisent à zéro. Constaté le 2026-09-21, mais la dernière preuve qu'il
> fonctionnait date du 2026-09-16, **avant le remplacement de `U3`** : les zéros lus après
> ce remplacement avaient été pris pour « aucune faute ». Premier suspect, donc, la soudure
> de `U3` broches 26 à 29. Deux hypothèses ont été formulées et réfutées par la mesure ; il
> faut maintenant un oscilloscope. `DRV.LOOP 5000` martèle une lecture pour qu'on puisse déclencher dessus,
> sondes sur `U3` broches 29, 28, 27 et 26 — toutes en bord de boîtier. Détail et ordre des
> vérifications dans « Le SPI du DRV ne répond plus ».
>
> **Ne pas alimenter l'étage de puissance avant d'avoir compris** : `nFAULT` tient et la
> coupure ne passe pas par le SPI, mais on ne saurait ni lire une faute ni régler le gain
> des amplis.
>
> **Côté interface, deux fonctions manquent** et sont notées pour la reprise : naviguer
> dans la télémétrie figée comme dans une capture, et l'exporter en CSV. Détail et ordre
> dans « À reprendre sur l'interface ».
>
> Côté logiciel, rien n'attend. Le **watchdog de flux de commandes** est en place des deux
> côtés et éprouvé sur carte : c'était le dernier prérequis de M3 (`AGENTS.md` §4.3). Le
> tableau de bord montre enfin ce que la carte mesure, et la console se filtre.
>
> L'**étape 6 est écrite, mesurée et validée à titre provisoire** (AS5600 en DMA à 1 MHz),
> hors séquence puisqu'elle ne dépend pas des étapes bloquées. Deux réserves à lever quand
> la carte sera rebranchée, et elles ne bloquent rien : le registre `STATUS` du capteur ne
> confirmait pas l'aimant lors de ma dernière lecture, et le taux d'erreurs I²C sur une
> longue durée mérite un coup d'œil. Détail dans la section de l'étape 6.

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
| **M2** | Étage de puissance et capteurs (étapes 2 à 9) | **Étape 2 : validée le 2026-09-16, EN RÉGRESSION** — tous les registres se relisent à zéro. Constaté le 2026-09-21, mais la dernière preuve date d'avant le remplacement de `U3` : rien n'atteste que le SPI ait fonctionné depuis. Voir plus bas. Pour mémoire, la validation d'origine : le DRV8304 répond en SPI, sept registres relus cohérents avec la fiche technique, écriture-relecture par `DRV.PROBE`, fautes lisibles. **Étape 3 validée à l'oscilloscope le 2026-09-18** : trois bras complémentaires à 20 kHz, temps mort 500 ns aux deux fronts, rapports 20/50/80 % suivis, aucune conduction croisée — après avoir trouvé que les sorties basses n'avaient jamais été activées. **Étape 4 entamée le 2026-09-18**, puis reprise le 2026-09-20 après remplacement de U3 : un défaut d'acquisition corrigé, et **deux défauts matériels isolés** — voir plus bas | Étape 4 : **offsets et bruit mesurés et documentés le 2026-09-21** — zéro de chaîne à 1–11 counts de la mi-échelle, répétable à ±1 count sur quatre campagnes, écart-type de 1,4 à 2,0 counts avec `CAL` levé. Ni SPI ni sortie de puissance requis. Reste à confirmer que le gain vaut bien 20 V/V, ce qui demande le SPI. Pour mémoire, ce qui bloquait avant : D'abord `VREF` qui oscille de ±370 mV, ce qui fausse toute mesure de tension de la carte ; ensuite les trois entrées de courant flottantes, que le remplacement du DRV n'a pas corrigées — continuité et masse à vérifier à l'ohmmètre. Le chemin nFAULT → coupure de `MOE` est écrit mais **jamais déclenché** . **Étape 6 écrite hors séquence et éprouvée sur carte** (2026-09-21) puisqu'elle ne dépend ni de 4 ni de 5 : AS5600 en DMA à 1 MHz, transfert 57 µs, un échantillon toutes les 59 µs, ISR à 2,60 µs au pire. **Verte à titre provisoire** : le critère « angle monotone à la main » a été validé par l'utilisateur, aimant monté, et je n'ai pas assisté à la mesure — une réserve reste à lever, voir la section de l'étape 6 |
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
comme ici. J'en ai conclu à une liaison coupée entre la broche 20 et le réseau portant les
condensateurs. **Mesuré, c'est faux** : 0 Ω entre `U5` broche 1 et `U4` broche 20, et le même
signal sur les deux broches à l'oscilloscope. Le réseau est entier.

Ce qui déplace la question sur la fréquence, puisque le courant nécessaire en dépend. `VREF.FREQ`
la mesure de l'intérieur : 512 conversions de VREFINT à cadence imposée, cadencée au compteur de
cycles, et comptage des passages par la moyenne. Cinq cadences de 8 à 25 µs donnent **10,0 kHz à
0,5 % près** — une fréquence repliée changerait avec la cadence, celle-ci ne bouge pas. Les
cadences au-delà de Nyquist (50, 200, 1000 µs) donnent bien n'importe quoi, ce qui valide la
méthode.

À 10 kHz et 717 mV crête à crête, `C·2πf·V/2` vaut **108 mA** si 4,8 µF étaient sur ce nœud, et
**2,25 mA** si seul le 100 nF de `C9` y est. Le second est banal, et cohérent avec la borne
supérieure indépendante : le tampon interne du MCU, spécifié 4 mA, écrase l'oscillation **87
fois**. Conclusion : **le nœud ne porte que 100 nF, donc la capacité ajoutée n'y est pas
électriquement.** Reste à trancher entre une soudure froide et un `U5` intrinsèquement instable —
un coup de fer sur la patte de sortie, mesurée à vide, le dira.

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

Refait le 2026-09-20 avec `VREF.BUF ON`, qui tient `VREF+` **et**, le réseau étant continu, la
broche `VREF` du DRV : rien ne change. À courant nul, un CSA alimenté sort `VREF/2` ≈ 1,024 V en
basse impédance — ce point de repos n'a besoin d'aucun courant dans le shunt pour exister. On lit
`1027, 724, 66` puis `994, 790, 57` d'un relevé à l'autre. Ça dérive, donc ce n'est pas une
tension de repos.

Et une preuve indépendante, tombée par accident : **ajouter le capteur de température au
tourniquet de l'ADC a déplacé les valeurs lues sur les entrées de courant** (`1054, 847, 64` avant,
`1027, 724, 66` après). Une voie sans rapport, convertie ailleurs dans la séquence, ne peut pas
influencer une broche tenue par une source basse impédance ; elle influence exactement un nœud
flottant, par la charge que le condensateur d'échantillonnage lui apporte de la conversion
précédente. Le `1027` de la phase A, si proche de `VREF/2` qu'il donne envie d'y croire, est une
coïncidence d'équilibre de charge — la lecture suivante donne 994.

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

### Une référence à 2,048 V, deux composants qui ne peuvent pas s'en contenter (2026-09-21)

Les deux défauts matériels qui bloquaient M2 sont expliqués. **Aucun des deux n'est une panne.**
Ce sont deux erreurs de conception sur le même net, chacune écrite noir sur blanc dans la
datasheet du composant concerné. Le schéma est bon, les pistes sont bonnes, les composants sont
bons — c'est le choix de la tension et celui du découplage qui sont faux.

Le net `VREF` part de `U5` (MCP1501-20xCH, 2,048 V) et alimente deux choses : `U4` broche 20,
la référence de l'ADC du MCU, et `U3` broche 24. C'est cette deuxième destination qui pose
problème, deux fois.

**1. Les amplis de shunt sont maintenus éteints par le DRV lui-même.**

La broche 24 du DRV8304 n'est pas qu'une référence. La datasheet la décrit ainsi :

> `VREF 24 PWR` — *Shunt amplifier **power supply** input and reference.*

C'est l'alimentation des trois amplificateurs. Et deux lignes de la table des caractéristiques
électriques ferment le dossier :

| Paramètre | Valeur |
|---|---|
| `VREFUV` — VREF undervoltage | **2,6 V** |
| Gain des amplis, conditions d'essai | `VREF = 3.3 to 5 V` |

La carte y injecte **2,048 V**. C'est sous le seuil de sous-tension, et très en dessous de la
plage où TI caractérise quoi que ce soit. Les trois amplis ne sont jamais alimentés.

`VREFUV` n'apparaît **qu'une seule fois** dans les 66 pages : la valeur, sans une ligne
d'explication, et sans bit de statut associé. D'où le symptôme muet — aucune faute remontée,
`FS1`/`FS2` à zéro, le reste du composant parfaitement fonctionnel.

Tout ce qui avait été observé s'aligne :

| Observation | Explication |
|---|---|
| `IMOT.DECAY` : A/B/C décroissent comme `PA3` (broche sans liaison), τ ≈ 150 ms | Un étage de sortie non alimenté est en haute impédance |
| Point de repos `VREF/2` absent | Pas d'alimentation, pas de polarisation |
| `CAL` sans effet | Court-circuiter les entrées d'un ampli éteint ne fait rien |
| `U3` remplacé, comportement identique | Les deux composants se comportent **correctement** |
| SPI, grilles, fautes : tout marche | Alimentés par `DVDD`, sans rapport avec `VREF` |

Le point de départ de `IMOT.DECAY` chiffre en plus la capacité des nœuds par partage de charge
avec le condensateur d'échantillonnage de l'ADC : ~4 pF pour `PA3` nue, ~8 pF pour `ImotA`.
L'écart est celui d'une piste courte et d'une broche de boîtier. **Les pistes sont intactes** —
ce que l'utilisateur soutenait, et il avait raison.

**2. Le MCP1501 oscille parce qu'on lui a collé 333 fois sa charge capacitive maximale.**

Datasheet MCP1501, §5.1.2 :

> *LOAD CAPACITOR — The maximum capacitive load is **300 pF**. However, larger capacitors may be
> implemented if a resistor is used in series with a larger load capacitor.*

C9 fait **100 nF**, directement sur la sortie, sans résistance série. C'est le seul condensateur
du net — il n'y en a aucun côté `U5`. D'où les 10 kHz, 717 mVpp, insensibles à tout ce qu'on a
essayé côté MCU. Et d'où l'inefficacité du 4,7 µF ajouté en parallèle : il portait la charge à
16 000 fois la limite au lieu de 333.

**Essai fait, non concluant, gardé pour mémoire.** Le VREFBUF du STM32G473 propose trois échelles
(2,048 / 2,5 / **2,9 V**), et 2,9 V passe au-dessus du seuil de 2,6 V du DRV. `VREF.BUF ON 2900`
permet donc de tenter le réveil des amplis sans fer à souder. Sur carte, `ready` reste à 0 : le
MCP1501 (±5 mA) tient le nœud contre les 4 mA du tampon, et `vref_mv` ne fait que vaciller entre
1,7 et 2,4 V. La commande reste utile pour une autre carte ; ici elle ne tranche pas.

**Les deux corrections de fond**, pour la révision suivante du PCB :

- **Remplacer `U5` par un MCP1501-30 (3,0 V).** Une seule substitution, et les deux usages
  redeviennent compatibles : 3,0 V passe au-dessus du seuil de 2,6 V du DRV, et reste sous `VDDA`
  avec 0,3 V de marge côté MCU. Le point de repos des sorties `SOx` devient 1,5 V, soit exactement
  le milieu de l'échelle de l'ADC — **aucun diviseur à ajouter, mesure entièrement ratiométrique**.
  Les diviseurs de monitoring existants y gagnent aussi : le rail 5 V lit aujourd'hui 2,0 V contre
  une référence de 2,048 V, à la limite de la saturation. Seule réserve : 3,0 V est au-dessus du
  seuil mais sous la plage 3,3–5 V où TI caractérise le gain.
- **Si la précision de gain compte davantage** : alimenter `U3` broche 24 depuis le rail +5 V
  (milieu de la plage caractérisée) et ajouter un diviseur ~0,41 sur chaque `SOx`. Le rail 5 V est
  déjà mesuré par le MCU (`ADC2_IN3`), donc l'erreur de gain reste corrigeable en logiciel. Six
  résistances de plus, et la mesure n'est plus ratiométrique.
- **Dans les deux cas** : intercaler une résistance d'isolement (~47–100 Ω) entre la sortie de
  `U5` et son condensateur de découplage, comme le demande le §5.1.2, et placer ce condensateur
  contre la broche `VREF+` du MCU plutôt qu'à l'autre bout de la carte.

**Confiance : élevée sur le diagnostic, à confirmer sur carte.** Chaque affirmation vient d'une
datasheet et chaque symptôme mesuré s'y range, mais rien n'est encore prouvé par une intervention.
Les deux prédictions à vérifier sont dans le bloc de reprise en tête de fichier.

### La retouche : `U5` déposé, tout sur 3,3 V (2026-09-21)

Les deux défauts matériels se corrigent d'un seul geste, et c'est l'utilisateur qui a trouvé
la bonne forme. Plutôt que d'isoler la broche 24 du DRV et de lui tirer un fil — délicat sur un
QFN 0,5 mm — on **dépose `U5` (MCP1501-20) et on ponte ses pastilles 1 (OUT) et 6 (VDD)**. Le
net `VREF` entier devient le rail 3,3 V, qui est aussi `VDDA`.

Rien à couper, un composant retiré, un pont.

| Effet | Pourquoi |
|---|---|
| Amplis de shunt alimentés | 3,3 V est au-dessus du seuil de sous-tension de 2,6 V du DRV8304, et au bas de sa plage caractérisée |
| Oscillation supprimée | L'oscillateur est physiquement retiré |
| C9 devient légitime | Plus de limite à 300 pF ; C9 redevient le 100 nF de découplage `VREF`/`AGND` que TI demande |
| Mesure de courant **ratiométrique** | Le repos des `SOx` vaut `VREF/2` et la pleine échelle de l'ADC vaut `VREF` : le zéro tombe pile à 2048 counts, et une dérive du rail décale les deux dans le même sens |
| Séquencement plus sûr | `VREF+` et `VDDA` montent ensemble ; `VREF+` ne peut plus dépasser `VDDA` |

**Plage de courant obtenue**, shunts de 10 mΩ, gain **par défaut** (20 V/V) : la plage linéaire
de l'ampli va de 0,25 V à `VREF − 0,25` = 3,05 V, soit **±7,0 A symétriques** à 4 mA par LSB.
C'est l'ampli qui limite, pas le convertisseur — rien n'est gaspillé, et aucun registre à
changer. À 5 V/V on monterait à ±28 A.

**Aucune saturation nulle part**, et tout gagne de la marge puisque la pleine échelle passe de
2,048 à 3,3 V : le rail 5 V occupait **98 %** de l'échelle, il en occupe 61 %.

**Ce qui a changé dans le logiciel.** Rien pour les mesures : `sensors.c` part du `VREF+` mesuré
par `VREFINT` et non d'une constante, donc tout se recale seul. Ont été repris :

- `BOARD_VREF_MV` passe à 3300. C'est une **déclaration** — ce que le firmware annonce dans
  `INFO?` et dans `board.vref_mv` — pas une hypothèse de calcul.
- Le tableau de bord lisait 2048 **en dur** pour juger `VREF+`, et aurait affiché la référence
  en faute permanente. Il lit désormais le nominal dans le dictionnaire que le firmware publie,
  comme le veut `AGENTS.md` §3.
- `VREF.BUF ON` **refuse** maintenant si la broche est déjà tenue plus haut que la consigne.
  Sans ce garde-fou, la commande demanderait au tampon interne de tirer `VREF+` à 2,048 V contre
  un LDO : limitation silencieuse, `VRR` jamais levé, et des mesures fausses que rien ne signale.
  C'est l'erreur de configuration typique d'une carte retouchée à la main.
- La bannière « référence instable » conseillait `VREF.BUF ON`. Le conseil serait devenu faux ;
  elle renvoie vers `VREF.RATIO`, qui dit si le défaut vient du rail ou de la référence seule.
- Le simulateur porte la carte retouchée : `vref_mv=3300`, et `csa_mv=1650` au repos, c'est-à-dire
  pile la mi-échelle. Le test de supervision compare au nominal du dictionnaire au lieu d'une
  valeur écrite en dur — la carte a changé de référence une fois, elle peut recommencer.

**Réserve de fond.** La référence est désormais un rail de LDO (±2 %, bruité) là où un bandgap
ne l'est pas. Pour les étapes 4 à 9, sans importance : le courant est ratiométrique, et `VREFINT`
rattrape l'absolu sur les rails. Pour la révision B, non — un **MCP1501-30 (3,0 V)** garde la
propriété ratiométrique *et* un vrai bandgap, avec une résistance d'isolement avant son
condensateur comme le demande sa datasheet.

**Vérifié sur carte le 2026-09-21, et le diagnostic était bon.** Immédiatement après le flash :

```
vref_mv=3305  vin_mv=15288  vmot_mv=15056  v5_mv=4945  v3v3_mv=3304  mcu_temp_c=35
csa_raw=2056,2056,2058   csa_mv=1659,1659,1660
```

**Les trois entrées de courant sont groupées à 2 counts les unes des autres, à 8 counts de la
mi-échelle.** Avant la retouche elles lisaient `2126, 1650, 80`, dispersées et dérivantes. Les
amplis de shunt fonctionnent pour la première fois depuis que cette carte existe. Prédiction
faite avant l'intervention : « les trois `csa_raw` groupés et stables autour de 2048 ». Tenue.

Le reste suit :

- `VREF+` à 3300–3305 mV sur tous les relevés, là où il balayait 1,70 à 2,43 V ;
- `VREF.FREQ` donne `raw_min=1502 raw_max=1513`, soit **11 counts d'écart** contre 717 mV crête
  à crête auparavant. L'oscillation à 10 kHz a disparu avec son oscillateur ;
- tous les rails se lisent justes sans béquille : 15,29 V, 15,06 V, 4,945 V, 3,304 V, 35 °C ;
- le garde-fou répond `ERR DRIVEN vref_mv=3300 target_mv=2048`, comme prévu.

**L'étape 4 n'est plus bloquée par le matériel.**

### Étape 4 — offsets et bruit de la chaîne de courant (2026-09-21)

Première étape rendue possible par la retouche de la référence, et **elle n'a eu besoin ni du
SPI ni de la moindre sortie de puissance** : le calibrage d'offset passe par la broche `CAL`
du DRV, pas par un registre, et `MOE` reste coupé du début à la fin.

Deux campagnes, parce qu'elles ne disent pas la même chose. `IMOT.CAL` lève `CAL`, qui
court-circuite les entrées des amplificateurs : ce qui sort est le zéro vrai de la chaîne.
`IMOT.NOISE` ne touche à rien et mesure la chaîne telle qu'elle travaille.

**Mesuré sur carte, 8000 échantillons par campagne, `MOE` coupé :**

| | Phase A | Phase B | Phase C |
|---|---|---|---|
| Zéro de chaîne (`CAL` levé) | 2052 | 2059 | 2049 |
| Écart à la mi-échelle | **+4** | **+11** | **+1** |
| Écart-type, `CAL` levé | 1,61 | 1,97 | 1,44 |
| Écart-type, `CAL` au repos | 4,15 | 3,73 | 3,42 |
| Étendue, `CAL` au repos | 62 | 41 | 64 |

Tout est en counts. Un count vaut `VREF/4096` = 0,806 mV, soit **4,03 mA** avec le gain de
20 V/V et les shunts de 10 mΩ — à la réserve près que ce gain est la valeur de reset et qu'on
**ne peut pas la vérifier tant que le SPI est muet**.

**Le critère de l'étape est tenu : les offsets sont stables.** Quatre campagnes successives
donnent A à 2051–2052, B à 2059–2060, C à 2049 — **une dispersion d'un count**, soit ±4 mA.

Et le zéro de chaîne tombe à 1 à 11 counts de la mi-échelle théorique, c'est-à-dire 0,02 à
0,27 % de la pleine échelle. C'est la propriété ratiométrique gagnée par la retouche qui le
permet : `SOx` repose à `VREF/2` et l'ADC convertit sur `VREF`, donc le zéro tombe au milieu
sans que la valeur de `VREF` intervienne.

**Le résultat le plus intéressant est l'écart entre les deux campagnes.** Court-circuiter les
entrées divise l'écart-type par 2,4 et l'étendue par 5. Or `CAL` agit sur les **entrées** de
l'amplificateur : ce qui disparaît n'est donc ni du bruit d'amplificateur ni du bruit d'ADC,
c'est quelque chose qui arrive aux bornes des shunts. Avec `MOE` coupé et aucun courant moteur,
c'est du couplage. Converti : 4,15 counts d'écart-type font **17 mA RMS**, et 62 counts
d'étendue font **250 mA crête à crête**, dans le cas le plus calme qui soit. Sous PWM ce sera
pire. C'est le plancher qui limitera la boucle de courant, et c'est à surveiller à l'étape 5.

**Coût dans l'ISR.** La boucle passe de 2,49 à **3,62 µs** au repos, soit 7,2 % du budget, pour
l'accumulation conditionnelle et le centrage des trois phases. `max` vaut 3,625 µs contre 3,618
de `last` : **aucun pic**. Pendant une campagne le maximum monte à 4,99 µs, le temps des
additions 64 bits — c'est transitoire et hors de tout chemin de régulation.

Trois signaux de télémétrie arrivent avec : `current.ia_count`, `ib`, `ic`, le brut moins
l'offset. **En counts et non en ampères**, délibérément : la conversion demande un gain qu'on
ne peut pas relire, et un signal en ampères serait faux sans le dire.

**Ce qui reste pour clore l'étape 4 :** vérifier que le gain vaut bien 20 V/V, ce qui demande
le SPI. Les offsets et le bruit, eux, sont mesurés et documentés.

### Le SPI du DRV ne répond plus, et c'est un défaut nouveau (2026-09-21)

Trouvé en voulant commander les amplis pour prouver qu'ils obéissent. **Tous les registres du
DRV8304 se relisent à `0x000`** et `DRV.PROBE` échoue. `DRV.LOOP 500` compte 19 998 échanges qui
aboutissent tous au niveau du périphérique et rendent tous zéro.

**Depuis quand ? Plus tôt qu'on ne l'a cru, et la preuve manquait.** La dernière validation
réelle date du 2026-09-16 — « sept registres relus cohérents avec la fiche technique ». Entre
cette date et aujourd'hui, **`U3` a été remplacé** (2026-09-20). Et après ce remplacement, on a
lu `FS1`/`FS2` à zéro en concluant « aucune protection active » : **des zéros sont exactement ce
que rend un SPI mort.** La preuve était ambiguë et elle est passée. Il n'existe donc aucune
mesure attestant que le SPI ait fonctionné après le changement de composant.

Conséquence pour l'enquête : le suspect n'est pas le travail du 2026-09-21. `U5` est ailleurs sur
la carte et ne touche aucune ligne du SPI. **C'est la soudure de `U3` qu'il faut regarder en
premier**, broches 26 à 29 — `SDO`, `SDI`, `SCLK`, `nSCS` — toutes sur le même bord du boîtier.

Ce que ça ne remet pas en cause : le composant est vivant et dans son état de reset. Les sorties
`SOx` sont polarisées à `VREF/2`, ce qui **exige** `VREF_DIV = 1`, la valeur par défaut. Et le
chemin de sécurité ne passe pas par le SPI — `nFAULT` est une broche, lue par EXTI, et la coupure
de `MOE` est déclenchée sans dialogue. Il reste intact.

**Deux hypothèses formulées, deux réfutées par la mesure.** Elles sont notées parce qu'elles
coûteraient à refaire.

1. *« `SDO` est un drain ouvert et son tirage manque »* — la fiche technique l'exige, le schéma
   n'en montre aucun, et le firmware ne mettait pas de tirage interne sur `MISO` alors qu'il en
   met un sur `nFAULT`. Ajouté, plus une baisse de cadence du bus à 562 kHz pour compenser la
   mollesse d'un tirage interne : **aucun effet**. Les deux modifications ont été retirées.
2. La commande `DRV.PINS`, écrite pour trancher, a réfuté l'hypothèse elle-même : `miso=1,1`,
   c'est-à-dire **1 même avec le tirage interne vers le bas**. Le tirage externe existe donc et
   il est franc. `sck=0,1` et `mosi=0,1` suivent librement, `nCS` est haut au repos. Le câblage
   est sain au repos.

Ce qui reste, et que je ne peux pas départager sans oscilloscope : le périphérique termine ses
trames, `MISO` est tiré haut au repos, et pourtant la donnée reçue est nulle — il faut donc que
quelque chose tire la ligne bas **pendant** la trame. `DRV.LOOP` existe pour ça : elle martèle
une lecture pendant quelques secondes, de quoi déclencher un oscilloscope sur les quatre lignes.

**Prochaine mesure, dans cet ordre :** `DRV.LOOP 5000`, sondes sur `nCS`, `SCK`, `MOSI`, `SDO`
aux broches 29, 28, 27 et 26 de `U3` — ce sont des broches de bord, accessibles. On cherche : est-ce
que `nCS` descend ? est-ce que l'horloge arrive au composant ? est-ce que `SDO` bouge ? Trois
réponses, trois pannes différentes. La carte a été retouchée à la main sur ces lignes
(`AGENTS.md` §2) et `U3` a été remplacé depuis la dernière validation : ce sont les deux suspects.

**Rien ne doit alimenter l'étage de puissance tant que ce n'est pas compris.** Pas pour une
question de sécurité — `nFAULT` tient — mais parce qu'on ne saurait ni lire une faute par SPI ni
régler le gain des amplis.

### Étape 6 — l'AS5600 lu en DMA, et le retard enfin chiffré (2026-09-21)

Écrite **hors séquence** : les étapes 4 et 5 sont bloquées par le matériel, et l'étape 6 n'en
dépend pas. Le module est donc là, éprouvé sur carte, mais l'étape n'est pas déclarée verte —
voir « Ce qui reste » plus bas.

C'est la marche que le v1 avait ratée, et qui mérite d'être nommée : là-bas, `As5600_ReadRawAngle`
appelait `HAL_I2C_Mem_Read` **bloquant** à 100 kHz depuis la superloop, ce qui plafonnait tout le
firmware à environ 1,5 kHz avec de la gigue. Ici la chaîne I2C se relance depuis sa propre
interruption de fin, en DMA, et l'ISR de contrôle ne fait qu'extrapoler depuis le dernier
échantillon publié et son horodatage.

**Mesuré sur carte, Fast-mode Plus à 1 MHz :**

| Grandeur | Mesure |
|---|---|
| Durée d'un transfert | **57 µs** |
| Intervalle entre échantillons | **59 µs**, soit ~17 kHz |
| Âge de l'échantillon vu par l'ISR | 4 µs typique, 118 µs au pire en régime normal |
| Durée de l'ISR de contrôle | 2,49 µs, **max 2,60 µs** — charge 5,2 % |
| Erreurs I2C | 2 sur ~500 000 transferts, reprises automatiquement |

`AGENTS.md` §3 visait « ~70 µs par lecture, soit ~10 kHz effectif » : on est à 57 µs et 17 kHz.
Le schéma annotait les tirages R21/R22 (4k7) d'un « TBC » en soupçonnant un temps de montée trop
lent pour le Fast-mode Plus — **mesuré, ça passe**, et 1 MHz est devenu le défaut.

Que `max` et `last` de l'ISR soient à 4 % l'un de l'autre est le résultat qui compte : le capteur
n'introduit **aucun pic**. C'est le critère « aucun blocage de l'ISR », mesuré plutôt qu'espéré.

**Le retard du capteur lui-même était le vrai piège.** L'AS5600 échantillonne toutes les 150 µs
puis filtre, et le champ `SF` du registre `CONF` vaut `00` au démarrage — soit **2,2 ms**
d'établissement, 44 périodes de la boucle de contrôle. À 3000 tr/min c'est 40° de rotation
mécanique : inutilisable pour orienter un champ. `Encoder_Init` écrit donc `SF = 11` (0,286 ms) à
chaque démarrage. Le bruit passe de 0,015° à 0,043° RMS, ce qui reste bien sous le pas de
quantification de 12 bits (0,088°) : on ne perd rien de réel et on gagne un facteur 7,7.

Le budget complet est donc : **286 µs** de filtre interne (irréductible sans changer de capteur),
**57 µs** de transport, et **0 à 118 µs** d'âge — ces deux derniers annulés par l'extrapolation.

**Deux défauts trouvés en écrivant ce module, tous deux sur carte.**

Le premier était à moi et instructif. La reprise après erreur se contentait d'un
`HAL_I2C_Master_Abort_IT` suivi d'un réglage : elle n'a jamais repris une seule fois. `Abort_IT`
est asynchrone et a besoin du bus pour aboutir — or le bus est justement ce qui est mort. Surtout,
**le canal DMA restait armé**, si bien que chaque relance se faisait renvoyer `HAL_BUSY` en
silence : `reads_ok` et `reads_err` tous les deux à zéro, et l'angle figé sur sa dernière valeur
sans que rien ne le déclare faux. J'en avais conclu un peu vite que le bus ne tenait pas le 1 MHz ;
la remise à plat complète écrite, 1 MHz passe sans une erreur. D'où aussi un **garde-fou** : plus
de transfert abouti pendant 20 ms et la chaîne est remise à plat, parce qu'un angle qui ne bouge
plus et que personne ne déclare faux se propage jusque dans une boucle de position.

Le second : les trois signaux d'encodeur sortaient à **zéro** sur le flux de télémétrie souscrit
alors que la console donnait la bonne valeur. Le streaming reconstruit son instantané depuis
`Ctrl_Stats_t`, pas depuis celui de l'ISR ; les champs manquaient. Corrigé en les faisant transiter
par le canal de publication existant — et non en relisant l'encodeur depuis la superloop, ce qui
aurait extrapolé à un autre instant et touché au cache de l'ISR.

**Validée à titre provisoire, sur mesure de l'utilisateur (2026-09-21).** Aimant monté, le
critère « angle croissant monotone à la main » a été vérifié au banc. **Je n'ai pas assisté à
cette mesure** : elle est notée telle qu'elle m'a été rapportée, et c'est la seule étape du
projet dont l'état ne repose pas sur une observation que j'ai faite moi-même.

Deux réserves, à lever quand la carte sera rebranchée. Ni l'une ni l'autre ne bloque la suite,
mais les taire reviendrait à arrondir un état.

1. **Le registre `STATUS` ne confirmait pas l'aimant à ma dernière lecture.** Prise juste après
   le message de validation : `status=0x57`, soit `MD = 0` et `ML = 1` — le capteur déclarait
   toujours l'aimant absent ou trop faible, alors que `turns=7` et un angle cohérent disent
   qu'il a bien tourné. Trois lectures possibles : l'aimant a été présenté puis retiré, il est
   monté mais trop loin ou pas diamétralement magnétisé, ou le bit `MD` n'a pas basculé pour
   une autre raison. `ENC.REG 0x1A` (AGC) et `0x1B` (MAGNITUDE) trancheront en une commande —
   un AGC près de sa butée haute veut dire champ trop faible. Le port a disparu avant que je
   puisse les lire. À noter que le critère de l'étape est l'angle qui suit l'arbre, pas le bit
   `MD` : c'est un indicateur de confort, pas la mesure.
2. **491 erreurs I²C sur 95 millions de transferts** après environ 1 h 45 de fonctionnement,
   soit une pour 194 000, toutes reprises automatiquement. Le taux est faible et la chaîne
   n'est jamais restée bloquée — `age_max_us` a plafonné à 1509 µs, ce qui est la durée d'une
   remise à plat et non un défaut de cadence. Mais sur la première chauffe de 30 s on comptait
   2 erreurs pour 500 000 transferts, soit un pour 250 000 : le taux est stable, pas croissant.
   À regarder si un asservissement de position s'avère nerveux.

`ENC_LAG_COMP_US` reste à zéro. Compenser le retard de groupe du filtre interne demande la
réponse indicielle de l'étape 11 ; avancer la prédiction d'un nombre non mesuré serait inventer
de la fraîcheur.

### Watchdog de flux de commandes — les deux moitiés, et la carte le prouve (2026-09-20)

`AGENTS.md` §4.3 demande que le couple tombe si le flux de commandes s'interrompt pendant qu'un
mouvement est en cours. La première moitié existait depuis le 2026-09-16 : le firmware suit `DTR`
et la suspension du bus, et coupe `MOE` dès que l'hôte disparaît. Restait le cas plus vicieux —
**l'hôte présent mais figé**. Le port reste ouvert, `DTR` reste haut, et plus personne ne peut
envoyer `STOP`.

Un module `safety.c` porte maintenant les deux, et devient le seul chemin qui met de la puissance
sur les sorties. Dès que les sorties sont actives, il exige un message tous les 250 ms — n'importe
lequel, trame binaire ou ligne ASCII, et même une trame au CRC cassé : ce qui est prouvé, c'est
qu'un hôte émet, pas qu'il émette juste. Passé le délai, le couple tombe et **la faute est
verrouillée** : `PWM ON` répond `ERR LATCHED` jusqu'à un `FAULTCLR` explicite, qui échoue lui-même
si la cause tient encore. La faute `nFAULT` du DRV passe par le même chemin, donc elle latche
aussi — avant, elle coupait sans laisser de trace.

Éprouvé sur la carte, les six cas d'affilée : état au repos, coupure après 250 ms de silence,
réactivation refusée, acquittement, réactivation, tenue pendant deux secondes sous flux entretenu,
puis arrêt demandé — qui ne latche pas, parce qu'un arrêt voulu n'est pas une faute.

Le délai est une limite, pas un réglage. Il deviendra un paramètre avec M3, avec un plafond dur :
élargir une limite pour faire passer un essai est interdit.

**La contrepartie est côté hôte, et elle est structurelle** : qui active les sorties doit
entretenir le flux. L'interface interroge `SAFETY?` toutes les 80 ms — un tiers du délai, deux
battements peuvent se perdre. Le même message entretient le flux *et* rapporte l'état de la
barrière, donc l'état affiché est toujours celui de l'instant où l'hôte a prouvé qu'il était
vivant ; deux commandes séparées ne pourraient pas le garantir. Si le processus principal se fige,
le minuteur s'arrête avec lui et la carte coupe : c'est exactement l'effet recherché.

Une coupure se voit dans la barre haute, avec sa cause et un bouton d'acquittement, et ne se
journalise qu'une fois. Un agent dispose de `safety_status` en lecture libre — refuser cette
lecture le pousserait à deviner — et de `safety_clear_fault`, qui exige « AI control » : lever un
verrou rouvre la possibilité de remettre du couple.

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

- **Schéma KiCad** — les affectations SPI2 sont électriquement impossibles (`AGENTS.md` §2). La
  carte a été retouchée à la main et fonctionne ; le schéma reste faux. **À corriger avant toute
  nouvelle fabrication**, sinon le défaut revient.
- **BOOT0 révision A** — `PB8/BOOT0` n'a pas de pull-down externe. La carte de bring-up a été
  provisionnée pour ignorer la broche et `make provision` rend l'opération reproductible. Ajouter
  un pull-down de 10 kΩ sur la prochaine révision matérielle.
- **La référence analogique oscille à 10,0 kHz, 717 mV crête à crête.** `VREF+` balaie
  1,70 → 2,43 V, donc **toutes** les tensions de la carte sont fausses dans la même
  proportion. **Cause trouvée (2026-09-21)** : C9 fait 100 nF directement sur la sortie du
  MCP1501, dont la charge capacitive maximale est de **300 pF** sans résistance série
  (datasheet §5.1.2). 333 fois la limite. Les rails, eux, sont sains — mesurés à ±1,8 %
  indépendamment de la référence. **À faire : soulever une patte de C9**, puis vérifier que
  l'oscillation cesse. Contournement en attendant : `VREF.BUF ON`.
- **Entrées de courant flottantes — cause trouvée (2026-09-21).** La broche `VREF` du DRV8304
  est l'**alimentation** des trois amplis de shunt, avec un seuil de sous-tension à **2,6 V**
  et un gain caractérisé seulement entre 3,3 et 5 V. La carte y met 2,048 V : les amplis ne
  sont jamais alimentés, et leurs sorties restent en haute impédance. `VREFUV` n'a aucun bit
  de statut, d'où le symptôme muet. `IMOT.DECAY` sur carte le confirme : les trois entrées
  décroissent comme `PA3`, broche sans liaison, avec τ ≈ 150 ms — et leur capacité de nœud
  (~8 pF contre ~4 pF) dit que **les pistes sont intactes**. Remplacer U3 n'avait rien changé
  parce que les deux composants se comportaient correctement. **À faire : isoler `U3`
  broche 24 et l'alimenter en +3,3 V.** **Bloque l'étape 4 et la suite.**

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

### La télémétrie persiste, le scope se navigue (2026-09-21)

Quatre défauts d'usage, et deux d'entre eux avaient la même cause de fond qu'on avait déjà
rencontrée deux fois : **une identité d'objet dans un tableau de dépendances React**.

**Le tracé semblait redémarrer tout seul.** Le snapshot du device traverse l'IPC d'Electron,
donc il est sérialisé : côté renderer, `state.telemetry` est un objet **neuf** à chaque
émission — au moins deux fois par seconde entre le battement de sécurité et le relevé de
supervision. Il figurait dans les dépendances de l'effet qui remet le tampon à zéro. Le tampon
était donc vidé en continu. Seule l'identité des signaux compte, et elle tient dans une chaîne.

**Arrêter le flux effaçait ce qu'on venait de capturer.** Or on coupe précisément pour regarder
ce qui vient de se passer. L'arrêt **fige** maintenant : les données restent tracées, la fenêtre
glissante est levée pour qu'on voie la fin de l'événement, et l'en-tête affiche `frozen` avec le
nombre de points. C'est le **démarrage** d'une souscription qui repart d'un relevé neuf.

**La fenêtre d'affichage ne pouvait pas dépasser le tampon.** Demander trente secondes avec un
tampon de quinze donnait une courbe tronquée sans rien pour l'expliquer. La capacité se calcule
désormais à partir de la fenêtre et de la cadence **réellement appliquée** par le firmware, avec
une marge et un plafond de mémoire. Les fenêtres vont jusqu'à une minute.

**Le zoom du scope se perdait à chaque rendu du parent.** `setData` remet les échelles à zéro, et
il était appelé à chaque rendu parce que `series` est reconstruit par l'appelant — le même piège
que pour `labels` et `colors`. Il n'est plus appelé que lorsque le tableau de temps change,
c'est-à-dire quand la capture change vraiment.

La navigation est maintenant celle d'un oscilloscope : **glissement = zoom par sélection** sur
l'axe des temps, molette = zoom autour du pointeur, `Shift`-glissement ou bouton du milieu =
déplacement, double-clic ou bouton **Reset zoom** = toute la capture. La sélection ne porte pas
sur l'axe vertical : sur une capture on zoome sur un intervalle de temps, et figer l'ordonnée
cacherait ce qui sort du cadre juste après.

### Les tailles se règlent à la main, et la télémétrie a des préréglages (2026-09-21)

Suite du même sujet. Découper la vue en deux régions ne suffisait pas : des constantes
choisies pour un écran ne conviennent à aucun autre, et affiner indéfiniment des nombres
n'est pas une réponse. **On rend la main.**

Un composant `Resizable` porte les deux axes : la largeur de la colonne de détail, et la
hauteur de chaque panneau, tracé compris. Trois règles :

- **on ne peut pas se coincer** — toute taille est bornée des deux côtés, et le plafond de la
  colonne latérale se calcule sur la largeur réelle de la fenêtre, donc élargir le détail ne
  peut jamais réduire l'instrument à rien ;
- **un réglage se retrouve** — chaque taille est mémorisée sous sa propre clef, parce que la
  reperdre à chaque lancement est ce qui fait qu'on cesse d'y toucher ;
- **le défaut reste atteignable** — un double-clic sur la poignée y revient.

La poignée est focalisable et les flèches la déplacent, `Shift` accélère. Ce n'est pas une
politesse : c'est la seule façon d'ajuster finement sur un banc où l'on n'a pas toujours les
deux mains libres.

La hauteur du tracé vaut `null` par défaut, c'est-à-dire « prends ce qui reste ». Tant que
personne n'a tiré la poignée, c'est mieux que n'importe quel nombre.

**Préréglages de télémétrie.** Seize signaux sont souscriptibles, mais en cocher seize donne
seize courbes illisibles et la palette n'a que huit teintes distinctes. Quatre préréglages :
`Diagnostic` (par défaut), `Currents`, `Position`, `Loop health`. La sélection à la connexion
était « les N premiers du dictionnaire » — un ordre qui n'a aucune raison d'être celui dans
lequel on veut regarder.

Un préréglage **ne décrit aucun signal** : il en nomme quelques-uns pour dire lesquels vont
bien ensemble, et `resolvePreset` les confronte au dictionnaire que la carte publie. La règle
« les signaux viennent du firmware » (`AGENTS.md` §3) tient donc toujours : un firmware
antérieur à l'étape 4 ne publie pas les courants centrés, et le préréglage en rend simplement
moins au lieu d'échouer. Une sélection modifiée à la main s'affiche `custom` — prétendre qu'un
préréglage est actif alors qu'on a décoché un signal ferait mentir l'affichage sur ce qui est
réellement souscrit.

**Une correction de fait au passage.** Le plafond de souscription est **16**, pas 8 :
`docs/protocol.md` §6 (`u8 count 0..16`) et `proto.c:261` (`count > 16U` → `ERR_ARG`) le
disent tous les deux. C'est le **scope** qui est limité à 4 signaux (`u8 signal_count 1..4`).

### Le tableau de bord n'avait pas de mise en page, seulement une grille (2026-09-21)

Trois corrections de taille successives — hauteurs de graphe, hauteur de console, échelles —
n'avaient traité que des symptômes. Le défaut était la composition elle-même, et l'utilisateur
l'a dit en une phrase : « il y a des panels inutilisables car noyés par la taille des autres ».

Tout vivait dans **une seule grille de quatre colonnes**, et trois conséquences en découlaient :

- les lignes d'une grille s'étirent sur le panneau le plus haut, donc `Current sense inputs`
  héritait de la hauteur de `Rails and protection` et se retrouvait avec une grande zone morte ;
- `Position sensor` occupait deux colonnes sur quatre et restait **seul sur sa ligne** : la
  moitié de la ligne perdue ;
- le tracé, c'est-à-dire la seule chose qu'on regarde vraiment en réglant, était **enterré au
  milieu d'un long défilement**, entre l'état et l'identification.

La vue est maintenant découpée en **deux régions qui se dimensionnent et défilent
indépendamment** :

| Région | Règle |
|---|---|
| Instrument, à gauche | Bande de quatre chiffres à hauteur fixe, puis le tracé qui prend **toute la hauteur restante** |
| Détail, à droite | Colonne de 23 rem qui défile pour elle-même : rails, courants, capteur, identité, capacités |

Le tracé n'a donc plus de hauteur magique en `vh` : ce qui reste, c'est ce qui reste. Et des
panneaux de hauteurs très différentes peuvent coexister dans la colonne de droite sans que le
plus court hérite du vide du plus haut — c'est exactement ce qu'une grille ne sait pas faire.

En dessous de `xl` il n'y a pas la largeur pour deux colonnes : on repasse en une seule, la page
défile, et le tracé reprend une hauteur relative à la fenêtre. La vue Scope suit la même règle,
la capture prenant ce qui reste sous le panneau de configuration.

**À vérifier à l'œil.** Cette reprise est faite depuis le code : je n'ai pas de moyen d'afficher
l'application Electron ni de la regarder. Les proportions — 23 rem pour la colonne de détail, le
point de bascule à `xl` — sont des choix raisonnés, pas mesurés.

### Le capteur de position à l'écran, et la console qui se souvient (2026-09-21)

Trois passes sur l'interface, pendant que la carte attend une intervention au fer.

**Le panneau capteur.** La carte publie depuis l'étape 6 l'angle, la vitesse, l'âge de
l'échantillon, l'état de l'aimant, la cadence du bus et un compteur d'erreurs — et l'interface
n'en montrait rien. `ENC?` rejoint le relevé de supervision, et le tableau de bord gagne un
cadran d'angle, l'état de la chaîne I²C et le pire âge d'échantillon. Ce dernier est celui que
la boucle de contrôle subit, donc celui qui plafonne la vitesse exploitable : il mérite d'être
lu sans ouvrir une console.

Un point de fond : **l'absence d'aimant reçoit une bannière, pas une pastille**. Sans aimant
diamétral en face du capteur, l'angle renvoyé est du bruit, et rien d'autre dans l'interface ne
le dirait. C'est un prérequis de M3 qu'on ne veut pas découvrir en lançant un asservissement de
position. Le message ne sort qu'une fois, à la bascule — comme celui de la référence instable,
et pour la même raison : un avertissement répété deux fois par seconde se confond avec le bruit
qu'il dénonce.

Le simulateur porte un aimant et un arbre qui tourne. L'état dégradé se force par
`setMagnet(false)`, **point d'accroche de test et non commande console** : le firmware n'a
aucune commande pour ça — un aimant est une pièce mécanique — et en inventer une côté PC aurait
créé exactement la divergence que `docs/protocol.md` existe pour empêcher.

**Le rappel des commandes.** Le jeu de commandes de diagnostic a plus que triplé pendant M2 et
vivait uniquement dans `docs/protocol.md` ; la liste de raccourcis de la console, elle, datait de
M1 et en proposait sept. Un catalogue s'affiche maintenant à côté du journal, cherchable dans le
verbe comme dans la description — au banc on se souvient plus souvent de ce qu'une commande fait
que de son nom. Un clic recopie la syntaxe dans le champ sans l'envoyer.

Cette liste est une copie, et une copie dérive. `consoleCommands.test.ts` la confronte donc au
tableau de `docs/protocol.md` **dans les deux sens** : rien de documenté ne manque à l'écran,
rien n'est proposé à l'écran que la spécification ignore. Le test a d'ailleurs attrapé son
propre défaut en chemin — les `\|` échappés dans une cellule de tableau coupaient la ligne au
mauvais endroit et faisaient disparaître `IMOT.WIGGLE` de l'extraction.

### La frontière IPC ne validait rien (2026-09-21)

Dernier écart de spécification encore ouvert côté interface, et le plus sérieux des trois
sujets du jour. Les handlers IPC déclaraient leurs types en TypeScript, qui **disparaissent à la
compilation**. À l'exécution, `handle('device:console', (line: string) => …)` acceptait un objet,
`undefined` ou n'importe quoi, et le passait à la couche qui tient le port série.

Ce n'était pas théorique :

- `device:setAiControl` gouverne le verrou qui autorise un agent à mettre un axe en mouvement
  (`AGENTS.md` §4.6). En JavaScript, la chaîne `'false'` est vraie : sans schéma, elle l'activait.
- `device:console` peut porter `PWM ON`, et une ligne contenant un `CR` en fait passer **deux**
  pour une, dont la seconde que personne n'a vue.
- `device:updateFirmware` prend un chemin de fichier et programme ce qu'il y trouve.

Un schéma `zod` par canal, dans une table, et `handle()` **refuse de servir un canal absent de
cette table** — l'erreur est levée au démarrage. On ne peut donc pas ajouter un canal en oubliant
sa validation : c'est ce qui fait la différence entre une barrière et une intention.

Le chemin du firmware demandait plus qu'un schéma, parce qu'un schéma peut dire « c'est une
chaîne » mais pas « c'est le bon fichier ». Seul un chemin sorti de la boîte de dialogue native
est désormais accepté : le seul dont l'utilisateur ait vu le nom.

Les bornes reprennent celles de `docs/protocol.md` plutôt que d'en inventer. Elles ne remplacent
aucune vérification du firmware — les limites vivent dans la carte (`AGENTS.md` §4.2) — et
n'évitent que d'envoyer du charabia.

### Le dashboard avait dérivé du mockup, et on sait quand (2026-09-20)

Remarque de l'utilisateur, juste : le tableau de bord n'affiche rien de ce que la carte mesure,
alors que le mockup d'origine (`interface/docs/mockup/mockup.html`) en avait fait son sujet.

Le mockup montrait huit cartes tournées vers *ce que la machine fait* : tension d'entrée, rail
moteur, température du MCU, charge de boucle — quatre gros chiffres avec leur trace — puis
« Rails & protection » et les compteurs de fautes. La vue livrée en montrait cinq, dont quatre
tournées vers *ce que la machine est* : identité, hash du dictionnaire, intégrité du transfert,
bits de capacité, constantes compilées. Des choses qu'on lit une fois.

La dérive a une date, et ce n'est pas un oubli de conception : cette vue a été écrite à M1,
quand le firmware ne savait dire que son identité et son dictionnaire. Le module `sensors` est
arrivé le 2026-09-18, et personne n'est revenu sur la vue. Les données existaient depuis deux
jours sans que rien ne les remonte.

Corrigé. `DeviceCore` relève `SENS.ALL?`, `STATS?` et `DRV?` toutes les 500 ms — cadence lente
assumée : ces grandeurs sont thermiques ou continues, les rafraîchir plus vite ne montrerait que
du bruit de conversion et volerait de la bande au battement de sécurité, qui tourne à 80 ms. La
vue retrouve les quatre gros chiffres avec leur trace, « Rails and protection » — où le watchdog
de flux et l'état des sorties ont maintenant leur ligne — et une carte pour les trois entrées de
courant. L'identification n'a pas disparu : elle tient en un panneau, en bas.

Deux règles d'affichage qui ne sont pas cosmétiques. **Une absence de mesure s'écrit `—`, jamais
zéro** : un rail à 0,00 V est une panne, et confondre les deux fait chercher un problème qui
n'existe pas. **Une trace plate se dessine plate** : sans étendue minimale, la normalisation
remplirait la hauteur avec du bruit d'arrondi et ferait passer un rail stable pour un rail agité.

Il manquait une mesure du mockup que le firmware ne produisait pas : la température de jonction.
Ajoutée au tourniquet de `sensors.c` — capteur interne sur ADC1 voie 16, étalonnage d'usine, et
le `VREF+` **mesuré** passé au calcul, sinon l'erreur de la référence ressortirait en degrés.

**Premier usage, premier enseignement.** Mise en service, la vue a immédiatement montré des rails
qui oscillent alors qu'ils sont parfaitement stables : toutes ces tensions sont ratiométriques de
`VREF+`, qui balaie de 43 %, donc chacune hérite de son agitation. Le défaut n'était pas dans la
vue, mais la vue avait tort de présenter ces chiffres comme fiables.

Deux réponses possibles, et une seule est honnête. Amortir l'affichage rendrait le tableau de bord
agréable et **masquerait un défaut matériel réel** — c'est exactement ce qu'il ne faut pas faire.
`DeviceCore` mesure donc l'étendue de `VREF+` sur les vingt-quatre derniers relevés : chacun tombe
à une phase quelconque de l'oscillation, donc l'étendue en mesure l'enveloppe. Au-delà de 2 %,
un bandeau dit que la référence n'en est plus une, que les rails eux-mêmes sont sains, et donne le
contournement — `VREF.BUF ON`. Le seuil est large à dessein : un avertissement qui se lève sur une
carte saine cesse d'être lu.

### La console noyée par l'interface elle-même (2026-09-20)

Le relevé de supervision ajouté le même jour journalisait ses réponses au niveau `info` :
**six lignes par seconde** de `SENS.ALL?`, `STATS?` et `DRV?`, plus le battement de sécurité.
Le journal ne montrait plus ce que l'opérateur avait demandé. Régression introduite à midi,
remarquée le soir.

Corrigé à la source d'abord : `askConsole` porte maintenant un drapeau « requête interne », et
les réponses aux interrogations que l'interface se fait à elle-même descendent en `debug`. La
sérialisation de la console rend ce drapeau exact — aucune autre réponse ne circule pendant
qu'une requête interne est en vol.

Puis des filtres, parce que ce trafic doit rester consultable sans être imposé : niveau,
source, et recherche dans le texte, retenus d'une session à l'autre. `debug` est éteint par
défaut, tout le reste allumé — un filtre par défaut qui cache un avertissement est pire que pas
de filtre, il donne la sensation d'un banc calme. Et **le nombre de lignes masquées est
toujours affiché**, cliquable pour tout remettre : un journal amputé en silence est un mensonge
par omission, et c'est précisément ce qu'on vient y chercher.

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

### À reprendre sur l'interface, demandé le 2026-09-21

Deux manques identifiés à l'usage, après la passe sur la fluidité et la mise en page. Ni
l'un ni l'autre n'est un défaut : ce sont des fonctions qui manquent.

**Naviguer dans la télémétrie figée comme dans une capture scope.** L'arrêt du flux fige
désormais les données au lieu de les effacer, ce qui était le prérequis. Mais une fois figé,
le tracé n'offre ni zoom par sélection, ni molette, ni déplacement — alors que le scope les a
depuis la même passe. C'est la même situation : des données qui ne bougent plus, et trop de
points pour la largeur de l'écran. Le commentaire de `navPlugin` explique pourquoi la
navigation était refusée sur un flux — une courbe qui défile décroche sous la sélection —
**et cette raison tombe dès que le flux est arrêté**. Il suffit donc de passer `interactive`
quand `streaming` est faux, plus un bouton de remise à la vue complète, comme sur le scope.

**Exporter la télémétrie en CSV.** Le scope le fait déjà (`scopeExport.ts` : colonne de temps
relative au déclenchement, une colonne par signal, unité dans l'en-tête, aucune ligne de
commentaire pour ne pas obliger les outils qui relisent à savoir la sauter). Le flux figé a la
même forme de données et mérite le même export — et probablement le même module, quitte à le
généraliser plutôt qu'à en écrire un second qui divergera.

Ordre logique : la navigation d'abord, puisqu'elle ne coûte qu'un branchement de ce qui
existe ; l'export ensuite, qui demande de décider si `scopeExport` se généralise ou se
duplique. Il se généralise.

### Écarts connus avec la spécification

Relevés lors d'une revue, assumés pour l'instant, à traiter :

| Écart | Spécification | Décision |
|---|---|---|
| — | — | Aucun écart ouvert. Le dernier, `zod` partiel, est réglé le 2026-09-21 : voir « La frontière IPC ne validait rien » plus bas. Les futurs fichiers `.a2nrcp` devront l'être aussi |

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
| **Le tampon de télémétrie était effacé deux fois par seconde.** Le snapshot traverse l'IPC d'Electron, donc il est **sérialisé** : côté renderer, `state.telemetry` est un objet neuf à chaque émission. Le mettre dans les dépendances de l'effet de remise à zéro vidait le tampon en continu, et la courbe semblait redémarrer toute seule. Même classe de défaut que `labels`/`colors` sur le graphe, et pour la même raison : une identité d'objet dans un tableau de dépendances. | « la vue du graphe reset toutes les secondes environ, comme si la mesure redémarrait » |
| **Le zoom du scope se perdait au moindre rendu du parent.** `setData` remet les échelles à zéro, et il était rappelé à chaque rendu parce que `series` est reconstruit par l'appelant. Aucun geste de l'utilisateur ne l'expliquait. | « je ne peux pas pan ou zoom sans que ça reset la position d'affichage » |
| **Hauteurs de graphe et de console figées en pixels.** 120 px par graphe au-delà de deux courbes, 18 rem de console, quelle que soit la fenêtre : sur un portable ça débordait, en plein écran ça laissait la moitié de la surface vide — et dans les deux cas le panneau se mettait à défiler, ce qui se voit comme des données tronquées. Les graphes se partagent désormais la hauteur mesurée du panneau, entre un plancher de lisibilité et un plafond au-delà duquel l'étirement n'apprend rien ; la console a une poignée de redimensionnement. | Signalé à l'œil par l'utilisateur — « des fois en plein écran, il y a plein de données qui sont tronquées » |
| **Le flux de télémétrie déclenchait un rendu React par lot de trames.** `interface/AGENTS.md` §3 l'interdit explicitement — « uPlot est mis à jour par `requestAnimationFrame`, pas par échantillon reçu » — et `useTelemetry` appelait pourtant `bump()` trente fois par seconde, désynchronisé de l'affichage. La règle était écrite, l'implémentation avait dérivé. | L'utilisateur a persisté après la première correction : « le live telemetry a toujours un peu de saccade » |
| **Le graphe temps réel était détruit et reconstruit trente fois par seconde.** `Chart.tsx` dit dans son propre en-tête qu'il ne faut surtout pas reconstruire uPlot à chaque rendu, « sans quoi la courbe clignote ». Son tableau de dépendances le faisait quand même : `labels` et `colors` sont des tableaux que l'appelant rebâtit à chaque rendu (`indices.map(…)`), donc React voyait une identité neuve, nettoyait l'effet, appelait `destroy()` et recréait le canvas. L'intention était juste et écrite ; c'est la liste de dépendances qui la contredisait. Corrigé en comparant le **contenu** des deux tableaux et en les lisant par référence. | Signalé à l'œil par l'utilisateur — « il y a du flickering sur le live telemetry et le scope » |
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
| **Deux commandes console simultanées échangeaient leurs réponses** — `DeviceClient.console()` se résout sur la *prochaine* ligne reçue, sans regarder laquelle. Inoffensif tant qu'une seule main tapait des commandes ; le battement de sécurité, à huit interrogations par seconde, rend la collision certaine. `DeviceCore` sérialise désormais tout accès à la console | Trouvé en branchant le battement, avant qu'il ne morde, 2026-09-20. Deux tests le couvrent |
| **La faute `nFAULT` du DRV coupait sans rien verrouiller** — `Pwm_Disable()` direct depuis l'interruption, donc une reprise silencieuse restait possible alors que §4.5 l'interdit | Vu en écrivant `safety.c`, 2026-09-20. Passe maintenant par `Safety_Cut(SAFETY_DRV_FAULT)` |
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
