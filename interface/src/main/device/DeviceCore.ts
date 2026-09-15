/**
 * DeviceCore — l'unique détenteur du lien et de l'état du device.
 *
 * Le renderer ne touche jamais au port série : il passe par l'IPC, qui passe par ici. Ce
 * n'est pas une précaution de style. C'est ce qui garantit qu'il n'existe **qu'un seul
 * chemin d'exécution** vers la carte — celui de l'UI, celui de la CLI et celui du futur
 * serveur MCP sont le même. Un agent qui pilote le banc exerce donc exactement ce qu'un
 * humain déclenche, et le journal ci-dessous en garde la trace avec sa source.
 */

import { DeviceClient, ProtocolError, TimeoutError } from '../../shared/client.js';
import { ParamStatus, PARAM_STATUS_NAME } from '../../shared/messages.js';
import { ParamDictionary, clampToParam, paramDictHash } from '../../shared/params.js';
import type { DeviceInfo } from '../../shared/protocol.js';
import { SimulatedDevice } from '../../shared/simulator.js';
import { Emitter, type Transport } from '../../shared/transport.js';
import { SerialTransport, listSerialPorts, type SerialPortInfo } from '../../node/serial.js';

export type LogSource = 'device' | 'gui' | 'mcp';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  at: number;
  level: LogLevel;
  source: LogSource;
  text: string;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface DeviceSnapshot {
  connection: ConnectionState;
  portDescription: string | null;
  info: DeviceInfo | null;
  /** Vrai si le hash recalculé sur les entrées reçues correspond au handshake. */
  dictIntegrity: boolean | null;
  params: Array<{
    id: number;
    name: string;
    unit: string;
    group: string;
    type: number;
    flags: number;
    min: number;
    max: number;
    def: number;
    value: number | null;
    status: number;
  }>;
  /** Pilotage par un agent — voir `setAiControl`. */
  aiControl: boolean;
  lastError: string | null;
}

export interface ConnectTarget {
  kind: 'serial' | 'simulator';
  path?: string;
}

export class DeviceCore {
  private transport: Transport | null = null;
  private client: DeviceClient | null = null;
  private info: DeviceInfo | null = null;
  private dict: ParamDictionary | null = null;
  private values = new Map<number, { value: number; status: number }>();
  private connection: ConnectionState = 'disconnected';
  private dictIntegrity: boolean | null = null;
  private aiControl = false;
  private lastError: string | null = null;
  private logSeq = 0;

  readonly onChange = new Emitter<DeviceSnapshot>();
  readonly onLog = new Emitter<LogEntry>();

  /* ---------------------------------------------------------------- journal */

  log(level: LogLevel, source: LogSource, text: string): void {
    const entry: LogEntry = { id: ++this.logSeq, at: Date.now(), level, source, text };
    this.onLog.emit(entry);
  }

  private emitChange(): void {
    this.onChange.emit(this.snapshot());
  }

  snapshot(): DeviceSnapshot {
    return {
      connection: this.connection,
      portDescription: this.transport?.description ?? null,
      info: this.info,
      dictIntegrity: this.dictIntegrity,
      params:
        this.dict?.entries.map((p) => {
          const v = this.values.get(p.id);
          return {
            id: p.id,
            name: p.name,
            unit: p.unit,
            group: p.group,
            type: p.type,
            flags: p.flags,
            min: p.min,
            max: p.max,
            def: p.def,
            value: v?.status === ParamStatus.OK ? v.value : null,
            status: v?.status ?? ParamStatus.ERR_ID,
          };
        }) ?? [],
      aiControl: this.aiControl,
      lastError: this.lastError,
    };
  }

  /* ---------------------------------------------------------------- connexion */

  async listPorts(): Promise<SerialPortInfo[]> {
    return listSerialPorts();
  }

  async connect(target: ConnectTarget): Promise<void> {
    await this.disconnect();

    this.connection = 'connecting';
    this.lastError = null;
    this.emitChange();

    try {
      this.transport =
        target.kind === 'simulator'
          ? new SimulatedDevice()
          : await SerialTransport.open(target.path ?? '');

      this.client = new DeviceClient(this.transport, { timeoutMs: 1500 });
      this.client.onLine((text) => this.log('info', 'device', text));
      this.client.onLinkError((e) => this.onLinkLost(e));

      this.log('info', 'gui', `connecting to ${this.transport.description}`);

      this.info = await this.client.hello();
      this.log(
        'info',
        'device',
        `${this.info.product} ${this.info.fwVersion}, protocol ${this.info.protocolMajor}.${this.info.protocolMinor}`,
      );

      this.dict = await this.client.readDictionary();

      // Le hash recalculé sur ce qui a été reçu doit retomber sur celui du handshake :
      // c'est un contrôle d'intégrité du transfert, pas une formalité.
      const recomputed = paramDictHash(this.dict.entries);
      this.dictIntegrity = recomputed === this.info.paramDictHash;
      if (!this.dictIntegrity) {
        this.log(
          'error',
          'gui',
          `dictionary hash mismatch: announced ${hex(this.info.paramDictHash)}, ` +
            `recomputed ${hex(recomputed)}`,
        );
      } else {
        this.log('info', 'gui', `dictionary: ${this.dict.size} parameters, hash ${hex(recomputed)}`);
      }

      await this.refreshValues();
      this.connection = 'connected';
      this.emitChange();
    } catch (e) {
      this.lastError = describe(e);
      this.connection = 'error';
      this.log('error', 'gui', `connection failed: ${this.lastError}`);
      await this.disconnect(true);
      this.connection = 'error';
      this.emitChange();
      throw e;
    }
  }

  private onLinkLost(e: Error): void {
    if (this.connection === 'disconnected') return;
    this.lastError = e.message;
    this.connection = 'error';
    this.log('error', 'device', `link lost: ${e.message}`);
    this.emitChange();
  }

  async disconnect(quiet = false): Promise<void> {
    if (this.client !== null) {
      await this.client.close().catch(() => undefined);
    }
    this.client = null;
    this.transport = null;
    this.info = null;
    this.dict = null;
    this.values.clear();
    this.dictIntegrity = null;
    this.connection = 'disconnected';
    if (!quiet) {
      this.log('info', 'gui', 'disconnected');
      this.emitChange();
    }
  }

  /* ---------------------------------------------------------------- paramètres */

  private require(): { client: DeviceClient; dict: ParamDictionary } {
    if (this.client === null || this.dict === null) {
      throw new Error('no device connected');
    }
    return { client: this.client, dict: this.dict };
  }

  async refreshValues(): Promise<void> {
    const { client, dict } = this.require();
    // Le firmware plafonne à 72 identifiants par lecture ; on découpe sans y penser.
    const ids = dict.entries.map((p) => p.id);
    for (let i = 0; i < ids.length; i += 64) {
      for (const r of await client.readParams(ids.slice(i, i + 64))) {
        this.values.set(r.id, { value: r.value, status: r.status });
      }
    }
    this.emitChange();
  }

  /**
   * Écrit un paramètre, puis le relit.
   *
   * La relecture n'est pas une précaution superflue : le firmware arrondit vers le type réel
   * du paramètre, donc la valeur retenue n'est pas toujours celle qui a été envoyée. Afficher
   * ce qui a été demandé plutôt que ce qui a été retenu est précisément le genre de mensonge
   * qui fait régler un régulateur à l'aveugle.
   */
  async writeParam(idOrName: number | string, value: number, source: LogSource = 'gui'): Promise<number> {
    const { client, dict } = this.require();
    const p = dict.get(idOrName);
    if (p === undefined) throw new Error(`unknown parameter: ${idOrName}`);

    if (source === 'mcp' && !this.aiControl) {
      throw new Error('AI control is off: enable it in the interface before driving from an agent');
    }

    const clamped = clampToParam(p, value);
    const [res] = await client.writeParams([{ id: p.id, value: clamped }]);
    if (res === undefined || res.status !== ParamStatus.OK) {
      const reason = PARAM_STATUS_NAME[res?.status ?? 1] ?? 'unknown';
      this.log('warn', source, `${p.name} rejected: ${reason}`);
      throw new Error(`write rejected: ${reason}`);
    }

    const [after] = await client.readParams([p.id]);
    if (after !== undefined) {
      this.values.set(after.id, { value: after.value, status: after.status });
    }
    this.log('info', source, `${p.name} = ${after?.value ?? clamped} ${p.unit}`.trimEnd());
    this.emitChange();
    return after?.value ?? clamped;
  }

  async resetDefaults(source: LogSource = 'gui'): Promise<void> {
    const { client } = this.require();
    await client.resetDefaults();
    this.log('info', source, 'parameters reset to defaults');
    await this.refreshValues();
  }

  async sendConsole(line: string, source: LogSource = 'gui'): Promise<string> {
    const { client } = this.require();
    this.log('debug', source, `> ${line}`);
    return client.console(line);
  }

  /* ---------------------------------------------------------------- pilotage agent */

  /**
   * Autorise ou interdit le pilotage par un agent.
   *
   * L'interrupteur vit ici et non dans le renderer : c'est le DeviceCore qui refuse, donc
   * la barrière tient même si quelqu'un contourne l'UI. Elle ne remplace pas les limites du
   * firmware, qui restent les seules garanties matérielles — elle décide seulement si une
   * commande d'origine agent a le droit d'être émise.
   */
  setAiControl(enabled: boolean): void {
    if (this.aiControl === enabled) return;
    this.aiControl = enabled;
    this.log('warn', 'gui', `AI control ${enabled ? 'ENABLED' : 'disabled'}`);
    this.emitChange();
  }

  get isAiControlEnabled(): boolean {
    return this.aiControl;
  }
}

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(8, '0');
}

function describe(e: unknown): string {
  if (e instanceof ProtocolError) return `firmware rejected: ${e.message}`;
  if (e instanceof TimeoutError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
