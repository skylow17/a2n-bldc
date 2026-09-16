/**
 * Réduction des captures — la partie du serveur MCP qui décide ce qu'un agent voit.
 *
 * Elle est testée à part parce que c'est là que se joue une erreur silencieuse : une
 * décimation qui perd la fin d'une courbe rend une capture qui a l'air correcte et qui ment
 * sur la valeur établie.
 */

import { describe, expect, it } from 'vitest';

import { column, decimateSeries, round6, summarizeSeries } from '../summarize.js';

describe('round6', () => {
  it('coupe le bruit de représentation du f32 sans toucher à la valeur', () => {
    expect(round6(2053.6499999999996)).toBe(2053.65);
    expect(round6(0)).toBe(0);
    expect(round6(-1.23456789)).toBe(-1.23457);
    expect(round6(1e-9)).toBe(1e-9);
  });

  it('laisse passer les valeurs non finies plutôt que de les maquiller', () => {
    expect(round6(NaN)).toBeNaN();
    expect(round6(Infinity)).toBe(Infinity);
  });
});

describe('summarizeSeries', () => {
  it('rend bornes, moyenne et dernière valeur', () => {
    const s = summarizeSeries('loop.load_pct', '%', [1, 5, 3]);
    expect(s).toEqual({ name: 'loop.load_pct', unit: '%', min: 1, max: 5, mean: 3, last: 3 });
  });

  it('ne prétend rien sur une série vide', () => {
    const s = summarizeSeries('x', '', []);
    expect(s.min).toBeNaN();
    expect(s.mean).toBeNaN();
  });
});

describe('decimateSeries', () => {
  it('rend la série telle quelle quand elle tient déjà', () => {
    expect(decimateSeries([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it('conserve le premier et le dernier point', () => {
    const values = Array.from({ length: 1000 }, (_, i) => i);
    const out = decimateSeries(values, 16);

    expect(out).toHaveLength(16);
    // La valeur établie d'une réponse indicielle est le dernier point : la perdre rendrait
    // la capture inutile pour ce à quoi elle sert.
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(999);
  });

  it('progresse de façon monotone sur une série monotone', () => {
    const values = Array.from({ length: 513 }, (_, i) => i * 2);
    const out = decimateSeries(values, 64);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!).toBeGreaterThan(out[i - 1]!);
    }
  });

  it('dégrade proprement sous deux points demandés', () => {
    expect(decimateSeries([1, 2, 3], 1)).toEqual([3]);
    expect(decimateSeries([], 1)).toEqual([]);
  });
});

describe('column', () => {
  it('extrait une colonne d\'une capture rangée par point', () => {
    const samples = [
      [1, 10, 100],
      [2, 20, 200],
      [3, 30, 300],
    ];
    expect(column(samples, 0)).toEqual([1, 2, 3]);
    expect(column(samples, 2)).toEqual([100, 200, 300]);
    expect(column(samples, 5)).toEqual([]);
  });
});
