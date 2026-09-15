/**
 * Confrontation aux vecteurs de référence partagés avec le firmware.
 *
 * `docs/protocol-vectors.json` est produit par une troisième implémentation, en Python
 * (`tools/gen_protocol_vectors.py`), ancrée sur les vecteurs publiés de l'article COBS et sur
 * les vecteurs d'arbitrage des deux CRC. Le firmware vérifie les mêmes octets sur la cible
 * via la commande console `SELFTEST`. C'est ce triangle qui garantit l'accord octet pour
 * octet — et non le fait que deux implémentations écrites d'affilée se ressemblent.
 */

import { describe, expect, it } from 'vitest';

import vectors from '../../../../docs/protocol-vectors.json' with { type: 'json' };
import { cobsDecode, cobsEncode } from '../cobs.js';
import { crc16, crc32 } from '../crc16.js';
import { FRAME_SOH, decodeFrame, encodeFrame } from '../frame.js';

const hex = (s: string): Uint8Array =>
  s.length === 0 ? new Uint8Array(0) : Uint8Array.from(Buffer.from(s, 'hex'));

const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('CRC-16/CCITT-FALSE', () => {
  it.each(vectors.crc16)('crc16(%o)', (v) => {
    expect(crc16(hex(v.input_hex))).toBe(v.crc);
  });

  it("le vecteur d'arbitrage vaut 0x29B1", () => {
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0x29b1);
  });
});

describe('CRC-32/ISO-HDLC', () => {
  it.each(vectors.crc32)('crc32(%o)', (v) => {
    expect(crc32(hex(v.input_hex))).toBe(v.crc);
  });

  it("le vecteur d'arbitrage vaut 0xCBF43926", () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('COBS', () => {
  it.each(vectors.cobs)('encode %o octet pour octet', (v) => {
    expect(toHex(cobsEncode(hex(v.raw_hex)))).toBe(v.encoded_hex);
  });

  it.each(vectors.cobs)('décode %o', (v) => {
    expect(toHex(cobsDecode(hex(v.encoded_hex))!)).toBe(v.raw_hex);
  });

  it("l'encodage ne laisse jamais passer un 0x00", () => {
    for (const v of vectors.cobs) {
      expect(cobsEncode(hex(v.raw_hex)).includes(0)).toBe(false);
    }
  });
});

describe('trames complètes', () => {
  it.each(vectors.frames)('$name — encode octet pour octet', (v) => {
    const got = encodeFrame(v.msg_id, v.flags, v.seq, hex(v.payload_hex));
    expect(toHex(got)).toBe(v.encoded_hex);
  });

  it.each(vectors.frames)('$name — décode', (v) => {
    const encoded = hex(v.encoded_hex);
    expect(encoded[0], 'octet de début absent').toBe(FRAME_SOH);
    expect(encoded.at(-1), 'délimiteur absent').toBe(0);
    // Le décodeur ne voit que le corps COBS : ni l'octet de début, ni le délimiteur.
    const f = decodeFrame(encoded.subarray(1, encoded.length - 1));
    expect(f.msgId).toBe(v.msg_id);
    expect(f.flags).toBe(v.flags);
    expect(f.seq).toBe(v.seq);
    expect(toHex(f.payload)).toBe(v.payload_hex);
  });
});
