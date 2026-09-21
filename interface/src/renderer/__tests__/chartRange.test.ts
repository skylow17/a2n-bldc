/**
 * Hystérésis de l'échelle verticale des graphes.
 *
 * Testée à part parce que c'est la seule logique de `Chart.tsx` qui ne soit pas du canvas,
 * et parce que ses deux règles tirent dans des sens opposés : garder l'échelle pour que
 * l'axe ne remue pas, la reprendre pour qu'un transitoire n'écrase pas la suite. Un
 * déséquilibre entre les deux ne se voit pas dans un test de rendu — il se voit à l'œil,
 * des semaines plus tard, sous la forme d'une courbe qui respire ou d'une courbe plate.
 */

import { describe, expect, it } from 'vitest';

import { nextYRange } from '../components/Chart.js';

describe('échelle verticale d un graphe', () => {
  it('adopte l étendue des données au premier tracé', () => {
    const [lo, hi] = nextYRange(null, 0, 100);
    // Une marge, pour que la courbe ne touche pas les bords du cadre.
    expect(lo).toBeLessThan(0);
    expect(hi).toBeGreaterThan(100);
  });

  it('ne bouge pas tant que les données tiennent dedans', () => {
    // C'est le cœur du sujet : sur un signal bruité, le minimum et le maximum changent à
    // chaque lot de trames. Si l'échelle les suivait, toute la courbe respirerait trente
    // fois par seconde — et ce qu'on verrait bouger serait l'axe, pas la mesure.
    const first = nextYRange(null, 0, 100);
    const second = nextYRange(first, 1, 99);
    const third = nextYRange(second, 2, 98);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('se rouvre dès que les données sortent', () => {
    const first = nextYRange(null, 0, 100);
    const wider = nextYRange(first, 0, 500);
    expect(wider[1]).toBeGreaterThan(first[1]);
    const lower = nextYRange(wider, -500, 100);
    expect(lower[0]).toBeLessThan(wider[0]);
  });

  it('se resserre quand les données n occupent plus qu une petite part', () => {
    // Sans cette règle, un pic isolé fixerait l'échelle pour toujours et tout le tracé
    // suivant s'écraserait sur une ligne.
    const afterSpike = nextYRange(null, 0, 1000);
    const calm = nextYRange(afterSpike, 10, 20);
    expect(calm[1] - calm[0]).toBeLessThan((afterSpike[1] - afterSpike[0]) / 10);
  });

  it('trace une série plate à plat', () => {
    // Étendue nulle : sans plancher, la division par zéro fait sauter la courbe d'un bord
    // à l'autre au moindre bit de bruit.
    const r = nextYRange(null, 5, 5);
    expect(r[1]).toBeGreaterThan(r[0]);
    expect(Number.isFinite(r[0]) && Number.isFinite(r[1])).toBe(true);
    // Et à zéro, où la marge relative ne peut pas venir de la valeur elle-même.
    const z = nextYRange(null, 0, 0);
    expect(z[1]).toBeGreaterThan(z[0]);
  });

  it('garde l échelle précédente quand il n y a rien à tracer', () => {
    // Entre deux captures scope, ou au démarrage d'un flux, uPlot demande une étendue sans
    // donnée. Rendre l'étendue par défaut ferait clignoter l'axe à chaque trou.
    const r = nextYRange([-1, 1], null, null);
    expect(r).toEqual([-1, 1]);
    expect(nextYRange(null, null, null)).toEqual([0, 1]);
    expect(nextYRange([-1, 1], Number.NaN, 10)).toEqual([-1, 1]);
  });
});
