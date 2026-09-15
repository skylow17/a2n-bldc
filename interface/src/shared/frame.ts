/**
 * Trame binaire du protocole v2 — `docs/protocol.md` §2.
 *
 *   msg_id(u16 LE) | flags(u8) | seq(u8) | payload(0..512) | crc16(u16 LE)
 *
 * encodé en COBS puis suivi d'un 0x00 délimiteur. Le CRC couvre `msg_id` jusqu'à la fin du
 * payload, avant encodage. Jumeau de `controller-2/Core/Src/comm/frame.c`.
 */

import { cobsDecode, cobsEncode } from './cobs.js';
import { crc16 } from './crc16.js';
import {
  FRAME_CRC_LEN,
  FRAME_HEADER_LEN,
  FRAME_PAYLOAD_MAX,
  FRAME_RAW_MAX,
  FRAME_RAW_MIN,
} from './protocol.js';

export interface Frame {
  msgId: number;
  flags: number;
  seq: number;
  payload: Uint8Array;
}

export type FrameError = 'cobs' | 'len' | 'crc';

export class FrameDecodeError extends Error {
  constructor(readonly reason: FrameError) {
    super(`trame invalide : ${reason}`);
    this.name = 'FrameDecodeError';
  }
}

/** Sérialise et encode une trame complète, délimiteur 0x00 compris. */
export function encodeFrame(
  msgId: number,
  flags: number,
  seq: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (payload.length > FRAME_PAYLOAD_MAX) {
    throw new RangeError(`payload de ${payload.length} octets, maximum ${FRAME_PAYLOAD_MAX}`);
  }

  const body = FRAME_HEADER_LEN + payload.length;
  const raw = new Uint8Array(body + FRAME_CRC_LEN);
  const view = new DataView(raw.buffer);

  view.setUint16(0, msgId, true);
  raw[2] = flags & 0xff;
  raw[3] = seq & 0xff;
  raw.set(payload, FRAME_HEADER_LEN);
  view.setUint16(body, crc16(raw.subarray(0, body)), true);

  const encoded = cobsEncode(raw);
  const out = new Uint8Array(encoded.length + 1);
  out.set(encoded, 0);
  out[encoded.length] = 0x00; // délimiteur
  return out;
}

/** Décode une trame reçue, délimiteur exclu, et vérifie son CRC. */
export function decodeFrame(encoded: Uint8Array): Frame {
  const raw = cobsDecode(encoded);
  if (raw === null) throw new FrameDecodeError('cobs');
  if (raw.length < FRAME_RAW_MIN || raw.length > FRAME_RAW_MAX) {
    throw new FrameDecodeError('len');
  }

  const body = raw.length - FRAME_CRC_LEN;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint16(body, true) !== crc16(raw.subarray(0, body))) {
    throw new FrameDecodeError('crc');
  }

  return {
    msgId: view.getUint16(0, true),
    flags: raw[2]!,
    seq: raw[3]!,
    payload: raw.subarray(FRAME_HEADER_LEN, body),
  };
}

/**
 * Découpe un flux d'octets en trames, sur le délimiteur 0x00.
 *
 * Le flux d'entrée arrive par paquets USB qui ne respectent aucune frontière de trame : il
 * faut donc un état persistant entre deux appels. Les lignes de la console ASCII circulent
 * sur le même lien et sont restituées à part, sans être confondues avec des trames — c'est
 * le pendant exact de `comm/rx_router.c` côté firmware.
 */
export type StreamItem =
  | { kind: 'frame'; frame: Frame }
  | { kind: 'line'; text: string }
  | { kind: 'error'; reason: FrameError | 'overflow' };

export class FrameStream {
  private acc: number[] = [];
  private overflowed = false;
  private readonly decoder = new TextDecoder();

  constructor(private readonly maxAccumulated = 2048) {}

  /** Consomme des octets et rend ce qui est complet, dans l'ordre d'arrivée. */
  push(chunk: Uint8Array): StreamItem[] {
    const out: StreamItem[] = [];

    for (const byte of chunk) {
      const isTerminator = byte === 0x00 || byte === 0x0d || byte === 0x0a;

      if (!isTerminator) {
        if (this.acc.length >= this.maxAccumulated) {
          // On continue de consommer jusqu'au terminateur plutôt que de couper : le
          // message suivant ne doit pas hériter d'un reste du précédent. Un seul
          // signalement par message perdu.
          if (!this.overflowed) {
            this.overflowed = true;
            out.push({ kind: 'error', reason: 'overflow' });
          }
        } else {
          this.acc.push(byte);
        }
        continue;
      }

      const body = this.acc;
      const lost = this.overflowed;
      this.acc = [];
      this.overflowed = false;

      // Un terminateur isolé (ligne vide, ou le \n d'un \r\n) ne déclenche rien.
      if (lost || body.length === 0) continue;

      if (byte === 0x00) {
        try {
          out.push({ kind: 'frame', frame: decodeFrame(Uint8Array.from(body)) });
        } catch (e) {
          out.push({ kind: 'error', reason: e instanceof FrameDecodeError ? e.reason : 'len' });
        }
      } else {
        out.push({ kind: 'line', text: this.decoder.decode(Uint8Array.from(body)) });
      }
    }

    return out;
  }

  reset(): void {
    this.acc = [];
    this.overflowed = false;
  }
}

/* ------------------------------------------------------------------ lecture de payload */

/**
 * Curseur de lecture little-endian. Il vérifie la longueur à chaque pas : un payload tronqué
 * lève une erreur claire au lieu de produire un `NaN` ou un `undefined` qui se propagerait.
 */
export class PayloadReader {
  private off = 0;
  private readonly view: DataView;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining(): number {
    return this.buf.length - this.off;
  }

  private need(n: number): number {
    if (this.remaining < n) {
      throw new RangeError(`payload tronqué : ${n} octets demandés, ${this.remaining} disponibles`);
    }
    const at = this.off;
    this.off += n;
    return at;
  }

  u8(): number {
    return this.buf[this.need(1)]!;
  }
  i8(): number {
    return this.view.getInt8(this.need(1));
  }
  u16(): number {
    return this.view.getUint16(this.need(2), true);
  }
  i16(): number {
    return this.view.getInt16(this.need(2), true);
  }
  u32(): number {
    return this.view.getUint32(this.need(4), true);
  }
  i32(): number {
    return this.view.getInt32(this.need(4), true);
  }
  f32(): number {
    return this.view.getFloat32(this.need(4), true);
  }
  bytes(n: number): Uint8Array {
    return this.buf.subarray(this.need(n), this.off);
  }

  /** Chaîne de largeur fixe complétée par des zéros ; le champ plein n'est pas terminé. */
  fixedString(width: number): string {
    const raw = this.bytes(width);
    const end = raw.indexOf(0);
    return new TextDecoder().decode(end === -1 ? raw : raw.subarray(0, end));
  }
}

/** Écriture little-endian, symétrique de `PayloadReader`. */
export class PayloadWriter {
  private readonly bytes: number[] = [];
  private readonly scratch = new DataView(new ArrayBuffer(4));

  private push(n: number): void {
    for (let i = 0; i < n; i++) this.bytes.push(this.scratch.getUint8(i));
  }

  u8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    this.scratch.setUint16(0, v, true);
    this.push(2);
    return this;
  }
  i16(v: number): this {
    this.scratch.setInt16(0, v, true);
    this.push(2);
    return this;
  }
  u32(v: number): this {
    this.scratch.setUint32(0, v, true);
    this.push(4);
    return this;
  }
  f32(v: number): this {
    this.scratch.setFloat32(0, v, true);
    this.push(4);
    return this;
  }
  raw(data: Uint8Array): this {
    for (const b of data) this.bytes.push(b);
    return this;
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}
