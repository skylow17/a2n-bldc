import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, mergeConfig, parseConfig, serializeConfig } from '../config.js';

describe('fichier de configuration', () => {
  it('relit exactement ce qu il a écrit', () => {
    const { config, warnings } = parseConfig(serializeConfig(DEFAULT_CONFIG));
    expect(warnings).toEqual([]);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('donne les défauts sur un JSON illisible, et le dit', () => {
    const { config, warnings } = parseConfig('{ not json');
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings[0]).toMatch(/not valid JSON/);
  });

  it('garde les champs valides quand un seul est faux', () => {
    const { config, warnings } = parseConfig(
      JSON.stringify({ ui: { theme: 'light', zoom: 9 }, scope: { depth: 1024, decimation: 3 } }),
    );
    expect(config.ui.theme).toBe('light');
    expect(config.ui.zoom).toBe(DEFAULT_CONFIG.ui.zoom);
    expect(config.scope.depth).toBe(1024);
    expect(config.scope.decimation).toBe(DEFAULT_CONFIG.scope.decimation);
    expect(warnings.some((w) => w.startsWith('ui.zoom'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('scope.decimation'))).toBe(true);
  });

  it('signale les clés inconnues au lieu de les taire', () => {
    const { warnings } = parseConfig(JSON.stringify({ foo: 1, ui: { bar: 2 } }));
    expect(warnings).toContain('unknown section "foo" ignored');
    expect(warnings).toContain('ui.bar: unknown, ignored');
  });

  it('écarte une couleur de trace fausse sans perdre les autres', () => {
    const { config, warnings } = parseConfig(
      JSON.stringify({ plots: { traceColors: { 'foc.iq_a': '#aabbcc', 'foc.id_a': 'red' } } }),
    );
    expect(config.plots.traceColors).toEqual({ 'foc.iq_a': '#aabbcc' });
    expect(warnings.some((w) => w.includes('foc.id_a'))).toBe(true);
  });

  it('valide un patch comme un fichier', () => {
    const ok = mergeConfig(DEFAULT_CONFIG, { mcp: { port: 5000 } });
    expect(ok.config.mcp).toEqual({ enabled: true, port: 5000 });
    const bad = mergeConfig(DEFAULT_CONFIG, { mcp: { port: 80 } });
    expect(bad.config.mcp.port).toBe(DEFAULT_CONFIG.mcp.port);
    expect(bad.warnings.length).toBe(1);
  });

  it('remplace la table des couleurs, pour qu on puisse en retirer une', () => {
    const a = mergeConfig(DEFAULT_CONFIG, { plots: { traceColors: { x: '#000000', y: '#ffffff' } } }).config;
    const b = mergeConfig(a, { plots: { traceColors: { y: '#ffffff' } } }).config;
    expect(b.plots.traceColors).toEqual({ y: '#ffffff' });
  });

  it('ne modifie jamais les défauts partagés', () => {
    mergeConfig(DEFAULT_CONFIG, { ui: { theme: 'light' } });
    expect(DEFAULT_CONFIG.ui.theme).toBe('dark');
  });
});
