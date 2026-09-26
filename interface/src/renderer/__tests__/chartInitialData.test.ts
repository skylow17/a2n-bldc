/**
 * Données avec lesquelles un graphe est créé.
 *
 * Le défaut du 2026-09-26 : la première capture scope ne s'affichait jamais. Le graphe
 * naissait vide, puis se recréait quand `ChartStack` mesurait sa place — et la capture,
 * inchangée, n'y revenait pas. La règle testée ici est donc simple et ne doit pas céder :
 * **un graphe statique naît avec sa capture**, quelle que soit la raison de sa création.
 */

import { describe, expect, it } from 'vitest';

import { initialPlotData } from '../components/Chart.js';

describe('données initiales d un graphe', () => {
  const t = [0, 0.05, 0.1];
  const a = [1, 2, 3];
  const b = [4, 5, 6];

  it('crée un graphe statique avec sa capture, et non vide', () => {
    expect(initialPlotData(t, [a, b], 2, false)).toEqual([t, a, b]);
  });

  it('garde l identité du tableau de temps, qui sert de garde contre les recalages', () => {
    // L'effet de données compare l'identité de `t` pour ne pas remettre le zoom à zéro :
    // une copie ici le ferait réinjecter la même capture au rendu suivant.
    expect(initialPlotData(t, [a], 1, false)[0]).toBe(t);
  });

  it('laisse un flux naître vide : il repeint lui-même à chaque trame', () => {
    expect(initialPlotData(t, [a, b], 2, true)).toEqual([[], [], []]);
  });

  it('reste vide tant qu aucune capture n existe', () => {
    expect(initialPlotData([], [], 2, false)).toEqual([[], [], []]);
  });

  it('aligne exactement une série par libellé', () => {
    // uPlot suppose l'alignement : une série manquante devient vide, et une série en trop
    // n'est pas tracée plutôt que de décaler les autres.
    expect(initialPlotData(t, [a], 2, false)).toEqual([t, a, []]);
    expect(initialPlotData(t, [a, b], 1, false)).toEqual([t, a]);
  });
});
