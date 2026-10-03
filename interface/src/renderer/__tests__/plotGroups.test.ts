import { describe, expect, it } from 'vitest';

import { plotGroups } from '../plotGroups.js';

const names = ['foc.iq_a', 'foc.iq_ref_a', 'enc.vel_rad_s', 'foc.id_a'];
const units = ['A', 'A', 'rad/s', 'A'];

describe('graphes d une mesure', () => {
  it('regroupe par unité, en gardant les indices de la mesure', () => {
    expect(plotGroups(names, units, new Set(), false)).toEqual([
      { key: 'A', unit: 'A', indices: [0, 1, 3] },
      { key: 'rad/s', unit: 'rad/s', indices: [2] },
    ]);
  });

  it('retire les courbes masquées, et le graphe qui n en a plus', () => {
    expect(plotGroups(names, units, new Set(['enc.vel_rad_s', 'foc.iq_ref_a']), false)).toEqual([
      { key: 'A', unit: 'A', indices: [0, 3] },
    ]);
  });

  it('sépare : un graphe par courbe visible', () => {
    const g = plotGroups(names, units, new Set(['foc.id_a']), true);
    expect(g.map((x) => x.indices)).toEqual([[0], [1], [2]]);
    expect(new Set(g.map((x) => x.key)).size).toBe(3);
  });

  it('rien de visible, rien à tracer', () => {
    expect(plotGroups(names, units, new Set(names), false)).toEqual([]);
  });
});
