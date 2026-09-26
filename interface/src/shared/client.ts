/**
 * Client du protocole : au-dessus du transport, en dessous de tout le reste.
 *
 * C'est le point unique par lequel passent la CLI, l'UI et le serveur MCP. Un seul chemin
 * d'exécution — pas une API pour l'humain et une autre pour l'agent — parce que c'est la
 * seule façon d'avoir la certitude qu'un test automatisé exerce bien ce que l'utilisateur
 * déclenche à la main.
 */

import {
  decodeDeviceInfo,
  decodeBootInfo,
  decodeBootWriteAck,
  decodeError,
  decodeParamDictEntry,
  decodeParamRead,
  decodeParamWrite,
  decodeScopeConfig,
  decodeScopeRead,
  decodeScopeStatus,
  decodeTelemFrame,
  decodeTelemSignals,
  decodeTelemSubscribe,
  encodeHello,
  encodeBootErase,
  encodeBootVerify,
  encodeBootWrite,
  encodeParamDictGet,
  encodeParamRead,
  encodeParamWrite,
  encodeScopeConfig,
  encodeScopeRead,
  encodeTelemSignals,
  encodeTelemSubscribe,
  ParamStatus,
  PARAM_STATUS_NAME,
  type ParamReadResult,
  type ParamWriteRequest,
  type ParamWriteResult,
  type BootInfo,
  type ScopeConfig,
  type ScopeStatus,
  type TelemFrame,
  type TelemSubscription,
  decodeParamSaveNvm,
  type NvmSaveResult,
} from './messages.js';
import { FrameStream, encodeFrame, type Frame } from './frame.js';
import { ParamDictionary, type ParamDesc } from './params.js';
import { MSG, FRAME_FLAG, ScopeState, type DeviceInfo, type SignalDesc } from './protocol.js';
import { Emitter, type Transport } from './transport.js';
import { crc32 } from './crc16.js';

export class ProtocolError extends Error {
  constructor(
    readonly code: number,
    readonly codeName: string,
    detail: string,
  ) {
    super(detail ? `${codeName} — ${detail}` : codeName);
    this.name = 'ProtocolError';
  }
}

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`pas de réponse à ${what} après ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

interface Pending {
  expect: number;
  requestId: number;
  resolve: (frame: Frame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  label: string;
}

export interface ClientOptions {
  /** Délai d'attente d'une réponse, en millisecondes. */
  timeoutMs?: number;
}

export class DeviceClient {
  private readonly stream = new FrameStream();
  private readonly pending = new Map<number, Pending>();
  private readonly lineEmitter = new Emitter<string>();
  private readonly pushEmitter = new Emitter<Frame>();
  private readonly telemEmitter = new Emitter<TelemFrame>();
  private readonly scopeStatusEmitter = new Emitter<ScopeStatus>();
  private readonly linkErrorEmitter = new Emitter<Error>();
  private readonly unsubscribe: Array<() => void> = [];
  private seq = 0;
  private readonly timeoutMs: number;

  constructor(
    private readonly transport: Transport,
    options: ClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 1000;
    this.unsubscribe.push(transport.onData((d) => this.onData(d)));
    this.unsubscribe.push(
      transport.onError((e) => {
        // Une rupture de lien doit réveiller tout ce qui attend, sinon la CLI reste
        // suspendue jusqu'au timeout et l'UI paraît figée.
        this.failAll(e);
        this.linkErrorEmitter.emit(e);
      }),
    );
  }

  /** Lignes de la console ASCII arrivées sur le même lien. */
  onLine(listener: (text: string) => void): () => void {
    return this.lineEmitter.on(listener);
  }

  /** Trames non sollicitées : télémétrie, journal, changements d'état (à partir de M1c). */
  onPush(listener: (frame: Frame) => void): () => void {
    return this.pushEmitter.on(listener);
  }

  onTelemetry(listener: (frame: TelemFrame) => void): () => void {
    return this.telemEmitter.on(listener);
  }

  onScopeStatus(listener: (status: ScopeStatus) => void): () => void {
    return this.scopeStatusEmitter.on(listener);
  }

  onLinkError(listener: (error: Error) => void): () => void {
    return this.linkErrorEmitter.on(listener);
  }

  async close(): Promise<void> {
    for (const u of this.unsubscribe) u();
    this.failAll(new Error('client fermé'));
    await this.transport.close();
  }

  /* ---------------------------------------------------------------- réception */

  private onData(data: Uint8Array): void {
    for (const item of this.stream.push(data)) {
      if (item.kind === 'line') {
        this.lineEmitter.emit(item.text);
        continue;
      }
      if (item.kind === 'error') {
        // Une trame illisible n'est rattachable à aucune requête : on ne peut pas la
        // faire échouer sélectivement. On la laisse expirer — c'est le comportement juste,
        // puisqu'une trame perdue et une trame corrompue sont indiscernables pour l'hôte.
        continue;
      }

      if ((item.frame.flags & FRAME_FLAG.PUSH) !== 0) {
        this.pushEmitter.emit(item.frame);
        try {
          if (item.frame.msgId === MSG.TELEM_FRAME) {
            this.telemEmitter.emit(decodeTelemFrame(item.frame.payload));
          } else if (item.frame.msgId === MSG.SCOPE_STATUS) {
            this.scopeStatusEmitter.emit(decodeScopeStatus(item.frame.payload));
          }
        } catch {
          // Une notification mal formée ne doit jamais voler la réponse d'une requête qui
          // porte le même seq. Le monitor brut la voit encore pour le diagnostic.
        }
        continue;
      }

      const p = this.pending.get(item.frame.seq);
      if (p === undefined) {
        this.pushEmitter.emit(item.frame);
        continue;
      }
      // Une réponse d'erreur porte l'identifiant de la *requête*, pas celui de la réponse
      // attendue : les deux sont donc acceptables pour ce `seq`.
      const isError = (item.frame.flags & FRAME_FLAG.ERROR) !== 0;
      if (item.frame.msgId !== p.expect && item.frame.msgId !== p.requestId && !isError) {
        continue;
      }

      clearTimeout(p.timer);
      this.pending.delete(item.frame.seq);

      if (isError) {
        const e = decodeError(item.frame.payload);
        p.reject(new ProtocolError(e.code, e.name, e.detail));
      } else {
        p.resolve(item.frame);
      }
    }
  }

  private failAll(error: Error): void {
    for (const [seq, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(seq);
      p.reject(error);
    }
  }

  /* ---------------------------------------------------------------- émission */

  private async request(
    msgId: number,
    expect: number,
    payload: Uint8Array,
    label: string,
    timeoutMs = this.timeoutMs,
  ): Promise<Frame> {
    // `seq` est un octet : 256 requêtes en vol au maximum, largement au-delà de l'usage.
    // Si l'emplacement est déjà pris, c'est qu'une réponse n'est jamais revenue.
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    if (this.pending.has(seq)) {
      throw new Error('trop de requêtes sans réponse en attente');
    }

    const frame = encodeFrame(msgId, 0, seq, payload);

    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new TimeoutError(label, timeoutMs));
      }, timeoutMs);

      this.pending.set(seq, { expect, requestId: msgId, resolve, reject, timer, label });

      this.transport.write(frame).catch((e: unknown) => {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  /* ---------------------------------------------------------------- opérations */

  async hello(): Promise<DeviceInfo> {
    const f = await this.request(MSG.HELLO, MSG.DEVICE_INFO, encodeHello(), 'HELLO');
    return decodeDeviceInfo(f.payload);
  }

  /**
   * Lit le dictionnaire complet, page par page.
   *
   * Le hash n'est pas demandé au firmware : il est **recalculé** sur les entrées reçues.
   * Le comparer à celui du handshake vérifie donc du même coup que le transfert est complet
   * et dans le bon ordre — c'est le critère de validation de M1b.
   */
  async readDictionary(pageSize = 6): Promise<ParamDictionary> {
    const entries: ParamDesc[] = [];
    let total = Number.POSITIVE_INFINITY;

    while (entries.length < total) {
      const f = await this.request(
        MSG.PARAM_DICT_GET,
        MSG.PARAM_DICT_ENTRY,
        encodeParamDictGet(entries.length, pageSize),
        `PARAM_DICT_GET(${entries.length})`,
      );
      const page = decodeParamDictEntry(f.payload);
      total = page.total;

      if (page.startIndex !== entries.length) {
        throw new Error(
          `page inattendue : index ${page.startIndex} reçu, ${entries.length} attendu`,
        );
      }
      if (page.entries.length === 0) {
        throw new Error('page de dictionnaire vide : pagination bloquée');
      }
      entries.push(...page.entries);
    }

    return new ParamDictionary(entries);
  }

  async readParams(ids: readonly number[]): Promise<ParamReadResult[]> {
    if (ids.length === 0) return [];
    const f = await this.request(
      MSG.PARAM_READ,
      MSG.PARAM_READ,
      encodeParamRead(ids),
      `PARAM_READ(${ids.length})`,
    );
    return decodeParamRead(f.payload);
  }

  async writeParams(writes: readonly ParamWriteRequest[]): Promise<ParamWriteResult[]> {
    if (writes.length === 0) return [];
    const f = await this.request(
      MSG.PARAM_WRITE,
      MSG.PARAM_WRITE,
      encodeParamWrite(writes),
      `PARAM_WRITE(${writes.length})`,
    );
    return decodeParamWrite(f.payload);
  }

  async resetDefaults(): Promise<void> {
    await this.request(
      MSG.PARAM_RESET_DEFAULTS,
      MSG.PARAM_RESET_DEFAULTS,
      new Uint8Array(0),
      'PARAM_RESET_DEFAULTS',
    );
  }

  /**
   * Écrit en flash toutes les entrées persistantes. Le firmware refuse (`STATE`) sorties de
   * puissance actives, et ne répond jamais OK sans avoir relu l'enregistrement : une erreur
   * veut dire que l'enregistrement précédent est toujours celui qui sera rechargé.
   */
  async saveNvm(): Promise<NvmSaveResult> {
    const f = await this.request(
      MSG.PARAM_SAVE_NVM,
      MSG.PARAM_SAVE_NVM,
      new Uint8Array(0),
      'PARAM_SAVE_NVM',
      3000,
    );
    return decodeParamSaveNvm(f.payload);
  }

  async readSignals(pageSize = 11): Promise<SignalDesc[]> {
    const signals: SignalDesc[] = [];
    let total = Number.POSITIVE_INFINITY;
    while (signals.length < total) {
      const f = await this.request(
        MSG.TELEM_SIGNALS,
        MSG.TELEM_SIGNALS,
        encodeTelemSignals(signals.length, pageSize),
        `TELEM_SIGNALS(${signals.length})`,
      );
      const page = decodeTelemSignals(f.payload);
      total = page.total;
      if (page.startIndex !== signals.length || page.signals.length === 0) {
        throw new Error('signal dictionary pagination stalled');
      }
      signals.push(...page.signals);
    }
    return signals;
  }

  async subscribeTelemetry(rateHz: number, signalIds: readonly number[]): Promise<TelemSubscription> {
    const f = await this.request(
      MSG.TELEM_SUBSCRIBE,
      MSG.TELEM_SUBSCRIBE,
      encodeTelemSubscribe(rateHz, signalIds),
      'TELEM_SUBSCRIBE',
    );
    return decodeTelemSubscribe(f.payload);
  }

  async configureScope(config: ScopeConfig): Promise<ScopeConfig> {
    const f = await this.request(
      MSG.SCOPE_CONFIG,
      MSG.SCOPE_CONFIG,
      encodeScopeConfig(config),
      'SCOPE_CONFIG',
    );
    return decodeScopeConfig(f.payload);
  }

  async armScope(): Promise<ScopeStatus> {
    const f = await this.request(
      MSG.SCOPE_ARM,
      MSG.SCOPE_STATUS,
      new Uint8Array(0),
      'SCOPE_ARM',
    );
    return decodeScopeStatus(f.payload);
  }

  async scopeStatus(): Promise<ScopeStatus> {
    const f = await this.request(
      MSG.SCOPE_STATUS,
      MSG.SCOPE_STATUS,
      new Uint8Array(0),
      'SCOPE_STATUS',
    );
    return decodeScopeStatus(f.payload);
  }

  async readScope(): Promise<number[][]> {
    const samples: number[][] = [];
    let total = Number.POSITIVE_INFINITY;
    while (samples.length < total) {
      const f = await this.request(
        MSG.SCOPE_READ,
        MSG.SCOPE_READ,
        encodeScopeRead(samples.length, 0xffff),
        `SCOPE_READ(${samples.length})`,
      );
      const chunk = decodeScopeRead(f.payload);
      total = chunk.total;
      if (chunk.start !== samples.length || chunk.samples.length === 0) {
        throw new Error('scope pagination stalled');
      }
      samples.push(...chunk.samples);
    }
    return samples;
  }

  async captureScope(config: ScopeConfig, timeoutMs = 3000): Promise<ScopeCapture> {
    const applied = await this.configureScope(config);
    let status = await this.armScope();
    const deadline = Date.now() + timeoutMs;
    while (status.state !== ScopeState.COMPLETE) {
      if (Date.now() >= deadline) throw new TimeoutError('scope capture', timeoutMs);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      status = await this.scopeStatus();
    }
    const samples = await this.readScope();
    return { config: applied, status, samples };
  }

  async enterBootloader(): Promise<void> {
    await this.request(MSG.BOOT_ENTER, MSG.BOOT_ENTER, new Uint8Array(0), 'BOOT_ENTER');
  }

  async bootInfo(): Promise<BootInfo> {
    const f = await this.request(MSG.BOOT_INFO, MSG.BOOT_INFO, new Uint8Array(0), 'BOOT_INFO');
    return decodeBootInfo(f.payload);
  }

  async bootErase(slot: number): Promise<void> {
    await this.request(MSG.BOOT_ERASE, MSG.BOOT_ERASE, encodeBootErase(slot), 'BOOT_ERASE', 15_000);
  }

  async bootWrite(slot: number, offset: number, data: Uint8Array): Promise<void> {
    const f = await this.request(
      MSG.BOOT_WRITE,
      MSG.BOOT_WRITE,
      encodeBootWrite(slot, offset, data),
      `BOOT_WRITE(${offset})`,
      3000,
    );
    const ack = decodeBootWriteAck(f.payload);
    if (ack.slot !== slot || ack.offset !== offset || ack.length !== data.length) {
      throw new Error('BOOT_WRITE acknowledgement mismatch');
    }
  }

  async bootVerify(slot: number, image: Uint8Array, version: string): Promise<void> {
    await this.request(
      MSG.BOOT_VERIFY,
      MSG.BOOT_VERIFY,
      encodeBootVerify(slot, image.length, crc32(image), version),
      'BOOT_VERIFY',
      15_000,
    );
  }

  async bootRollback(): Promise<void> {
    await this.request(MSG.BOOT_ROLLBACK, MSG.BOOT_ROLLBACK, new Uint8Array(0), 'BOOT_ROLLBACK');
  }

  async bootReboot(): Promise<void> {
    await this.request(MSG.BOOT_REBOOT, MSG.BOOT_REBOOT, new Uint8Array(0), 'BOOT_REBOOT');
  }

  async flashInactiveSlot(
    image: Uint8Array,
    version: string,
    onProgress?: (written: number, total: number) => void,
  ): Promise<number> {
    const info = await this.bootInfo();
    const slot = info.activeSlot === 1 ? 0 : 1;
    if (image.length < 8 || image.length > info.slots[slot]!.capacity) {
      throw new RangeError(`firmware image size ${image.length} is outside the inactive slot`);
    }
    await this.bootErase(slot);
    for (let offset = 0; offset < image.length; offset += 504) {
      const source = image.subarray(offset, Math.min(offset + 504, image.length));
      const padded = new Uint8Array(Math.ceil(source.length / 8) * 8).fill(0xff);
      padded.set(source);
      await this.bootWrite(slot, offset, padded);
      onProgress?.(Math.min(offset + source.length, image.length), image.length);
    }
    await this.bootVerify(slot, image, version);
    return slot;
  }

  /**
   * Envoie une ligne de console et attend la première réponse.
   *
   * La console n'a pas de numéro de séquence : la corrélation est purement temporelle. C'est
   * acceptable pour du diagnostic manuel, ça ne le serait pas pour du pilotage — d'où le
   * canal binaire pour tout le reste.
   */
  async console(line: string, timeoutMs = this.timeoutMs): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new TimeoutError(`console «${line}»`, timeoutMs));
      }, timeoutMs);

      const off = this.lineEmitter.on((text) => {
        clearTimeout(timer);
        off();
        resolve(text);
      });

      this.transport.write(new TextEncoder().encode(`${line}\r\n`)).catch((e: unknown) => {
        clearTimeout(timer);
        off();
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  /** Lecture confortable : rend les valeurs par nom, et lève si l'une a échoué. */
  async readByName(dict: ParamDictionary, names: readonly string[]): Promise<Map<string, number>> {
    const ids = names.map((n) => {
      const p = dict.get(n);
      if (p === undefined) throw new Error(`paramètre inconnu : ${n}`);
      return p.id;
    });

    const results = await this.readParams(ids);
    const out = new Map<string, number>();
    results.forEach((r, i) => {
      if (r.status !== ParamStatus.OK) {
        throw new Error(`${names[i]} : ${PARAM_STATUS_NAME[r.status] ?? r.status}`);
      }
      out.set(names[i]!, r.value);
    });
    return out;
  }
}

export interface ScopeCapture {
  config: ScopeConfig;
  status: ScopeStatus;
  samples: number[][];
}
