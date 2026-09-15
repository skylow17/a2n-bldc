/**
 * Propriétés du codec que les vecteurs figés ne couvrent pas : aller-retour sur des entrées
 * quelconques, robustesse aux entrées malformées, et comportement du démultiplexeur de flux.
 */

import { describe, expect, it } from 'vitest';

import { cobsDecode, cobsEncode, cobsMaxEncoded } from '../cobs.js';
import {
  FrameStream,
  PayloadReader,
  PayloadWriter,
  FRAME_SOH,
  decodeFrame,
  encodeFrame,
  type StreamItem,
} from '../frame.js';
import { FRAME_PAYLOAD_MAX } from '../protocol.js';

/** Générateur déterministe : un test qui échoue doit échouer à chaque exécution. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe('COBS — propriétés', () => {
  it('aller-retour sur 5000 entrées, avec beaucoup de zéros', () => {
    const rnd = makeRng(20260915);
    const lengths = [0, 1, 2, 3, 253, 254, 255, 256, 507, 508, 509, 518];

    for (let i = 0; i < 5000; i++) {
      const n =
        i < lengths.length ? lengths[i]! : Math.floor(rnd() * 521);
      const src = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        // Trois zéros pour une valeur quelconque : c'est sur les zéros que COBS travaille.
        src[k] = rnd() < 0.75 ? 0 : Math.floor(rnd() * 256);
      }

      const enc = cobsEncode(src);
      expect(enc.includes(0), `zéro parasite à la longueur ${n}`).toBe(false);
      expect(enc.length, `dépassement de borne à la longueur ${n}`).toBeLessThanOrEqual(
        cobsMaxEncoded(n),
      );
      expect(cobsDecode(enc), `aller-retour cassé à la longueur ${n}`).toEqual(src);
    }
  });

  it('rejette une entrée malformée plutôt que de rendre une trame partielle', () => {
    expect(cobsDecode(new Uint8Array(0))).toBeNull();
    expect(cobsDecode(Uint8Array.from([0x00]))).toBeNull();
    // Le code annonce plus d'octets que l'entrée n'en contient.
    expect(cobsDecode(Uint8Array.from([0x05, 0x11, 0x22]))).toBeNull();
  });
});

describe('trames', () => {
  it('aller-retour sur toutes les tailles de payload aux limites', () => {
    for (const n of [0, 1, 63, 64, 253, 254, 255, 511, FRAME_PAYLOAD_MAX]) {
      const payload = new Uint8Array(n);
      for (let i = 0; i < n; i++) payload[i] = (i * 7) & 0xff;

      const encoded = encodeFrame(0x1234, 0x05, 0xab, payload);
      expect(encoded[0], 'octet de début absent').toBe(FRAME_SOH);
      expect(encoded[encoded.length - 1], 'délimiteur absent').toBe(0);

      const f = decodeFrame(encoded.subarray(1, encoded.length - 1));
      expect(f.msgId).toBe(0x1234);
      expect(f.flags).toBe(0x05);
      expect(f.seq).toBe(0xab);
      expect(f.payload).toEqual(payload);
    }
  });

  it('refuse un payload au-delà de la limite du protocole', () => {
    expect(() => encodeFrame(1, 0, 0, new Uint8Array(FRAME_PAYLOAD_MAX + 1))).toThrow(RangeError);
  });

  it('détecte un octet corrompu par le CRC', () => {
    const payload = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const encoded = encodeFrame(0x0012, 0, 9, payload);
    const body = encoded.subarray(1, encoded.length - 1);

    let caught = 0;
    for (let i = 0; i < body.length; i++) {
      const tampered = Uint8Array.from(body);
      // On modifie l'octet sans jamais produire un 0x00, qui serait un délimiteur.
      tampered[i] = tampered[i]! === 0xff ? 0xfe : tampered[i]! + 1;
      try {
        decodeFrame(tampered);
      } catch {
        caught++;
      }
    }
    expect(caught, 'une corruption est passée inaperçue').toBe(body.length);
  });
});

describe('FrameStream — démultiplexage du flux', () => {
  it('sépare trames binaires et lignes de console entrelacées', () => {
    const stream = new FrameStream();
    const frame = encodeFrame(0x0001, 0, 1);
    const line = new TextEncoder().encode('PING\r\n');

    const all = new Uint8Array(frame.length + line.length + frame.length);
    all.set(frame, 0);
    all.set(line, frame.length);
    all.set(frame, frame.length + line.length);

    const items = stream.push(all);
    expect(items.map((i) => i.kind)).toEqual(['frame', 'line', 'frame']);
    expect(items[1]).toMatchObject({ kind: 'line', text: 'PING' });
  });

  it('reconstitue une trame arrivée en morceaux arbitraires', () => {
    const stream = new FrameStream();
    const payload = new Uint8Array(300).fill(0x42);
    const frame = encodeFrame(0x0011, 1, 7, payload);

    const items: StreamItem[] = [];
    for (let i = 0; i < frame.length; i += 7) {
      items.push(...stream.push(frame.subarray(i, i + 7)));
    }

    expect(items).toHaveLength(1);
    const first = items[0];
    expect(first).toMatchObject({ kind: 'frame' });
    if (first?.kind === 'frame') {
      expect(first.frame.payload).toEqual(payload);
    }
  });

  it('se resynchronise après des octets parasites', () => {
    const stream = new FrameStream();
    const garbage = Uint8Array.from([0x77, 0x88, 0x99]);
    const frame = encodeFrame(0x0001, 0, 2);

    const first = stream.push(Uint8Array.from([...garbage, 0x00]));
    expect(first[0]).toMatchObject({ kind: 'error' });

    const second = stream.push(frame);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ kind: 'frame' });
  });

  it('signale un débordement une seule fois, au moment où le message est abandonné', () => {
    const stream = new FrameStream(64);
    const flood = new Uint8Array(200).fill(0x41);

    // Rien n'est émis pendant l'accumulation : on ne sait pas encore que le message est
    // perdu plutôt que simplement long. Comme le firmware, on consomme jusqu'au
    // terminateur et on signale une seule fois.
    expect(stream.push(flood)).toEqual([]);
    expect(stream.push(Uint8Array.from([0x0a]))).toEqual([
      { kind: 'error', reason: 'overflow' },
    ]);

    // Et le message suivant doit être intact : aucun reste du précédent.
    expect(stream.push(new TextEncoder().encode('PING\n'))).toEqual([
      { kind: 'line', text: 'PING' },
    ]);
  });

  it("abandonne une ligne ASCII qui reçoit un 0x00 — l'émetteur s'est désynchronisé", () => {
    const stream = new FrameStream();
    expect(stream.push(Uint8Array.from([0x50, 0x49, 0x4e, 0x00]))).toEqual([
      { kind: 'error', reason: 'len' },
    ]);

    // Resynchronisation immédiate : la trame suivante passe.
    expect(stream.push(encodeFrame(0x0001, 0, 3)).map((i) => i.kind)).toEqual(['frame']);
  });

  it('ne coupe pas une trame binaire contenant des CR ou des LF', () => {
    // C'est le défaut que l'octet de début corrige. COBS n'exclut que 0x00 de la trame
    // encodée, pas 0x0A ni 0x0D : discriminer sur le terminateur découpait les trames dès
    // qu'elles en contenaient — le cas courant au-delà de quelques dizaines d'octets.
    const stream = new FrameStream();
    const payload = new Uint8Array(256);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 2 === 0 ? 0x0a : 0x0d;

    const frame = encodeFrame(0x0011, 0, 4, payload);
    const body = frame.subarray(1, frame.length - 1);
    expect(
      body.some((b) => b === 0x0a || b === 0x0d),
      'le vecteur ne teste rien si le corps ne contient ni CR ni LF',
    ).toBe(true);

    const items = stream.push(frame);
    expect(items).toHaveLength(1);
    const first = items[0];
    if (first?.kind === 'frame') {
      expect(first.frame.payload).toEqual(payload);
    } else {
      expect.fail(`trame découpée : ${JSON.stringify(items.map((i) => i.kind))}`);
    }
  });
});

describe('PayloadReader / PayloadWriter', () => {
  it('conserve les valeurs à travers un aller-retour', () => {
    const buf = new PayloadWriter().u8(0xfe).u16(0xbeef).i16(-1234).u32(0xdeadbeef).f32(1.5).build();
    const r = new PayloadReader(buf);
    expect(r.u8()).toBe(0xfe);
    expect(r.u16()).toBe(0xbeef);
    expect(r.i16()).toBe(-1234);
    expect(r.u32()).toBe(0xdeadbeef);
    expect(r.f32()).toBe(1.5);
    expect(r.remaining).toBe(0);
  });

  it('signale un payload tronqué au lieu de rendre une valeur fausse', () => {
    const r = new PayloadReader(Uint8Array.from([1, 2]));
    expect(() => r.u32()).toThrow(RangeError);
  });

  it('lit une chaîne de largeur fixe, terminée ou pleine', () => {
    const w = new PayloadWriter();
    const field = new Uint8Array(8);
    field.set(new TextEncoder().encode('Hz'));
    w.raw(field);
    const full = new TextEncoder().encode('ABCDEFGH'); // occupe tout le champ
    w.raw(full);

    const r = new PayloadReader(w.build());
    expect(r.fixedString(8)).toBe('Hz');
    expect(r.fixedString(8)).toBe('ABCDEFGH');
  });
});
