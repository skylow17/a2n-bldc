# Révision B du PCB — ce que la carte rev A a appris

Liste de travail pour la prochaine itération matérielle, tirée du bring-up de la rev A
(2026-09-16 → 2026-09-26). Chaque point dit **ce qui a été constaté**, **pourquoi**, et **quoi
changer**. Les constats et leurs mesures détaillées vivent dans `STATUS.md` ; le brochage réel
et les écarts du schéma dans `AGENTS.md` §2. Rien ici n'est une hypothèse non signalée : quand un
point est une recommandation sans mesure derrière, il est marqué *(recommandation)*.

Ordre : d'abord ce qui **doit** changer sous peine de refaire les mêmes retouches, ensuite ce qui
améliore la mesure et la commande, enfin le confort de bring-up.

---

## A. Obligatoire — erreurs de conception de la rev A

### A1. Affectations SPI2 impossibles dans le schéma

- **Constat.** Le schéma met `PB13 = SPI2_MOSI` et `PB15 = SPI2_SCK`. En AF5 sur l'UFQFPN48,
  `PB13` ne peut être que SCK et `PB15` que MOSI. La carte a été retouchée : pistes coupées,
  liaisons refaites par fil. Le fil `SCLK`, soudé du mauvais côté de la coupure, a coûté une
  panne complète du SPI (2026-09-21 → 26).
- **Changer.** Corriger le schéma **et** le routage : `PB13 → SCLK` (DRV `U3` broche 28),
  `PB15 → SDI` (broche 27), `PB14 ← SDO` (broche 26), `PB12 → nSCS` (broche 29). Vérifier chaque
  affectation d'AF dans le `.ioc` avant de router — c'est le `.ioc` qui fait foi pour le brochage.

### A2. `VREF` du DRV8304 alimenté à 2,048 V

- **Constat.** La broche 24 (`VREF`) du DRV8304 n'est pas une référence : c'est
  **l'alimentation des trois amplificateurs de shunt**, seuil de sous-tension 2,6 V, gain
  caractérisé de 3,3 à 5 V. À 2,048 V (`U5`, MCP1501-20), les amplis n'ont jamais fonctionné :
  trois entrées de courant muettes, sans aucun bit de statut. Retouché le 2026-09-21 : `U5`
  déposé, pastilles 1 et 6 pontées, `VREF` = 3,3 V, partagé avec `VDDA`/`VREF+`.
- **Changer — deux options, à trancher :**
  - **Option 1, la plus simple** : `U5` en **MCP1501-30 (3,0 V)**. Au-dessus du seuil de 2,6 V,
    sous `VDDA` avec 0,3 V de marge ; repos des `SOx` à 1,5 V, milieu exact de l'échelle ADC ;
    mesure **ratiométrique** (même référence pour les amplis et l'ADC). Réserve : 3,0 V est sous
    la plage où TI caractérise le gain.
  - **Option 2, la plus précise** : `VREF` du DRV sur le **+5 V** (milieu de la plage
    caractérisée), un diviseur ≈ 0,41 sur chaque `SOx` (six résistances), et l'ADC sur sa propre
    référence. La mesure n'est plus ratiométrique ; le 5 V est déjà mesuré (`ADC2_IN3`), donc
    l'erreur se corrige en logiciel.
  - La configuration actuelle (tout sur 3,3 V) **fonctionne** et est celle que le firmware
    suppose (`board.vref_mv` = 3300) ; la garder est une option légitime si l'on accepte un
    `VREF+` égal au rail numérique.

### A3. Condensateur de sortie du MCP1501 hors spécification

- **Constat.** `C9` (100 nF) directement sur la sortie du MCP1501, dont la charge capacitive
  maximale sans résistance série est de **300 pF** (datasheet §5.1.2) : oscillation à 10 kHz,
  717 mV crête à crête, sur toute la référence analogique. Toutes les tensions de la carte
  étaient fausses dans la même proportion.
- **Changer.** Résistance d'isolement **47–100 Ω** entre la sortie de la référence et son
  condensateur ; condensateur **contre la broche `VREF+`** du MCU, pas à l'autre bout de la carte.

### A4. `PB8/BOOT0` sans pull-down

- **Constat.** Une carte non provisionnée peut démarrer dans la ROM système. Contourné par les
  octets d'option (`make provision` : `nSWBOOT0=0`, `nBOOT0=1`).
- **Changer.** **10 kΩ vers GND** sur `PB8`. Garder `make provision` pour les cartes rev A.

---

## B. Mesure du courant — ce qui limite aujourd'hui la commande

### B1. Échelle et résolution du courant inadaptées au moteur visé

- **Constat.** Shunts 10 mΩ (`R19`/`R20`/`R25`), gain 20 V/V : pleine échelle nominale ≈ ±8 A,
  soit ≈ 4 mA par count. Le moteur du banc (gimbal, R ≈ 3,6 Ω, L ≈ 1,1 mH, 7 paires de pôles)
  travaille entre 0,05 et 0,3 A : **quelques dizaines de counts utiles**, bruit ±15 mA. Toute la
  boucle de courant se joue dans le bas de l'échelle, là où les défauts B2 et B3 dominent.
- **Changer** *(recommandation)*. Dimensionner shunt × gain sur le courant **réel** du moteur
  cible, avec la limite de surintensité vers 70–80 % de la pleine échelle. Pour ce moteur :
  shunts 50–100 mΩ, ou gain 40 V/V (registre `CSA_GAIN` du DRV8304). Si la carte doit servir
  plusieurs moteurs, garder 10 mΩ mais prévoir le gain réglable — il l'est déjà par SPI.

### B2. Les trois voies lisent trop haut, et pas pareil

- **Constat.** Échelle absolue mesurée à l'ampèremètre : **≈ 1,82 mA par count**, contre 4,03 mA
  nominaux (20 V/V sur 10 mΩ) — les trois voies sur-lisent. Et elles diffèrent entre elles :
  B lit 0,656 fois A, C lit 1,195 fois A (corrigé en logiciel, gains par voie à la voie C).
  Cause la plus probable : **résistance parasite dans le chemin de mesure** — le shunt n'est pas
  pris en Kelvin, et la piste ou la soudure s'ajoute aux 10 mΩ, différemment par phase.
- **Changer.** **Prise de mesure Kelvin** (4 fils) sur chaque shunt : deux pistes de mesure
  dédiées partant des pastilles mêmes du shunt, routées en paire jusqu'aux entrées `SPx`/`SNx`
  du DRV, **symétriques entre les trois phases**. Shunts à 4 bornes si l'encombrement le permet.

### B3. Zone morte des amplis autour de la mi-échelle

- **Constat.** Chaque voie reste **collée exactement à 2048 counts** sur une plage de ≈ 30 mA
  autour du zéro, sans le moindre bruit ; juste au-dessus, entre ≈ 10 et 50 mA, un **coude** où
  la voie lit environ la moitié du vrai courant. L'auto-calibration du DRV n'y change rien : c'est
  l'étage de sortie des amplis autour de leur référence. Contourné en logiciel par la loi des
  nœuds (une voie dans sa zone morte est reconstruite des deux autres), mais le coude ne se
  contourne pas. Il ralentit la montée de la boucle de courant aux faibles courants.
- **Changer** *(recommandation)*. B1 réduit l'importance du défaut, puisqu'on travaille alors
  loin du zéro en counts. Si ce n'est pas suffisant, des amplificateurs de shunt externes
  (INA240 ou équivalent, à rejet de mode commun PWM) remplacent ceux du DRV.

### B4. `nFAULT` n'arrive pas sur une entrée de coupure matérielle

- **Constat.** `DRV_nFAULT` est sur `PB11`, qui n'offre pas de `TIM1_BKIN`. La coupure du pont
  sur faute driver passe par une interruption EXTI puis le logiciel. Ce chemin n'a **jamais été
  éprouvé physiquement** (décision du 2026-09-26).
- **Changer.** Router `nFAULT` sur une broche **`TIM1_BKIN`** (ou `BKIN2`) du G473 — vérifier dans
  la datasheet les broches disponibles sur l'UFQFPN48 — pour que le timer coupe les sorties en
  matériel, sans dépendre du logiciel. Garder aussi une entrée EXTI pour lire la cause.

---

## C. Commande et capteurs

### C1. `PWM1N` sur `PC13`

- **Constat.** `PC13` est dans le domaine sauvegardé : drive et vitesse plafonnés par rapport aux
  cinq autres sorties PWM. Asymétrie de front **non mesurée** (pas d'oscilloscope disponible).
- **Changer — seulement si la mesure le justifie.** Les autres broches `TIM1_CH1N` du G473
  (`PA7`, `PA11`, `PB13`, à vérifier dans la datasheet) sont toutes prises sur la rev A —
  mesure du 3V3, USB, horloge SPI. Déplacer `CH1N` impose donc de repenser le brochage autour.
  Mesurer d'abord l'asymétrie des fronts à l'oscilloscope ; si elle reste petite devant le temps
  mort de 500 ns, garder `PC13`.

### C2. Capteur de position : latence et bruit de vitesse

- **Constat.** AS5600 en I²C à 1 MHz, DMA : un échantillon toutes les ≈ 59 µs, âge vu par l'ISR
  jusqu'à ≈ 0,1–0,7 ms. La vitesse estimée bruite de ±0,4 rad/s rotor arrêté, et c'est ce bruit
  qui borne l'ondulation de la boucle de vitesse (±0,6 à 0,8 rad/s). Les bits `STATUS` du
  capteur déclarent l'aimant trop faible alors que `MAGNITUDE` (≈ 1 700) le montre exploitable.
  Non-linéarité relevée à l'étape 8 : 5,2° électriques en écart quadratique, 10,9° au pire.
- **Changer** *(recommandation)*. Un codeur magnétique **SPI** à faible latence et sortie ABI —
  AS5047P, MA732, MT6835 — sur un SPI libre, avec son ABI sur `TIM3` (déjà câblé sur `PB4`/`PA4`
  pour l'incrémental). Aimant diamétral du bon diamètre, entrefer selon la datasheet, et un
  **plan de fixation mécanique** capteur/aimant (le centrage a été fait à la main).
- Les pull-ups I²C `R21`/`R22` (4k7, annotés « TBC ») sont à la limite pour 1 MHz : 2k2 si l'on
  garde l'I²C.

### C3. Tension de bus et limite de tension

- **Constat.** La limite de tension de la commande (57 ‰ du rail, soit ≈ 0,85 V à 15 V) vient
  de la limite d'écart entre bras de la PWM d'essai, pas du matériel. Elle suffit pour ce moteur
  à l'arrêt, pas pour la vitesse : sous Iq, la force contre-électromotrice prend toute la marge
  vers 27 rad/s. C'est une limite **logicielle**, à relever quand le banc sera validé en charge.
- **Rien à changer au matériel** pour ce point ; le noter pour dimensionner la tension de bus du
  moteur cible.

---

## D. Bring-up et instrumentation

- **D1. Points de test.** `TP1`/`TP2` (`PB8`/`PB9`) sont « ne pas poser ». Ajouter des points de
  test **accessibles** sur : les trois `SOx`, `VREF`, `VREF+`, `SCLK`/`SDI`/`SDO`/`nSCS`, `nFAULT`,
  les six grilles ou au moins un demi-pont, et une masse à côté de chacun. Toute la panne SPI
  s'est diagnostiquée sans oscilloscope faute d'accès.
- **D2. LED d'état** pilotée par le MCU *(recommandation)* : aujourd'hui une carte figée ne se
  voit qu'à l'USB.
- **D3. Sonde différentielle ou points de mesure de phase** *(recommandation)* : mesurer une phase
  demande une sonde différentielle que le banc n'a pas.
- **D4. `IO1` (`PC14`)** sert de broche d'instrumentation (durée d'ISR) sur `J7` broche 5 : à
  garder, idéalement doublée d'un point de test.
- **D5. SWD** par Tag-Connect TC2050 (`J4`) : à garder ; prévoir un emplacement non encombré.
- **D6. Réinitialisation** *(recommandation)* : un bouton `NRST` accessible.

---

## E. Ce qui a été éprouvé et peut rester tel quel

- Étage de puissance : `NVMFD024N06` doubles canal N 60 V, trois bras complémentaires à 20 kHz,
  temps mort 500 ns vérifié à l'oscilloscope aux deux fronts, aucune conduction croisée.
- DRV8304 **S** (variante SPI) une fois A1 et A2 corrigés : registres, `CSA_GAIN`, `SPI_CAL`,
  auto-calibration fonctionnent.
- Mesures de rails (Vin, Vmot, 5 V, 3V3) : saines à ±1,8 % ; le firmware mesure `VREF+` via
  `VREFINT`, ce qui rend les diviseurs actuels valables quelle que soit l'option retenue en A2.
- USB CDC, mise à jour A/B par le bootloader, NVM : rien à changer côté matériel.
- `J3` (CAN, encodeur incrémental) et `J7` (IO, alimentations) : non exercés, à garder.

---

## F. À faire côté schéma, quelle que soit la révision

- Mettre le schéma en accord avec le `.ioc` (A1) **avant** de router.
- Reporter dans le schéma les valeurs réellement montées (`U5` déposé, pont 1–6).
- Annoter les broches `SOx` avec leur point de repos attendu selon l'option A2 choisie.
- Garder `docs/Schematics.pdf` à jour à chaque révision ; `AGENTS.md` §2 renvoie à lui.
