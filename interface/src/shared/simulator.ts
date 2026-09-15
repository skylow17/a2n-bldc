/**
 * Device simulé — parle le protocole du firmware, sur les deux canaux.
 *
 * Ce n'est pas un bouchon de test : c'est un `Transport` complet, sélectionnable comme un
 * port. Il sert à développer et à valider tout le poste PC sans immobiliser la carte, et
 * surtout à rejouer à volonté ce qui ne se reproduit pas sur commande — une trame corrompue,
 * un lien qui tombe au milieu d'une pagination.
 *
 * Il tient son dictionnaire des vecteurs de référence (`docs/protocol-vectors.json`), donc
 * de la même source que le firmware et l'interface. S'il en divergeait, c'est que les
 * vecteurs n'ont pas été régénérés après une modification de `param_table.c` — et le test
 * du hash le dit.
 */

import vectors from '../../../docs/protocol-vectors.json' with { type: 'json' };
import { FrameStream, PayloadWriter, encodeFrame } from './frame.js';
import { cobsDecode, cobsEncode } from './cobs.js';
import { crc16 } from './crc16.js';
import { MSG, FRAME_FLAG, PROTO_ERR } from './protocol.js';
import {
  PARAM_ENTRY_WIRE_LEN,
  paramDictHash,
  writeParamEntry,
  type ParamDesc,
  type ParamTypeValue,
} from './params.js';
import { ParamStatus } from './messages.js';
import { Emitter, type Transport } from './transport.js';

/** Table par défaut : celle du firmware à M1b, depuis les vecteurs de référence. */
export const DEFAULT_SIM_PARAMS: readonly ParamDesc[] = vectors.param_dict.entries.map((e) => ({
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

/** Valeurs initiales des paramètres en lecture seule, telles que la carte les exposerait. */
const DEFAULT_RO_VALUES: Readonly<Record<string, number>> = {
  'board.sysclk_hz': 144_000_000,
  'board.vref_mv': 2048,
  'pwm.freq_hz': 20_000,
  'pwm.arr': 3599,
  'pwm.deadtime_ns': 500,
  'pwm.ccr4_trig': 3579,
};

export interface SimulatorOptions {
  product?: string;
  fwVersion?: string;
  params?: readonly ParamDesc[];
  /** Nombre d'entrées par page de dictionnaire — le firmware en met 6 au maximum. */
  dictPageSize?: number;
  /** Latence simulée, en millisecondes, appliquée à chaque réponse. */
  latencyMs?: number;
  /** Fraction de trames émises volontairement corrompues, pour éprouver la reprise. */
  corruptionRate?: number;
}

export class SimulatedDevice implements Transport {
  private readonly dataEmitter = new Emitter<Uint8Array>();
  private readonly errorEmitter = new Emitter<Error>();
  private readonly stream = new FrameStream();
  private readonly values = new Map<number, number>();
  private readonly params: readonly ParamDesc[];
  private readonly dictHash: number;
  private readonly opts: Required<SimulatorOptions>;
  private open = true;
  private rxFrames = 0;
  private rxErrors = 0;
  private pwmEnabled = false;

  readonly description = 'simulator';

  constructor(options: SimulatorOptions = {}) {
    this.params = options.params ?? DEFAULT_SIM_PARAMS;
    this.opts = {
      product: options.product ?? 'A2N-BLDC',
      fwVersion: options.fwVersion ?? '2.0.0-sim',
      params: this.params,
      dictPageSize: options.dictPageSize ?? 6,
      latencyMs: options.latencyMs ?? 0,
      corruptionRate: options.corruptionRate ?? 0,
    };
    this.dictHash = paramDictHash(this.params);
    this.resetValues();
  }

  get isOpen(): boolean {
    return this.open;
  }

  private resetValues(): void {
    for (const p of this.params) {
      this.values.set(p.id, DEFAULT_RO_VALUES[p.name] ?? p.def);
    }
  }

  /* ---------------------------------------------------------------- Transport */

  async write(data: Uint8Array): Promise<void> {
    if (!this.open) throw new Error('simulateur fermé');
    for (const item of this.stream.push(data)) {
      if (item.kind === 'frame') {
        this.rxFrames++;
        this.onFrame(item.frame.msgId, item.frame.seq, item.frame.payload);
      } else if (item.kind === 'line') {
        this.onLine(item.text);
      } else {
        // Le firmware répond LEN ou CRC selon la cause ; même comportement ici.
        this.rxErrors++;
        this.reply(encodeFrame(0, FRAME_FLAG.RESPONSE | FRAME_FLAG.ERROR, 0,
          new PayloadWriter().u16(item.reason === 'crc' ? PROTO_ERR.CRC : PROTO_ERR.LEN).build()));
      }
    }
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    return this.dataEmitter.on(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    return this.errorEmitter.on(listener);
  }

  async close(): Promise<void> {
    this.open = false;
    this.dataEmitter.clear();
    this.errorEmitter.clear();
  }

  /** Simule une rupture de lien : le client doit la voir et ne pas rester suspendu. */
  fail(reason = 'lien interrompu'): void {
    this.open = false;
    this.errorEmitter.emit(new Error(reason));
  }

  /* ---------------------------------------------------------------- émission */

  private reply(bytes: Uint8Array): void {
    const send = (): void => {
      if (!this.open) return;
      let out = bytes;
      if (this.opts.corruptionRate > 0 && Math.random() < this.opts.corruptionRate && out.length > 3) {
        out = Uint8Array.from(out);
        // On évite d'introduire un 0x00, qui serait lu comme une fin de trame et non
        // comme une corruption : ce qu'on veut éprouver ici, c'est le CRC.
        const i = 1 + Math.floor(Math.random() * (out.length - 2));
        out[i] = out[i] === 0xff ? 0xfe : out[i]! + 1;
      }
      this.dataEmitter.emit(out);
    };

    if (this.opts.latencyMs > 0) setTimeout(send, this.opts.latencyMs);
    else queueMicrotask(send);
  }

  private replyFrame(msgId: number, seq: number, payload: Uint8Array): void {
    this.reply(encodeFrame(msgId, FRAME_FLAG.RESPONSE, seq, payload));
  }

  private replyError(msgId: number, seq: number, code: number): void {
    this.rxErrors++;
    this.reply(
      encodeFrame(msgId, FRAME_FLAG.RESPONSE | FRAME_FLAG.ERROR, seq,
        new PayloadWriter().u16(code).build()),
    );
  }

  private replyLine(text: string): void {
    this.reply(new TextEncoder().encode(`${text}\r\n`));
  }

  /* ---------------------------------------------------------------- canal binaire */

  private onFrame(msgId: number, seq: number, payload: Uint8Array): void {
    switch (msgId) {
      case MSG.HELLO:
        this.replyFrame(MSG.DEVICE_INFO, seq, this.deviceInfoPayload());
        break;
      case MSG.PARAM_DICT_GET:
        this.onDictGet(seq, payload);
        break;
      case MSG.PARAM_READ:
        this.onRead(seq, payload);
        break;
      case MSG.PARAM_WRITE:
        this.onWrite(seq, payload);
        break;
      case MSG.PARAM_RESET_DEFAULTS:
        this.resetValues();
        this.replyFrame(MSG.PARAM_RESET_DEFAULTS, seq, new Uint8Array(0));
        break;
      case MSG.PARAM_SAVE_NVM:
        // Comme le firmware : refuser explicitement plutôt que de répondre OK sans rien
        // écrire, ce qui ferait croire la recette enregistrée.
        this.replyError(MSG.PARAM_SAVE_NVM, seq, PROTO_ERR.NVM);
        break;
      default:
        this.replyError(msgId, seq, PROTO_ERR.ID);
        break;
    }
  }

  private deviceInfoPayload(): Uint8Array {
    const fixed = (s: string, width: number): Uint8Array => {
      const out = new Uint8Array(width);
      out.set(new TextEncoder().encode(s).subarray(0, width));
      return out;
    };
    return new PayloadWriter()
      .u16(0x0200)
      .raw(fixed(this.opts.product, 16))
      .raw(fixed(this.opts.fwVersion, 16))
      .u32(this.dictHash)
      .u32(0xdead0001)
      .u32(0xdead0002)
      .u32(0xdead0003)
      .u16(this.params.length)
      .u16(0) // telem_signal_count : aucun signal à M1b
      .u32(0) // capabilities : rien d'implémenté, rien d'annoncé
      .build();
  }

  private onDictGet(seq: number, payload: Uint8Array): void {
    if (payload.length < 4) return this.replyError(MSG.PARAM_DICT_GET, seq, PROTO_ERR.LEN);
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const start = view.getUint16(0, true);
    let want = view.getUint16(2, true);

    if (start >= this.params.length) {
      return this.replyError(MSG.PARAM_DICT_GET, seq, PROTO_ERR.RANGE);
    }
    want = Math.min(want || 1, this.opts.dictPageSize, this.params.length - start);

    const out = new Uint8Array(6 + want * PARAM_ENTRY_WIRE_LEN);
    const ov = new DataView(out.buffer);
    ov.setUint16(0, start, true);
    ov.setUint16(2, this.params.length, true);
    ov.setUint16(4, want, true);
    for (let k = 0; k < want; k++) {
      out.set(writeParamEntry(this.params[start + k]!), 6 + k * PARAM_ENTRY_WIRE_LEN);
    }
    this.replyFrame(MSG.PARAM_DICT_ENTRY, seq, out);
  }

  private onRead(seq: number, payload: Uint8Array): void {
    if (payload.length < 2) return this.replyError(MSG.PARAM_READ, seq, PROTO_ERR.LEN);
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = view.getUint16(0, true);
    if (payload.length < 2 + count * 2) {
      return this.replyError(MSG.PARAM_READ, seq, PROTO_ERR.LEN);
    }

    const w = new PayloadWriter().u16(count);
    for (let k = 0; k < count; k++) {
      const id = view.getUint16(2 + k * 2, true);
      const known = this.params.some((p) => p.id === id);
      w.u16(id)
        .u8(known ? ParamStatus.OK : ParamStatus.ERR_ID)
        .f32(known ? (this.values.get(id) ?? 0) : 0);
    }
    this.replyFrame(MSG.PARAM_READ, seq, w.build());
  }

  private onWrite(seq: number, payload: Uint8Array): void {
    if (payload.length < 2) return this.replyError(MSG.PARAM_WRITE, seq, PROTO_ERR.LEN);
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = view.getUint16(0, true);
    if (payload.length < 2 + count * 6) {
      return this.replyError(MSG.PARAM_WRITE, seq, PROTO_ERR.LEN);
    }

    const w = new PayloadWriter().u16(count);
    for (let k = 0; k < count; k++) {
      const id = view.getUint16(2 + k * 6, true);
      const value = view.getFloat32(4 + k * 6, true);
      w.u16(id).u8(this.applyWrite(id, value));
    }
    this.replyFrame(MSG.PARAM_WRITE, seq, w.build());
  }

  /** Reproduit exactement la logique de `Param_WriteValue` côté firmware. */
  private applyWrite(id: number, value: number): number {
    const p = this.params.find((e) => e.id === id);
    if (!p) return ParamStatus.ERR_ID;
    if ((p.flags & 0x01) !== 0) return ParamStatus.ERR_READ_ONLY;
    if (Number.isNaN(value) || value < p.min || value > p.max) return ParamStatus.ERR_RANGE;

    // Arrondi au plus proche avant rangement dans un type entier, comme le firmware.
    const isFloat = p.type === 6;
    const isBool = p.type === 7;
    let stored = value;
    if (isBool) stored = value !== 0 ? 1 : 0;
    else if (!isFloat) stored = value < 0 ? Math.ceil(value - 0.5) : Math.floor(value + 0.5);
    else stored = Math.fround(value);

    this.values.set(id, stored);
    return ParamStatus.OK;
  }

  /* ---------------------------------------------------------------- console ASCII */

  /**
   * Rejoue les vecteurs de référence avec l'implémentation TypeScript.
   *
   * Le firmware exécute les mêmes sur la cible. Répondre `total=0` serait plus simple, mais
   * un auto-test qui n'a rien testé ne doit pas pouvoir passer pour vert : la commande
   * `check` compte sur ce nombre.
   */
  private selftest(): string {
    let total = 0;
    let crcFailed = 0;
    let encFailed = 0;
    let decFailed = 0;
    let frameFailed = 0;

    const hex = (h: string): Uint8Array =>
      h.length === 0 ? new Uint8Array(0) : Uint8Array.from(Buffer.from(h, 'hex'));
    const same = (a: Uint8Array, b: Uint8Array): boolean =>
      a.length === b.length && a.every((v, i) => v === b[i]);

    for (const v of vectors.crc16) {
      if (v.input_hex.length === 0) continue; // écarté côté C : pas de tableau vide légal
      total++;
      if (crc16(hex(v.input_hex)) !== v.crc) crcFailed++;
    }

    for (const v of vectors.cobs) {
      total++;
      if (!same(cobsEncode(hex(v.raw_hex)), hex(v.encoded_hex))) encFailed++;
      total++;
      const decoded = cobsDecode(hex(v.encoded_hex));
      if (decoded === null || !same(decoded, hex(v.raw_hex))) decFailed++;
    }

    for (const v of vectors.frames) {
      total++;
      if (!same(encodeFrame(v.msg_id, v.flags, v.seq, hex(v.payload_hex)), hex(v.encoded_hex))) {
        frameFailed++;
      }
    }

    total++;
    const dictOk = this.dictHash === vectors.param_dict.hash;

    const failed = crcFailed + encFailed + decFailed + frameFailed + (dictOk ? 0 : 1);
    return (
      `${failed === 0 ? 'OK' : 'ERR'} total=${total} failed=${failed} crc16=${crcFailed} ` +
      `cobs_enc=${encFailed} cobs_dec=${decFailed} frame=${frameFailed} ` +
      `dict_hash=${this.dictHash.toString(16).toUpperCase().padStart(8, '0')} ` +
      `dict_ok=${dictOk ? 1 : 0}`
    );
  }

  private onLine(line: string): void {
    const [verb = ''] = line.trim().split(/\s+/);
    const upper = verb.toUpperCase();
    const arg = line.trim().slice(verb.length).trim();

    switch (upper) {
      case 'PING':
        this.replyLine(arg ? `OK ${arg}` : 'OK');
        break;
      case 'INFO?':
        this.replyLine(
          `OK product=${this.opts.product} fw=${this.opts.fwVersion} proto=2.0 ` +
            `sysclk=144000000 pwm_hz=20000 arr=3599 deadtime_ns=500 vref_mv=2048`,
        );
        break;
      case 'PROTO?':
        this.replyLine(
          `OK rx_frames=${this.rxFrames} rx_errors=${this.rxErrors} tx_dropped=0 ` +
            `overflows=0 params=${this.params.length} ` +
            `dict_hash=${this.dictHash.toString(16).toUpperCase().padStart(8, '0')}`,
        );
        break;
      case 'SELFTEST':
        this.replyLine(this.selftest());
        break;
      case 'STOP':
        // Le simulateur n'a pas d'etage de puissance ; il repond comme la carte pour
        // que le chemin complet du bouton STOP soit reellement exerce.
        this.pwmEnabled = false;
        this.replyLine('OK');
        break;
      case 'PWM?':
        this.replyLine(`OK enabled=${this.pwmEnabled ? 1 : 0}`);
        break;
      case 'LINK?':
        this.replyLine('OK tx_dropped=0 rx_dropped=0');
        break;
      case 'STATS?':
        this.replyLine('OK ticks=0 ms=0 last_ns=0 max_ns=0 load_pm=0 ia=2048 ib=2048 ic=2048');
        break;
      case '':
        this.replyLine('ERR EMPTY');
        break;
      default:
        this.replyLine('ERR CMD');
        break;
    }
  }
}
