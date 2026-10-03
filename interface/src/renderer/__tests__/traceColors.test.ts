import { describe, expect, it } from 'vitest';

import { assignTraceStyles, isColorSpec, referenceOf, semanticSlot } from '../traceColors.js';

describe('couleurs de traces', () => {
  it('donne aux trois phases trois teintes fixes, brutes comme corrigées', () => {
    expect(semanticSlot('current.ia_count')).toBe(1);
    expect(semanticSlot('current.raw_ia_count')).toBe(1);
    expect(semanticSlot('current.ib_count')).toBe(2);
    expect(semanticSlot('current.ic_count')).toBe(3);
  });

  it('apparie une consigne à sa mesure', () => {
    expect(referenceOf('foc.iq_ref_a')).toBe('foc.iq_a');
    expect(referenceOf('foc.w_ref_rad_s')).toBe('enc.vel_rad_s');
    expect(referenceOf('foc.iq_a')).toBeNull();
    expect(semanticSlot('foc.iq_ref_a')).toBe(semanticSlot('foc.iq_a'));
    expect(semanticSlot('foc.w_ref_rad_s')).toBe(semanticSlot('enc.vel_rad_s'));
  });

  it('ne prend pas « valid » pour Id', () => {
    expect(semanticSlot('enc.valid')).toBeNull();
    expect(semanticSlot('foc.valid')).toBeNull();
  });

  it('trace la consigne de la même teinte, en pointillé', () => {
    const s = assignTraceStyles(['foc.iq_a', 'foc.iq_ref_a', 'foc.id_a'], ['A', 'A', 'A']);
    expect(s[0]).toEqual({ color: 'slot:4', dash: false });
    expect(s[1]).toEqual({ color: 'slot:4', dash: true });
    expect(s[2]!.color).not.toBe('slot:4');
  });

  it('ne met jamais deux grandeurs de même couleur dans un graphe', () => {
    // Brut et corrigé de la phase A ont le même créneau sémantique et la même unité.
    const s = assignTraceStyles(
      ['current.raw_ia_count', 'current.ia_count', 'current.ib_count', 'current.ic_count'],
      ['count', 'count', 'count', 'count'],
    );
    expect(new Set(s.map((x) => x.color)).size).toBe(4);
  });

  it('autorise la même teinte dans deux graphes différents', () => {
    const s = assignTraceStyles(['loop.duration_ns', 'loop.load_pct'], ['ns', '%']);
    expect(s[0]!.color).toBe(s[1]!.color);
  });

  it('range un signal inconnu dans une teinte libre, sans voler celle d une phase', () => {
    const s = assignTraceStyles(['mystery.x', 'current.ia_count'], ['count', 'count']);
    expect(s[1]!.color).toBe('slot:1');
    expect(s[0]!.color).not.toBe('slot:1');
  });

  it('fait passer la couleur imposée avant tout, et la transmet à la consigne', () => {
    const s = assignTraceStyles(['foc.iq_a', 'foc.iq_ref_a'], ['A', 'A'], { 'foc.iq_a': '#112233' });
    expect(s[0]!.color).toBe('#112233');
    expect(s[1]).toEqual({ color: '#112233', dash: true });
  });

  it('jamais de gris : douze signaux inconnus, douze teintes', () => {
    const names = Array.from({ length: 12 }, (_, i) => `x.s${i}`);
    const s = assignTraceStyles(names, names.map(() => 'u'));
    expect(new Set(s.map((x) => x.color)).size).toBe(12);
  });

  it('reconnaît les couleurs acceptables', () => {
    expect(isColorSpec('#a1b2c3')).toBe(true);
    expect(isColorSpec('slot:12')).toBe(true);
    expect(isColorSpec('slot:13')).toBe(false);
    expect(isColorSpec('red')).toBe(false);
  });
});
