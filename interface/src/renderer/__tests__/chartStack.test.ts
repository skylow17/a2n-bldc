/**
 * Partage de la hauteur entre graphes empiles.
 *
 * Les hauteurs etaient des constantes en pixels : 120 px par graphe au-dela de deux
 * courbes, quelle que soit la fenetre. Sur un portable ca debordait, en plein ecran ca
 * laissait la moitie de la surface vide — et dans les deux cas le panneau se mettait a
 * defiler, ce qui se voit comme des donnees tronquees.
 *
 * La regle a deux bornes qui tirent en sens inverse, donc elle se teste.
 */

import { describe, expect, it } from 'vitest';

import { CHART_MAX_H, CHART_MIN_H, chartHeight } from '../components/ChartStack.js';

describe('hauteur d un graphe empile', () => {
  it('partage la hauteur disponible entre les graphes', () => {
    expect(chartHeight(600, 2)).toBe(300);
    expect(chartHeight(600, 3)).toBe(200);
  });

  it('tient compte des espaces entre graphes', () => {
    // Sans ca, la somme des hauteurs depasse le conteneur d'exactement la somme des
    // espaces, et le dernier graphe se retrouve a moitie sous le bord.
    expect(chartHeight(600, 3, 10)).toBe(Math.floor((600 - 20) / 3));
  });

  it('ne descend pas sous le plancher de lisibilite', () => {
    // Une bande illisible qui tient dans le cadre est pire qu une courbe lisible qu il
    // faut faire defiler : on assume le debordement.
    expect(chartHeight(300, 12)).toBe(CHART_MIN_H);
    expect(chartHeight(10, 1)).toBe(CHART_MIN_H);
  });

  it('ne depasse pas le plafond', () => {
    // Une seule courbe etiree sur un ecran entier n apprend rien de plus.
    expect(chartHeight(4000, 1)).toBe(CHART_MAX_H);
  });

  it('rend le plancher tant que le conteneur n est pas mesure', () => {
    // Un graphe de hauteur nulle ne se remet pas a jour tout seul quand la mesure arrive.
    expect(chartHeight(0, 2)).toBe(CHART_MIN_H);
    expect(chartHeight(Number.NaN, 2)).toBe(CHART_MIN_H);
    expect(chartHeight(-50, 2)).toBe(CHART_MIN_H);
  });

  it('reste defini quand il n y a aucun graphe', () => {
    expect(chartHeight(600, 0)).toBe(CHART_MIN_H);
  });

  it('grandit avec la fenetre, entre les deux bornes', () => {
    const small = chartHeight(400, 2);
    const large = chartHeight(800, 2);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThanOrEqual(CHART_MAX_H);
  });
});
