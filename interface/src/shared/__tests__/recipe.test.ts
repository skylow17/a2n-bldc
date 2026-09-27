/**
 * Recettes : lecture, capture, diff. Le dictionnaire de test reprend les formes réelles —
 * un paramètre calibré, un réglage de boucle, une lecture seule, un entier.
 */

import { describe, expect, it } from 'vitest';

import { PARAM_FLAG, ParamType } from '../params.js';
import {
  BUILTIN_PROFILES,
  captureRecipe,
  defaultSelection,
  diffRecipe,
  formatDictHash,
  parseRecipe,
  recipeFileName,
  serializeRecipe,
  type DeviceParamView,
} from '../recipe.js';

const CAL = PARAM_FLAG.PERSISTENT | PARAM_FLAG.REQUIRES_DISARM | PARAM_FLAG.CALIBRATED;

const PARAMS: DeviceParamView[] = [
  { name: 'board.vref_mv', unit: 'mV', type: ParamType.U16, flags: PARAM_FLAG.READ_ONLY, min: 0, max: 65535, value: 3300 },
  { name: 'motor.pole_pairs', unit: '', type: ParamType.U8, flags: CAL, min: 0, max: 64, value: 7 },
  { name: 'motor.l_h', unit: 'H', type: ParamType.F32, flags: CAL, min: 0, max: 0.1, value: Math.fround(0.0011) },
  { name: 'ctrl.speed.bw_hz', unit: 'Hz', type: ParamType.F32, flags: PARAM_FLAG.PERSISTENT, min: 1, max: 40, value: 30 },
  { name: 'ctrl.pos.bw_hz', unit: 'Hz', type: ParamType.F32, flags: PARAM_FLAG.PERSISTENT, min: 0.5, max: 5, value: 3 },
];

const DEVICE = { fwVersion: '2.0.0-m3', paramDictHash: 0xc2d9f36a };

describe('recettes', () => {
  it('capture les valeurs inscriptibles seulement, avec le hash du dictionnaire', () => {
    const r = captureRecipe('bench', DEVICE, PARAMS, new Date('2026-09-27T10:00:00Z'));
    expect(r.param_dict_hash).toBe('c2d9f36a');
    expect(r.fw_version).toBe('2.0.0-m3');
    expect(Object.keys(r.params).sort()).toEqual(['ctrl.pos.bw_hz', 'ctrl.speed.bw_hz', 'motor.l_h', 'motor.pole_pairs']);
    expect(r.params['board.vref_mv']).toBeUndefined();
  });

  it('relit ce qu elle a écrit', () => {
    const r = captureRecipe('bench', DEVICE, PARAMS);
    const back = parseRecipe(serializeRecipe(r));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.recipe).toEqual(r);
  });

  it('refuse un fichier qui n est pas une recette, en disant où', () => {
    expect(parseRecipe('{').ok).toBe(false);
    const bad = parseRecipe(JSON.stringify({ schema: 1, name: 'x', created: '', params: { a: 'fast' } }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('params.a');
    expect(parseRecipe(JSON.stringify({ schema: 2, name: 'x', created: '', params: {} })).ok).toBe(false);
    const hash = parseRecipe(JSON.stringify({ schema: 1, name: 'x', created: '', param_dict_hash: 'nothex!!', params: {} }));
    expect(hash.ok).toBe(false);
  });

  it('classe chaque entrée, et n en ignore aucune', () => {
    const d = diffRecipe(
      {
        schema: 1,
        name: 'x',
        created: '',
        param_dict_hash: 'C2D9F36A',
        params: {
          'ctrl.speed.bw_hz': 20,
          'ctrl.pos.bw_hz': 3,
          'motor.l_h': 0.0011,
          'motor.pole_pairs': 7.2,
          'board.vref_mv': 3000,
          'pid.vel.kp': 1,
        },
      },
      PARAMS,
      DEVICE.paramDictHash,
    );
    const st = Object.fromEntries(d.rows.map((r) => [r.name, r.status]));
    expect(st).toEqual({
      'board.vref_mv': 'read_only',
      'motor.pole_pairs': 'same',   // entier : 7,2 s'arrondit à 7
      'motor.l_h': 'same',          // f32 : 0,0011 relu n'est pas une différence
      'ctrl.speed.bw_hz': 'change',
      'ctrl.pos.bw_hz': 'same',
      'pid.vel.kp': 'unknown',
    });
    expect(d.hashMatch).toBe(true);
    expect(d.rows.at(-1)!.name).toBe('pid.vel.kp');
  });

  it('refuse une valeur hors des bornes du device plutôt que de la rogner', () => {
    const d = diffRecipe({ schema: 1, name: 'x', created: '', params: { 'ctrl.speed.bw_hz': 80 } }, PARAMS, 1);
    expect(d.rows[0]!.status).toBe('out_of_range');
    expect(d.hashMatch).toBeNull();
  });

  it('signale un dictionnaire différent', () => {
    const d = diffRecipe({ schema: 1, name: 'x', created: '', param_dict_hash: '00000001', params: {} }, PARAMS, 2);
    expect(d.hashMatch).toBe(false);
  });

  it('ne coche pas une valeur calibrée par défaut', () => {
    const d = diffRecipe(
      { schema: 1, name: 'x', created: '', params: { 'motor.l_h': 0.002, 'ctrl.speed.bw_hz': 20 } },
      PARAMS,
      null,
    );
    expect([...defaultSelection(d)]).toEqual(['ctrl.speed.bw_hz']);
    expect(d.rows.find((r) => r.name === 'motor.l_h')!.calibrated).toBe(true);
  });

  it('a des profils partiels, qui passent la validation', () => {
    for (const p of BUILTIN_PROFILES) {
      expect(parseRecipe(serializeRecipe(p)).ok).toBe(true);
      expect(p.param_dict_hash).toBeUndefined();
      // Cascade tenable : vitesse au moins quatre fois plus rapide que la position.
      expect(p.params['ctrl.speed.bw_hz']!).toBeGreaterThanOrEqual(4 * p.params['ctrl.pos.bw_hz']!);
    }
  });

  it('formate le hash et propose un nom de fichier sûr', () => {
    expect(formatDictHash(0xa)).toBe('0000000a');
    expect(recipeFileName(' Gimbal 2208 / 14pp ')).toBe('Gimbal-2208-14pp.a2nrcp');
    expect(recipeFileName('///')).toBe('recipe.a2nrcp');
  });
});
