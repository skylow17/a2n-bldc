/**
 * Dictionnaire de paramètres : sérialisation, hash de forme, et reconstitution d'une réponse
 * `PARAM_DICT_ENTRY` telle que le firmware l'émet.
 */

import { describe, expect, it } from 'vitest';

import vectors from '../../../../docs/protocol-vectors.json' with { type: 'json' };
import { PayloadReader } from '../frame.js';
import {
  decodeParamDictEntry,
  decodeParamRead,
  decodeParamWrite,
  encodeParamDictGet,
  encodeParamRead,
  encodeParamWrite,
  ParamStatus,
} from '../messages.js';
import {
  ParamDictionary,
  PARAM_ENTRY_WIRE_LEN,
  PARAM_FLAG,
  clampToParam,
  isReadOnly,
  paramDictHash,
  readParamEntry,
  writeParamEntry,
  type ParamDesc,
  type ParamTypeValue,
} from '../params.js';

const dict = vectors.param_dict;

const expected: ParamDesc[] = dict.entries.map((e) => ({
  id: e.id,
  type: e.type as ParamTypeValue,
  flags: e.flags,
  name: e.name,
  unit: e.unit,
  group: e.group,
  min: e.min,
  max: e.max,
  def: e.def,
}));

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'));

describe('sérialisation des entrées', () => {
  it('une entrée occupe exactement 80 octets', () => {
    expect(PARAM_ENTRY_WIRE_LEN).toBe(dict.entry_wire_len);
  });

  it.each(dict.entries)('$name — octets identiques à la référence', (e) => {
    const desc = expected.find((p) => p.id === e.id)!;
    expect(Buffer.from(writeParamEntry(desc)).toString('hex')).toBe(e.wire_hex);
  });

  it.each(dict.entries)('$name — relecture fidèle', (e) => {
    const got = readParamEntry(new PayloadReader(hex(e.wire_hex)));
    expect(got).toEqual({
      id: e.id,
      type: e.type,
      flags: e.flags,
      name: e.name,
      unit: e.unit,
      group: e.group,
      min: e.min,
      max: e.max,
      def: e.def,
    });
  });
});

describe('hash de forme', () => {
  it('correspond à la valeur calculée indépendamment', () => {
    expect(paramDictHash(expected)).toBe(dict.hash);
  });

  it("change dès qu'une borne change", () => {
    // Attention au piège : `max + 1` sur 200 000 000 ne changerait rien, le pas du float32
    // y valant 16. Le hash porte sur les octets sérialisés, donc sur la valeur f32 réelle —
    // une modification invisible en f32 est, à juste titre, invisible pour le hash.
    const altered = expected.map((p, i) => (i === 0 ? { ...p, max: p.max * 2 } : p));
    expect(paramDictHash(altered)).not.toBe(dict.hash);
  });

  it("change dès qu'un nom, une unité ou un drapeau change", () => {
    for (const patch of [{ name: 'board.sysclk' }, { unit: 'kHz' }, { flags: 0 }] as const) {
      const altered = expected.map((p, i) => (i === 0 ? { ...p, ...patch } : p));
      expect(paramDictHash(altered), `patch ${JSON.stringify(patch)}`).not.toBe(dict.hash);
    }
  });

  it("ignore une différence que le f32 ne peut pas représenter", () => {
    // Le pendant du cas ci-dessus, énoncé explicitement : deux firmwares dont les bornes
    // ne diffèrent que sous la résolution du f32 exposent bien la même forme.
    const altered = expected.map((p, i) => (i === 0 ? { ...p, max: p.max + 1 } : p));
    expect(paramDictHash(altered)).toBe(dict.hash);
  });

  it("change si l'ordre change — une recette dépend de la position", () => {
    const swapped = [expected[1]!, expected[0]!, ...expected.slice(2)];
    expect(paramDictHash(swapped)).not.toBe(dict.hash);
  });
});

describe('page de dictionnaire', () => {
  it('reconstitue une réponse PARAM_DICT_ENTRY', () => {
    // On fabrique la réponse exactement comme le firmware : en-tête de pagination puis
    // les entrées brutes issues de la référence.
    const count = 6;
    const payload = new Uint8Array(6 + count * PARAM_ENTRY_WIRE_LEN);
    const view = new DataView(payload.buffer);
    view.setUint16(0, 0, true);
    view.setUint16(2, expected.length, true);
    view.setUint16(4, count, true);
    for (let i = 0; i < count; i++) {
      payload.set(hex(dict.entries[i]!.wire_hex), 6 + i * PARAM_ENTRY_WIRE_LEN);
    }

    const page = decodeParamDictEntry(payload);
    expect(page.startIndex).toBe(0);
    expect(page.total).toBe(expected.length);
    expect(page.entries).toHaveLength(count);
    expect(page.entries[0]!.name).toBe('board.sysclk_hz');
  });

  it('refuse une page dont le compte ne colle pas aux octets', () => {
    const payload = new Uint8Array(6 + PARAM_ENTRY_WIRE_LEN);
    new DataView(payload.buffer).setUint16(4, 3, true); // 3 annoncées, 1 présente
    expect(() => decodeParamDictEntry(payload)).toThrow(RangeError);
  });
});

describe('ParamDictionary', () => {
  const d = new ParamDictionary(expected, dict.hash);

  it('retrouve une entrée par identifiant et par nom', () => {
    expect(d.get(0x0010)?.name).toBe('pwm.freq_hz');
    expect(d.get('pwm.freq_hz')?.id).toBe(0x0010);
    expect(d.get('inexistant')).toBeUndefined();
  });

  it("rend les groupes dans l'ordre d'apparition", () => {
    expect(d.groups()).toEqual(['Board', 'PWM', 'Motor', 'Debug']);
  });

  it('marque en lecture seule ce que le firmware protège', () => {
    expect(isReadOnly(d.get('pwm.arr')!)).toBe(true);
    expect(isReadOnly(d.get('dbg.echo_f32')!)).toBe(false);
    expect(d.get('pwm.arr')!.flags & PARAM_FLAG.READ_ONLY).toBeTruthy();
  });
});

describe('contrainte au domaine', () => {
  const f32 = expected.find((p) => p.name === 'dbg.echo_f32')!;
  const i16 = expected.find((p) => p.name === 'dbg.echo_i16')!;
  const bool = expected.find((p) => p.name === 'dbg.echo_bool')!;

  it('borne aux min/max déclarés', () => {
    expect(clampToParam(f32, 5000)).toBe(1000);
    expect(clampToParam(f32, -5000)).toBe(-1000);
    expect(clampToParam(f32, 1.25)).toBe(1.25);
  });

  it('arrondit les entiers au plus proche, comme le firmware', () => {
    expect(clampToParam(i16, 2.9999997)).toBe(3);
    expect(clampToParam(i16, -2.5)).toBe(-2); // Math.round : -2.5 -> -2
  });

  it('ramène les booléens à 0 ou 1', () => {
    expect(clampToParam(bool, 1)).toBe(1);
    expect(clampToParam(bool, 0)).toBe(0);
  });

  it('remplace une valeur non finie par le défaut plutôt que de la transmettre', () => {
    expect(clampToParam(f32, Number.NaN)).toBe(f32.def);
    expect(clampToParam(f32, Number.POSITIVE_INFINITY)).toBe(f32.def);
  });
});

describe('messages de lecture et écriture', () => {
  it('encode PARAM_DICT_GET', () => {
    expect(Array.from(encodeParamDictGet(0, 6))).toEqual([0, 0, 6, 0]);
  });

  it('aller-retour PARAM_READ', () => {
    const req = encodeParamRead([0x0100, 0x0102]);
    expect(Array.from(req)).toEqual([2, 0, 0x00, 0x01, 0x02, 0x01]);

    // Réponse telle que la construit le firmware : count, puis {id, statut, valeur}.
    const resp = new Uint8Array(2 + 2 * 7);
    const v = new DataView(resp.buffer);
    v.setUint16(0, 2, true);
    v.setUint16(2, 0x0100, true);
    resp[4] = ParamStatus.OK;
    v.setFloat32(5, 42, true);
    v.setUint16(9, 0x0999, true);
    resp[11] = ParamStatus.ERR_ID;
    v.setFloat32(12, 0, true);

    const got = decodeParamRead(resp);
    expect(got).toEqual([
      { id: 0x0100, status: ParamStatus.OK, value: 42 },
      { id: 0x0999, status: ParamStatus.ERR_ID, value: 0 },
    ]);
  });

  it('aller-retour PARAM_WRITE', () => {
    const req = encodeParamWrite([{ id: 0x0102, value: 1.5 }]);
    expect(req).toHaveLength(2 + 6);

    const resp = new Uint8Array(2 + 3);
    const v = new DataView(resp.buffer);
    v.setUint16(0, 1, true);
    v.setUint16(2, 0x0011, true);
    resp[4] = ParamStatus.ERR_READ_ONLY;

    expect(decodeParamWrite(resp)).toEqual([
      { id: 0x0011, status: ParamStatus.ERR_READ_ONLY },
    ]);
  });
});
