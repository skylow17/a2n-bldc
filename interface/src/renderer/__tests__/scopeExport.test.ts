/**
 * Export CSV d'une capture.
 *
 * Le format est un contrat avec des outils qu'on ne contrôle pas — tableur, pandas, gnuplot.
 * Une virgule de trop ou une notation exponentielle inattendue ne se voit pas à la relecture
 * et casse la lecture ailleurs.
 */

import { describe, expect, it } from 'vitest';

import { captureFileName, captureToCsv } from '../scopeExport.js';

describe('captureToCsv', () => {
  it('écrit une colonne de temps puis une colonne par signal, unité comprise', () => {
    const csv = captureToCsv({
      t: [-0.05, 0, 0.05],
      series: [
        [2048, 2050, 2052],
        [0.6, 0.61, 0.6],
      ],
      names: ['current.raw_ia_count', 'loop.load_pct'],
      units: ['count', '%'],
    });

    expect(csv.split('\n')[0]).toBe('time_ms,current.raw_ia_count (count),loop.load_pct (%)');
    expect(csv.split('\n')[1]).toBe('-0.05,2048,0.6');
    expect(csv.split('\n')[3]).toBe('0.05,2052,0.6');
    // Un fichier texte se termine par une fin de ligne.
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('omet la parenthèse quand le signal est sans dimension', () => {
    const csv = captureToCsv({ t: [0], series: [[1]], names: ['x'], units: [''] });
    expect(csv.split('\n')[0]).toBe('time_ms,x');
  });

  it('coupe le bruit de représentation du f32', () => {
    const csv = captureToCsv({
      t: [0],
      series: [[2053.6499999999996]],
      names: ['x'],
      units: [''],
    });
    expect(csv.split('\n')[1]).toBe('0,2053.65');
  });

  it('rend une cellule vide plutôt qu’un NaN textuel', () => {
    // « NaN » se lit comme du texte dans un tableur et contamine la colonne entière.
    const csv = captureToCsv({ t: [0, 1], series: [[1, NaN]], names: ['x'], units: [''] });
    expect(csv.split('\n')[2]).toBe('1,');
  });

  it('évite la notation exponentielle sur les très petites valeurs', () => {
    // Beaucoup d'outils lisent « 1e-7 » comme une chaîne. Un courant en ampères après
    // calibration passera par ces ordres de grandeur.
    const csv = captureToCsv({ t: [0], series: [[0.0000001]], names: ['i'], units: ['A'] });
    const cell = csv.split('\n')[1]?.split(',')[1] ?? '';
    expect(cell).not.toMatch(/e/i);
    expect(Number(cell)).toBeCloseTo(0.0000001, 12);
  });

  it('accepte une capture vide sans produire de ligne fantôme', () => {
    const csv = captureToCsv({ t: [], series: [], names: [], units: [] });
    expect(csv).toBe('time_ms\n');
  });
});

describe('captureFileName', () => {
  it('porte horodatage et nombre de points', () => {
    // Deux captures d'une même session doivent se distinguer : un nom constant conduit à
    // écraser la précédente sans s'en rendre compte.
    const name = captureFileName(2048, new Date(2026, 8, 16, 14, 5, 9));
    expect(name).toBe('a2n-scope-20260916-140509-2048pts.csv');
  });
});
