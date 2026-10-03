import { describe, expect, it } from 'vitest';

import {
  EMPTY_TREE,
  createFolder,
  deleteFolder,
  defaultTitle,
  filterMeta,
  folderPath,
  measurementFileStem,
  measurementToCsv,
  measurementsIn,
  metaOf,
  moveFolder,
  moveMeasurements,
  normalizeTree,
  parseMeasurement,
  serializeMeasurement,
  sortMeta,
  type Measurement,
} from '../measurement.js';

const m = (over: Partial<Measurement> = {}): Measurement => ({
  schema: 1,
  id: 'abcdef12-0000',
  kind: 'scope',
  createdAt: '2026-10-03T12:34:56.000Z',
  title: 'Step Iq',
  comment: '',
  tags: [],
  device: { fwVersion: '2.0.0', dictHash: '0xC2D9F36A' },
  params: { 'ctrl.speed.bw_hz': 30 },
  config: { depth: 3 },
  signals: [
    { name: 'foc.iq_a', unit: 'A' },
    { name: 'foc.iq_ref_a', unit: 'A' },
  ],
  t: [-0.05, 0, 0.05],
  series: [
    [0, 0.5, Number.NaN],
    [0, 1, 1],
  ],
  markerX: 0,
  ...over,
});

describe('mesures', () => {
  it('relit ce qu elle écrit, trous de mesure compris', () => {
    const r = parseMeasurement(JSON.parse(serializeMeasurement(m())));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.m.series[0]![2]).toBeNaN();
      expect(r.m.t).toEqual([-0.05, 0, 0.05]);
    }
  });

  it('refuse des séries qui ne collent pas aux signaux ou au temps', () => {
    expect(parseMeasurement(m({ series: [[0, 1, 2]] })).ok).toBe(false);
    expect(parseMeasurement(m({ series: [[0], [0]] })).ok).toBe(false);
    expect(parseMeasurement({ ...m(), createdAt: 'yesterday' }).ok).toBe(false);
    expect(parseMeasurement({ ...m(), id: '../../etc' }).ok).toBe(false);
  });

  it('écrit un CSV avec son en-tête commenté', () => {
    const csv = measurementToCsv(m({ comment: 'line 1\nline 2' }));
    const lines = csv.trimEnd().split('\n');
    expect(lines).toContain('# title: Step Iq');
    expect(lines).toContain('# comment: line 1');
    expect(lines).toContain('# comment: line 2');
    expect(lines).toContain('time_ms,foc.iq_a (A),foc.iq_ref_a (A)');
    expect(lines[lines.length - 1]).toBe('0.05,,1');
  });

  it('résume une mesure pour la liste', () => {
    const meta = metaOf(m());
    expect(meta.points).toBe(3);
    expect(meta.durationMs).toBeCloseTo(0.1);
    expect(meta.signals).toEqual(['foc.iq_a', 'foc.iq_ref_a']);
  });

  it('donne un titre et un nom de fichier lisibles', () => {
    expect(defaultTitle('scope', ['foc.iq_a', 'foc.iq_ref_a'], new Date(2026, 9, 3, 9, 5, 7))).toBe(
      'Scope iq_a, iq_ref_a — 09:05:07',
    );
    expect(measurementFileStem({ ...m(), title: 'Step: Iq / 1 A?' })).toMatch(/^a2n-scope-\d{8}-\d{6}-Step-Iq-1-A$/);
  });

  it('trie et filtre', () => {
    const a = metaOf(m({ id: 'aaaaaaaa-1', title: 'B', createdAt: '2026-10-01T00:00:00Z' }));
    const b = metaOf(m({ id: 'aaaaaaaa-2', title: 'A', createdAt: '2026-10-02T00:00:00Z', comment: 'stiff profile' }));
    expect(sortMeta([a, b], 'createdAt', true).map((x) => x.title)).toEqual(['A', 'B']);
    expect(sortMeta([a, b], 'title', false).map((x) => x.title)).toEqual(['A', 'B']);
    expect(filterMeta([a, b], 'STIFF').map((x) => x.title)).toEqual(['A']);
    expect(filterMeta([a, b], 'iq_ref').length).toBe(2);
  });
});

describe('arbre de mesures', () => {
  const t0 = createFolder(createFolder(EMPTY_TREE, 'Tests', null, 'f1'), 'Load', 'f1', 'f2');

  it('range et retrouve, sous-dossiers compris', () => {
    const t = moveMeasurements(t0, ['m1'], 'f2');
    expect(measurementsIn(t, 'f1', ['m1', 'm2'])).toEqual(['m1']);
    expect(measurementsIn(t, null, ['m1', 'm2'])).toEqual(['m1', 'm2']);
    expect(folderPath(t, 'f2')).toEqual(['Tests', 'Load']);
    expect(moveMeasurements(t, ['m1'], null).placement).toEqual({});
  });

  it('refuse de mettre un dossier dans son propre descendant', () => {
    expect(moveFolder(t0, 'f1', 'f2')).toBe(t0);
    expect(moveFolder(t0, 'f1', 'f1')).toBe(t0);
    expect(moveFolder(t0, 'f2', null).folders.find((f) => f.id === 'f2')!.parent).toBeNull();
  });

  it('ne supprime aucune mesure avec un dossier : tout remonte d un cran', () => {
    const t = moveMeasurements(t0, ['m1'], 'f1');
    const d = deleteFolder(t, 'f1');
    expect(d.folders.map((f) => f.id)).toEqual(['f2']);
    expect(d.folders[0]!.parent).toBeNull();
    expect(d.placement).toEqual({});
    const t2 = moveMeasurements(t0, ['m2'], 'f2');
    expect(deleteFolder(t2, 'f2').placement).toEqual({ m2: 'f1' });
  });

  it('remet d aplomb un fichier d arbre abîmé', () => {
    const fixed = normalizeTree(
      {
        version: 1,
        folders: [
          { id: 'a', name: 'A', parent: 'b' },
          { id: 'b', name: 'B', parent: 'a' },
          { id: 'c', name: 'C', parent: 'ghost' },
        ],
        placement: { m1: 'a', m2: 'nowhere', m3: 'c' },
      },
      new Set(['m1', 'm2']),
    );
    // Plus de boucle : au moins un des deux remonte à la racine.
    expect(fixed.folders.some((f) => f.parent === null && (f.id === 'a' || f.id === 'b'))).toBe(true);
    expect(fixed.folders.find((f) => f.id === 'c')!.parent).toBeNull();
    expect(fixed.placement).toEqual({ m1: 'a' });
    expect(normalizeTree('garbage')).toEqual(EMPTY_TREE);
  });
});
