# M0 — validation du squelette temps réel

Étape bloquante. Aucune ligne de régulateur ne s'écrit tant que ce document n'est pas coché.

C'est la marche que le firmware v1 avait sautée : il n'avait ni ISR de contrôle, ni
échantillonnage synchrone, et sa boucle FOC n'était même pas appelée. On la reprend d'abord.

---

## Ce que fait le firmware à ce stade

`make && make flash`, puis au reset :

1. HSE 24 MHz → PLL → 144 MHz système, 48 MHz USB, 72 MHz pour l'ADC.
2. TIM1 démarre en comptage centré à 20 kHz, **MOE à zéro** : les six sorties restent en
   haute impédance, aucun transistor n'est piloté.
3. CH4 produit TRGO 138 ns avant le sommet du comptage.
4. Chaque TRGO déclenche une séquence injectée de 3 voies sur l'ADC1 (courants de phase).
5. La fin de séquence lève `ADC1_2_IRQHandler`, qui appelle `Ctrl_Isr()`.
6. `Ctrl_Isr()` lève `PC14`, lit les trois courants, mesure sa durée au compteur de cycles,
   puis rabaisse `PC14`.
7. La boucle principale est vide (`__WFI()`).

**L'étage de puissance n'est jamais activé pendant M0.** La carte peut donc rester alimentée
en basse tension, moteur débranché.

---

## Constantes attendues

Vérifiées par `_Static_assert` dans `pwm.c` et recalculées depuis `board.h` :

| Grandeur | Valeur |
|---|---|
| ARR | 3599 |
| Fréquence PWM | 20 000 Hz exactement |
| Période | 50,0 µs |
| CCR4 (déclenchement ADC) | 3579, soit 138 ns avant le sommet |
| Temps mort (DTG = 72) | 500 ns |
| Zéro courant (VREF/2) | 1024 mV |
| Budget total de l'ISR | 7200 cycles à 144 MHz |

---

## Mesure

**Où sonder.** `TP1`/`TP2` (`PB8`/`PB9`) sont marqués « ne pas poser » sur le schéma : il n'y a
pas de point de test garanti. On utilise donc **`IO1` = `PC14`, sorti sur J7 broche 5** à
travers R23 1 kΩ. Masse sur J7 broche 3.

| J7 | Signal |
|---|---|
| 1 | +5 V |
| 2 | +3,3 V |
| 3 | GND |
| 4 | IO2 — `PC15` |
| 5 | **IO1 — `PC14`, sortie d'instrumentation** |

### Critères d'acceptation

| # | Mesure | Attendu | Pourquoi |
|---|---|---|---|
| 1 | Période entre deux fronts montants | **50,0 µs**, soit 20,000 kHz | La boucle est bien cadencée par le matériel, pas par du logiciel |
| 2 | Gigue crête à crête sur la période | **< 200 ns** | Une gigue visible signale une interruption concurrente ou un chemin bloquant |
| 3 | Largeur de l'impulsion haute | **< 10 µs**, typiquement 1 à 2 µs à ce stade | Budget d'ISR : au-delà de 10 µs il ne reste plus de marge pour la FOC |
| 4 | Impulsion manquante sur 1 minute | **aucune** | Une trame perdue = un cycle de contrôle perdu |

La mesure 3 est aussi lisible sans oscilloscope : `Ctrl_GetStats()` expose `cycles_last` et
`cycles_max` en cycles à 144 MHz. 1440 cycles = 10 µs. Tant que la console n'existe pas
(étape M1), on les lit au debugger.

### Ce qui invalide l'étape

- Période autre que 50 µs → vérifier l'arbre d'horloge, pas TIM1 : un HSE mal démarré fait
  basculer le système sur HSI à 16 MHz sans rien signaler.
- Gigue importante → chercher une autre interruption active, ou un `HAL_Delay` oublié.
- Aucun front → l'ADC ne déclenche pas. Vérifier dans cet ordre : `TIM1->CR2` (MMS = OC4REF),
  `TIM1->CCR4`, `ADC1->JSQR` (JEXTSEL/JEXTEN), `ADC1->IER` (JEOSIE), puis le NVIC.

---

## À vérifier au passage

Trois points relevés à la lecture du schéma, qu'on mesure pendant qu'on est sur la carte.

**`PC13` porte `PWM1N`.** C'est une broche du domaine sauvegardé : drive et vitesse de sortie
plafonnés, contrairement aux cinq autres sorties PWM. Comparer le temps de montée de `PC13`
à celui de `PB0` (`PWM2N`). Une asymétrie importante déséquilibrerait le temps mort effectif
de la phase A. À mesurer avant la première mise en puissance.

**Le SPI vers le DRV8304 — résolu.** Le schéma étiquette `PB13 = SPI2_MOSI` et
`PB15 = SPI2_SCK`, ce qui est électriquement impossible sur ce boîtier. La carte a été
retouchée, liaisons refaites directement sur le PCB, et le SPI matériel fonctionne avec le
brochage du v1 (`PB13` = SCK, `PB14` = MISO, `PB15` = MOSI). Rien à vérifier ici, et pas de
pilote bit-bang à prévoir. En revanche **le schéma doit être corrigé avant toute nouvelle
fabrication**, sans quoi la prochaine carte aura le même défaut.

**Les pull-ups I2C.** `R21`/`R22` valent 4,7 kΩ et sont annotés « TBC » sur le schéma. À
1 MHz (Fast-mode Plus, nécessaire pour l'AS5600 en M2), le temps de montée vaut environ
100 ns pour 25 pF de capacité de bus — juste sous la limite de 120 ns. Confirmer qu'elles
sont bien posées, et mesurer le front réel de SCL à l'étape M2 avant de conclure.

---

## Ensuite

M1 — observabilité : codec binaire, dictionnaire de paramètres, télémétrie, buffer scope,
et la CLI Node côté PC. C'est seulement après M1 qu'on touche à la chaîne capteur puis aux
asservissements.
