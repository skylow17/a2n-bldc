/**
 * Filtres de la console.
 *
 * Testés à part de la vue parce que ce sont eux qui décident ce qu'un opérateur voit ou ne
 * voit pas. Une erreur masquée par un réglage par défaut, ou un filtre restauré de travers
 * depuis le stockage local, ne se rattrape pas à l'œil : rien ne le signale.
 */

import { describe, expect, it } from 'vitest';

import type { LogEntry } from '../../main/device/DeviceCore.js';
import {
  DEFAULT_FILTER,
  LEVELS,
  SOURCES,
  applyFilter,
  showsEverything,
  toggle,
} from '../consoleFilter.js';

let seq = 0;
function entry(level: LogEntry['level'], source: LogEntry['source'], text: string): LogEntry {
  return { id: ++seq, at: 0, level, source, text };
}

const SAMPLE: LogEntry[] = [
  entry('debug', 'gui', '> SAFETY?'),
  entry('debug', 'device', 'OK reason=ok latched=0 outputs=0'),
  entry('info', 'gui', '> PWM ON'),
  entry('info', 'device', 'OK'),
  entry('warn', 'device', 'analog reference unstable'),
  entry('error', 'device', 'torque cut by the firmware: cmd_timeout'),
  entry('info', 'mcp', 'param_set lim.i_max_a = 4'),
];

describe('filtres de la console', () => {
  it('masque le trafic automatique par défaut, et rien d autre', () => {
    const out = applyFilter(SAMPLE, DEFAULT_FILTER);
    // Les deux lignes `debug` sont le battement et le relevé : c'est ce bruit-là qu'on
    // vient éteindre. Tout le reste passe.
    expect(out).toHaveLength(5);
    expect(out.every((e) => e.level !== 'debug')).toBe(true);
  });

  it('ne masque jamais un avertissement ni une erreur par défaut', () => {
    // Un filtre par défaut qui cache une faute est pire que pas de filtre : il donne la
    // sensation d'un banc calme.
    const out = applyFilter(SAMPLE, DEFAULT_FILTER);
    expect(out.some((e) => e.level === 'warn')).toBe(true);
    expect(out.some((e) => e.text.includes('torque cut'))).toBe(true);
  });

  it('filtre par source', () => {
    const out = applyFilter(SAMPLE, { ...DEFAULT_FILTER, sources: ['mcp'] });
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain('param_set');
  });

  it('cherche dans le texte sans tenir compte de la casse', () => {
    const out = applyFilter(SAMPLE, { ...DEFAULT_FILTER, match: 'TORQUE' });
    expect(out).toHaveLength(1);
    expect(out[0]!.level).toBe('error');
  });

  it('combine les trois critères', () => {
    const out = applyFilter(SAMPLE, { levels: ['debug'], sources: ['device'], match: 'reason' });
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe('device');
  });

  it('rend une liste vide plutôt que tout, quand rien n est coché', () => {
    // Une liste vide veut dire « rien », pas « pas de filtre ». La vue affiche alors un
    // état explicite ; traiter le vide comme « tout » serait une surprise silencieuse.
    expect(applyFilter(SAMPLE, { levels: [], sources: [...SOURCES], match: '' })).toHaveLength(0);
  });

  it('ne déclare « tout visible » que lorsque rien n est masqué', () => {
    expect(showsEverything(DEFAULT_FILTER)).toBe(false);
    expect(showsEverything({ levels: [...LEVELS], sources: [...SOURCES], match: '' })).toBe(true);
    expect(showsEverything({ levels: [...LEVELS], sources: [...SOURCES], match: 'x' })).toBe(false);
  });

  it('bascule une valeur sans toucher aux autres', () => {
    expect(toggle(['a', 'b'], 'b')).toEqual(['a']);
    expect(toggle(['a'], 'b')).toEqual(['a', 'b']);
  });
});
