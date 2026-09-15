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
  decodeError,
  decodeParamDictEntry,
  decodeParamRead,
  decodeParamWrite,
  encodeHello,
  encodeParamDictGet,
  encodeParamRead,
  encodeParamWrite,
  ParamStatus,
  PARAM_STATUS_NAME,
  type ParamReadResult,
  type ParamWriteRequest,
  type ParamWriteResult,
} from './messages.js';
import { FrameStream, encodeFrame, type Frame } from './frame.js';
import { ParamDictionary, type ParamDesc } from './params.js';
import { MSG, FRAME_FLAG, type DeviceInfo } from './protocol.js';
import { Emitter, type Transport } from './transport.js';

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
        reject(new TimeoutError(label, this.timeoutMs));
      }, this.timeoutMs);

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
