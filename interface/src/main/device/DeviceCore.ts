/**
 * DeviceCore — l'unique détenteur du lien et de l'état du device.
 *
 * Le renderer ne touche jamais au port série : il passe par l'IPC, qui passe par ici. Ce
 * n'est pas une précaution de style. C'est ce qui garantit qu'il n'existe **qu'un seul
 * chemin d'exécution** vers la carte — celui de l'UI, celui de la CLI et celui du futur
 * serveur MCP sont le même. Un agent qui pilote le banc exerce donc exactement ce qu'un
 * humain déclenche, et le journal ci-dessous en garde la trace avec sa source.
 */

import { DeviceClient, ProtocolError, TimeoutError, type ScopeCapture } from '../../shared/client.js';
import {
  ParamStatus,
  PARAM_STATUS_NAME,
  type BootInfo,
  type TelemFrame,
} from '../../shared/messages.js';
import { ParamDictionary, clampToParam, paramDictHash } from '../../shared/params.js';
import {
  PROTO_CAP,
  ScopeTrigger,
  type DeviceInfo,
  type ScopeTriggerValue,
  type SignalDesc,
} from '../../shared/protocol.js';
import { SimulatedDevice, newSimFlash } from '../../shared/simulator.js';
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
  /** Abonnement télémétrie en cours, `null` si le flux est coupé. */
  telemetry: TelemetryState | null;
  /** Dernier état de sécurité lu sur la carte, `null` tant que rien n'a été lu. */
  safety: SafetyState | null;
  /** Dernier relevé de supervision, `null` tant que rien n'a été lu. */
  monitor: MonitorState | null;
  lastError: string | null;
}

/**
 * État de la barrière de sécurité du firmware, relu à chaque battement.
 *
 * Il figure dans le snapshot pour une raison précise : le firmware coupe le couple de
 * lui-même si le flux de commandes s'interrompt, et une interface qui n'afficherait pas
 * cette coupure laisserait croire à une panne. `latched` gouverne aussi ce qui est
 * possible — tant qu'il est vrai, la carte refuse toute réactivation.
 */
/**
 * Ce que la carte mesure sur elle-même — rails, référence, température, coût de la boucle.
 *
 * Rien ici n'est calculé par l'hôte : le firmware mesure `VREF+` au lieu de le supposer, et
 * tous les millivolts en dépendent. Une valeur absente vaut `null` plutôt que zéro, parce
 * qu'un zéro affiché sur un rail est une panne et non une absence de mesure.
 */
export interface MonitorState {
  /** Tours complets du tourniquet de mesure depuis le reset : dit que la carte vit. */
  rounds: number;
  /** `VREF+` réellement mesuré par VREFINT, en millivolts. */
  vrefMv: number;
  /**
   * Étendue de `VREF+` sur les derniers relevés, en pour mille de sa moyenne.
   *
   * Chaque relevé tombe à une phase quelconque de ce qui agite éventuellement la
   * référence, donc l'étendue sur une vingtaine de relevés en mesure l'enveloppe. Une
   * référence saine tient sous quelques pour mille ; au-delà, **toutes** les tensions de
   * cette carte sont fausses dans la même proportion, puisqu'elles sont toutes
   * ratiométriques d'elle. `null` tant qu'il n'y a pas assez de relevés pour conclure.
   */
  vrefSpreadPermille: number | null;
  vinMv: number;
  vmotMv: number;
  v5Mv: number;
  v3v3Mv: number;
  /** Entrées de courant en millivolts, relecture lente. */
  csaMv: [number, number, number];
  /** Jonction du MCU, en degrés. `null` si le firmware ne la publie pas encore. */
  mcuTempC: number | null;
  /** Coût de l'ISR en pour mille du budget d'une période PWM, et sa pire valeur. */
  loadPermille: number;
  isrLastNs: number;
  isrMaxNs: number;
  /** Passages de la boucle de contrôle depuis le reset. */
  ticks: number;
  /** Broche `nFAULT` du DRV8304 basse — une faute matérielle est présente. */
  drvFault: boolean;
  /** Fronts `nFAULT` comptés depuis le reset. */
  drvEvents: number;
}

export interface SafetyState {
  /** Cause de la dernière coupure, telle que le firmware la nomme. */
  reason: string;
  /** Faute verrouillée : il faut un acquittement explicite avant de réactiver. */
  latched: boolean;
  /** Sorties de puissance actives. */
  outputsLive: boolean;
  /** Coupures par le watchdog depuis le reset de la carte. */
  trips: number;
}

/**
 * Abonnement télémétrie en cours.
 *
 * Il figure dans le snapshot parce que le device n'en accepte qu'un seul : savoir à quoi
 * l'interface s'est abonnée, et à quelle cadence, fait partie de l'état partagé entre
 * l'humain et l'agent.
 */
export interface TelemetryState {
  /** Cadence **retenue par le firmware**, pas celle demandée. */
  rateHz: number;
  /** Noms des signaux, dans l'ordre des valeurs de chaque trame. */
  signalNames: string[];
  /** Unités, dans le même ordre — pour étiqueter un axe sans relire le dictionnaire. */
  units: string[];
}

/**
 * Où en est une mise à jour de firmware.
 *
 * Les phases ne sont pas décoratives : une mise à jour A/B passe par trois redémarrages, et
 * pendant les plus longues l'interface ne doit pas avoir l'air figée. Surtout, `rebooting` et
 * `confirming` sont les moments où la carte disparaît du bus — sans les nommer, une
 * déconnexion parfaitement normale se lirait comme une panne.
 */
export type FirmwarePhase =
  | 'entering'
  | 'erasing'
  | 'writing'
  | 'verifying'
  | 'rebooting'
  | 'confirming'
  | 'done'
  | 'failed';

export interface FirmwareProgress {
  phase: FirmwarePhase;
  /** Octets écrits et total, tous deux à 0 hors de la phase `writing`. */
  written: number;
  total: number;
  /** Slot visé, connu une fois `BOOT_INFO` lu. */
  slot: number | null;
  /** Une phrase destinée à l'écran, pas un code. */
  message: string;
}

export interface ConnectTarget {
  kind: 'serial' | 'simulator';
  path?: string;
}

/**
 * Demande de capture scope — docs/protocol.md §6.
 *
 * Les signaux sont désignés par nom, jamais par identifiant : l'appelant travaille avec le
 * dictionnaire que le firmware publie, pas avec une numérotation qu'il faudrait connaître.
 */
export interface ScopeRequest {
  /** 1 à 2048 points. Par défaut, la profondeur maximale. */
  depth?: number;
  /** 1 à 256. Un point conservé tous les N passages de la boucle 20 kHz. */
  decimation?: number;
  /** Points conservés avant le déclenchement, strictement inférieur à `depth`. */
  pretriggerSamples?: number;
  triggerMode?: ScopeTriggerValue;
  /** Doit faire partie de `signalNames` hors mode immédiat. */
  triggerSignalName?: string;
  threshold?: number;
  /** 1 à 4 noms. Par défaut, les quatre premiers signaux publiés. */
  signalNames?: readonly string[];
}

/** Période du battement, en millisecondes — voir `startHeartbeat`. */
const HEARTBEAT_MS = 80;

/** Période du relevé de supervision — voir `readMonitor`. */
const MONITOR_MS = 500;

/** Relevés gardés pour juger la référence : une douzaine de secondes. */
const VREF_WINDOW = 24;

/**
 * Au-delà de cette étendue, en pour mille, la référence n'en est plus une.
 *
 * Deux pour cent est large : un `VREF+` sain tient sous le pour mille, et le bruit de
 * conversion sur VREFINT en ajoute quelques-uns. Le seuil doit rester silencieux sur une
 * carte saine, parce qu'un avertissement qui se déclenche pour rien cesse d'être lu.
 */
const VREF_UNSTABLE_PERMILLE = 20;

/**
 * Lit la réponse de `SAFETY?`. Tolère les champs inconnus et l'ordre : la console du
 * firmware est un format `clé=valeur`, et une interface qui casserait sur un champ ajouté
 * obligerait à publier les deux côtés ensemble.
 */
function parseFields(reply: string): Map<string, string> | null {
  if (!reply.startsWith('OK')) return null;
  const f = new Map<string, string>();
  for (const tok of reply.slice(2).trim().split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq > 0) f.set(tok.slice(0, eq), tok.slice(eq + 1));
  }
  return f;
}

function parseSafety(reply: string): SafetyState | null {
  const f = parseFields(reply);
  if (f === null) return null;
  const reason = f.get('reason');
  if (reason === undefined) return null;
  return {
    reason,
    latched: f.get('latched') === '1',
    outputsLive: f.get('outputs') === '1',
    trips: Number(f.get('trips') ?? 0),
  };
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
  private safety: SafetyState | null = null;
  private monitor: MonitorState | null = null;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private monitorBusy = false;
  private vrefWindow: number[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private heartbeatBusy = false;
  private consoleChain: Promise<unknown> = Promise.resolve();
  private internalRequest = false;
  private lastError: string | null = null;
  private logSeq = 0;
  private telemetry: TelemetryState | null = null;
  private telemOff: (() => void) | null = null;
  /** Cible de la dernière connexion : une mise à jour doit savoir se rebrancher seule. */
  private target: ConnectTarget | null = null;
  /**
   * Flash de la carte simulée, pour toute la session.
   *
   * Une carte garde sa flash à travers une re-énumération USB. Sans cet objet partagé,
   * chaque reconnexion du simulateur repartirait d'une carte neuve et une mise à jour ne
   * pourrait jamais aboutir — ce qui rendrait la vue Firmware indémontrable hors matériel.
   */
  private readonly simFlash = newSimFlash();
  /** Mise à jour en cours. Deux en parallèle sur la même carte n'ont aucun sens. */
  private updating = false;

  readonly onChange = new Emitter<DeviceSnapshot>();
  readonly onLog = new Emitter<LogEntry>();
  /** Flux de télémétrie souscrit — une émission par trame reçue. */
  readonly onTelemetry = new Emitter<TelemFrame>();
  /** Avancement d'une mise à jour de firmware. */
  readonly onFirmware = new Emitter<FirmwareProgress>();

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
      safety: this.safety,
      monitor: this.monitor,
      telemetry: this.telemetry,
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
      this.target = target;
      this.transport =
        target.kind === 'simulator'
          ? new SimulatedDevice({ flash: this.simFlash })
          : await SerialTransport.open(target.path ?? '');

      this.client = new DeviceClient(this.transport, { timeoutMs: 1500 });
      // L'interface interroge la carte en permanence pour son propre compte — battement de
      // sécurité huit fois par seconde, relevé de supervision deux fois. Ces réponses-là
      // descendent en `debug` : au niveau `info` elles noient ce que l'opérateur a demandé,
      // et c'est exactement ce qui est arrivé. La sérialisation de `askConsole` rend le
      // drapeau exact — aucune autre réponse ne circule pendant qu'une requête interne est
      // en vol.
      this.client.onLine((text) =>
        this.log(this.internalRequest ? 'debug' : 'info', 'device', text));
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
      this.startHeartbeat();
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
    // Le flux ne reviendra pas tout seul : le dire dans l'état, plutôt que de laisser des
    // courbes figées passer pour des courbes plates.
    this.detachTelemetry();
    this.lastError = e.message;
    this.connection = 'error';
    this.log('error', 'device', `link lost: ${e.message}`);
    this.emitChange();
  }

  async disconnect(quiet = false): Promise<void> {
    this.stopHeartbeat();
    this.detachTelemetry();
    if (this.client !== null) {
      await this.client.close().catch(() => undefined);
    }
    this.client = null;
    this.transport = null;
    this.info = null;
    this.dict = null;
    this.values.clear();
    this.dictIntegrity = null;
    this.safety = null;
    this.monitor = null;
    this.vrefWindow = [];
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
  /**
   * Le device simulé, quand c'est lui qui est branché — sinon `null`.
   *
   * Ce n'est pas une porte dérobée : le simulateur est déjà entièrement accessible à
   * l'appelant, qui a choisi de s'y connecter. L'exposer permet aux tests de provoquer
   * côté device ce que seule la carte sait produire — une coupure de sécurité, par
   * exemple — au lieu de tester le `DeviceCore` contre lui-même.
   */
  get simulator(): SimulatedDevice | null {
    return this.transport instanceof SimulatedDevice ? this.transport : null;
  }

  /* ---------------------------------------------------------------- sécurité */

  /**
   * Le firmware coupe le couple si plus aucun message ne lui parvient pendant un court
   * délai (`safety.c`, règle §4.3 d'`AGENTS.md`). Ce battement est la moitié hôte de cette
   * règle : tant que l'interface est en vie, elle le prouve en parlant.
   *
   * Il interroge `SAFETY?` plutôt qu'un `PING` nu, pour deux raisons. Le message entretient
   * le flux dans les deux cas ; celui-ci rapporte en plus l'état de la barrière, donc une
   * coupure se voit dans l'interface au lieu de se deviner. Et une seule commande vaut mieux
   * que deux : elle ne peut pas rapporter un état pris à un autre instant que celui où elle
   * a prouvé que l'hôte était vivant.
   *
   * La période est un tiers du délai du firmware : deux battements peuvent se perdre sans
   * qu'une coupure survienne, et le troisième coupe. Si le processus principal se fige, le
   * minuteur s'arrête avec lui et la carte coupe — c'est exactement l'effet recherché.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => { void this.beat(); }, HEARTBEAT_MS);
    // Le battement ne doit pas retenir le processus au moment de quitter.
    this.heartbeat.unref?.();
    this.monitorTimer = setInterval(() => { void this.pollMonitor(); }, MONITOR_MS);
    this.monitorTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.monitorTimer !== null) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    this.heartbeatBusy = false;
    this.monitorBusy = false;
  }

  /**
   * Interroge la carte et met l'état à jour. Toujours une lecture réelle : répondre depuis
   * le cache à qui demande explicitement l'état de sécurité reviendrait à rapporter un
   * souvenir au moment précis où seule la situation présente compte.
   */
  async readSafety(): Promise<SafetyState> {
    const reply = await this.askConsole('SAFETY?', true);
    const next = parseSafety(reply);
    if (next === null) throw new Error(`unreadable safety status: ${reply}`);

    const prev = this.safety;
    this.safety = next;
    // Une coupure se dit une fois, au moment où elle arrive. Répéter la ligne à chaque
    // battement noierait le journal pendant que l'opérateur cherche la cause.
    if (next.latched && (prev === null || !prev.latched)) {
      this.log('error', 'device', `torque cut by the firmware: ${next.reason}`);
    }
    if (prev === null || prev.latched !== next.latched ||
        prev.reason !== next.reason || prev.outputsLive !== next.outputsLive) {
      this.emitChange();
    }
    return next;
  }

  /**
   * Relève ce que la carte mesure sur elle-même. Trois commandes, à cadence lente : ces
   * grandeurs sont thermiques ou continues, les rafraîchir plus vite ne montrerait que du
   * bruit de conversion et volerait de la bande au battement de sécurité.
   */
  async readMonitor(): Promise<MonitorState> {
    const sens = parseFields(await this.askConsole('SENS.ALL?', true));
    const stats = parseFields(await this.askConsole('STATS?', true));
    const drv = parseFields(await this.askConsole('DRV?', true));
    if (sens === null || stats === null || drv === null) {
      throw new Error('unreadable monitor reply');
    }

    const csa = (sens.get('csa_mv') ?? '').split(',').map(Number);
    const num = (m: Map<string, string>, k: string): number => Number(m.get(k) ?? 0);

    // Fenêtre glissante sur la référence. On ne moyenne rien pour l'affichage : lisser
    // rendrait le tableau de bord agréable et masquerait le défaut. On mesure l'agitation
    // et on la dit.
    const vref = num(sens, 'vref_mv');
    if (vref > 0) {
      this.vrefWindow = [...this.vrefWindow, vref].slice(-VREF_WINDOW);
    }
    const w = this.vrefWindow;
    const spread = w.length < VREF_WINDOW
      ? null
      : Math.round(((Math.max(...w) - Math.min(...w)) * 1000) / (w.reduce((a, b) => a + b, 0) / w.length));
    const next: MonitorState = {
      rounds: num(sens, 'rounds'),
      vrefMv: vref,
      vrefSpreadPermille: spread,
      vinMv: num(sens, 'vin_mv'),
      vmotMv: num(sens, 'vmot_mv'),
      v5Mv: num(sens, 'v5_mv'),
      v3v3Mv: num(sens, 'v3v3_mv'),
      csaMv: [csa[0] ?? 0, csa[1] ?? 0, csa[2] ?? 0],
      // Absent d'un firmware antérieur à la température : `null` se distingue de 0 °C.
      mcuTempC: sens.has('mcu_temp_c') ? num(sens, 'mcu_temp_c') : null,
      loadPermille: num(stats, 'load_pm'),
      isrLastNs: num(stats, 'last_ns'),
      isrMaxNs: num(stats, 'max_ns'),
      ticks: num(stats, 'ticks'),
      drvFault: sens.has('rounds') && drv.get('nfault') === '1',
      drvEvents: num(drv, 'events'),
    };

    const prev = this.monitor;
    this.monitor = next;
    if (next.drvFault && (prev === null || !prev.drvFault)) {
      this.log('error', 'device', 'DRV8304 nFAULT asserted');
    }
    // Dit une fois, à la bascule : c'est un défaut matériel, pas un événement récurrent.
    const wasUnstable = prev?.vrefSpreadPermille !== null
      && prev !== null && prev.vrefSpreadPermille! > VREF_UNSTABLE_PERMILLE;
    const isUnstable = spread !== null && spread > VREF_UNSTABLE_PERMILLE;
    if (isUnstable && !wasUnstable) {
      this.log('warn', 'device',
        `analog reference unstable: VREF+ spans ${(spread / 10).toFixed(1)} % — every voltage ` +
        'this board reports is scaled by it');
    }
    this.emitChange();
    return next;
  }

  private async pollMonitor(): Promise<void> {
    if (this.monitorBusy || this.client === null || this.connection !== 'connected') return;
    this.monitorBusy = true;
    try {
      await this.readMonitor();
    } catch {
      // Même raison que pour le battement : la perte de liaison a déjà son message.
    } finally {
      this.monitorBusy = false;
    }
  }

  private async beat(): Promise<void> {
    // Un battement en retard ne doit pas en empiler un second : c'est la liaison qui est
    // lente, et l'empilement la rendrait plus lente encore.
    if (this.heartbeatBusy || this.client === null || this.connection !== 'connected') return;
    this.heartbeatBusy = true;
    try {
      await this.readSafety();
    } catch {
      // Silencieux : `onLinkError` porte déjà la perte de liaison, et un battement raté
      // pendant une reconnexion n'est pas une information.
    } finally {
      this.heartbeatBusy = false;
    }
  }

  /**
   * Acquitte la faute verrouillée sur la carte. Le firmware refuse si la cause est encore
   * présente : l'échec est une réponse, pas une erreur de transport.
   */
  async clearFault(source: LogSource = 'gui'): Promise<boolean> {
    this.require();
    this.requireAiControl(source);
    const reply = await this.askConsole('FAULTCLR');
    const ok = reply.startsWith('OK');
    this.log(ok ? 'info' : 'warn', source,
      ok ? 'fault cleared' : `fault not cleared: ${reply}`);
    await this.beat();
    return ok;
  }

  /**
   * Barrière de pilotage par agent. Toute écriture d'origine `mcp` passe par ici, et par
   * ici seulement : la règle vaut pour n'importe quelle commande future, pas seulement
   * pour l'écriture de paramètre qui l'a introduite.
   */
  private requireAiControl(source: LogSource): void {
    if (source === 'mcp' && !this.aiControl) {
      throw new Error('AI control is off: enable it in the interface before driving from an agent');
    }
  }

  async writeParam(idOrName: number | string, value: number, source: LogSource = 'gui'): Promise<number> {
    const { client, dict } = this.require();
    const p = dict.get(idOrName);
    if (p === undefined) throw new Error(`unknown parameter: ${idOrName}`);

    this.requireAiControl(source);

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
    // Remettre tout le dictionnaire aux valeurs par défaut est une écriture, et la plus
    // large qui soit : elle est au moins aussi gated qu'une écriture unitaire.
    this.requireAiControl(source);
    await client.resetDefaults();
    this.log('info', source, 'parameters reset to defaults');
    await this.refreshValues();
  }

  /**
   * Accès sérialisé à la console.
   *
   * `DeviceClient.console()` se résout sur la **prochaine** ligne reçue, sans regarder
   * laquelle : deux appels en vol en même temps échangeraient leurs réponses. Tant que
   * seule une main tapait des commandes, le cas ne se présentait pas ; le battement de
   * sécurité interroge la carte huit fois par seconde, et le rend certain. Tout passe donc
   * par une file — y compris le battement, qui n'a aucun privilège.
   */
  private askConsole(line: string, internal = false): Promise<string> {
    const run = this.consoleChain.then(async () => {
      const { client } = this.require();
      this.internalRequest = internal;
      try {
        return await client.console(line);
      } finally {
        this.internalRequest = false;
      }
    });
    // La chaîne ne doit pas se rompre sur un échec : le suivant a le droit d'essayer.
    this.consoleChain = run.catch(() => undefined);
    return run;
  }

  async sendConsole(line: string, source: LogSource = 'gui'): Promise<string> {
    this.require();
    this.log('debug', source, `> ${line}`);
    return this.askConsole(line);
  }

  /** Console accessible aux agents : diagnostic en lecture et STOP uniquement. */
  async sendSafeConsole(line: string, source: LogSource = 'mcp'): Promise<string> {
    const verb = line.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? '';
    const allowed = new Set(['PING', 'INFO?', 'STATS?', 'LINK?', 'PROTO?', 'SELFTEST', 'PWM?',
      'DRV?', 'SENS.ALL?', 'SAFETY?', 'STOP']);
    if (!allowed.has(verb)) {
      throw new Error(`console command not allowed through MCP: ${verb || '(empty)'}`);
    }
    return this.sendConsole(line, source);
  }

  async readSignals(): Promise<SignalDesc[]> {
    const { client } = this.require();
    return client.readSignals();
  }

  /**
   * Résout des noms de signaux en descripteurs, depuis le dictionnaire du device.
   *
   * Sans nom, rend tout ce que le firmware publie. C'est le seul endroit où la
   * correspondance nom → identifiant se fait : ni l'UI, ni la CLI, ni un agent n'ont à
   * connaître la numérotation du protocole.
   */
  private async resolveSignals(names?: readonly string[]): Promise<SignalDesc[]> {
    const { client } = this.require();
    const available = await client.readSignals();
    if (names === undefined || names.length === 0) return available;
    return names.map((name) => {
      const signal = available.find((candidate) => candidate.name === name);
      if (signal === undefined) throw new Error(`unknown signal: ${name}`);
      return signal;
    });
  }

  private assertTelemetrySelection(selected: readonly SignalDesc[]): void {
    if (selected.length === 0) {
      throw new Error('telemetry needs at least one signal');
    }
    if (selected.length > 16 || new Set(selected.map((s) => s.id)).size !== selected.length) {
      throw new Error('telemetry accepts 1 to 16 unique signals');
    }
  }

  /** Coupe l'écoute locale sans toucher au device. Utilisé avant de réécrire l'abonnement. */
  private detachTelemetry(): void {
    if (this.telemOff !== null) {
      this.telemOff();
      this.telemOff = null;
    }
    this.telemetry = null;
  }

  /**
   * Ouvre un flux de télémétrie **qui dure**, et pousse chaque trame sur `onTelemetry`.
   *
   * C'est ce qui alimente les courbes temps réel. À ne pas confondre avec
   * `sampleTelemetry`, qui prend un burst et referme derrière lui.
   *
   * Le device n'accepte **qu'un seul abonnement**. Il est donc détenu ici, et publié dans
   * le snapshot : deux consommateurs qui s'abonneraient chacun de leur côté se
   * décrocheraient mutuellement sans que rien ne le dise.
   */
  async startTelemetry(signalNames?: readonly string[], rateHz = 200): Promise<TelemetryState> {
    const { client } = this.require();
    const selected = await this.resolveSignals(signalNames);
    this.assertTelemetrySelection(selected);

    this.detachTelemetry();
    const applied = await client.subscribeTelemetry(rateHz, selected.map((s) => s.id));
    this.telemOff = client.onTelemetry((frame) => this.onTelemetry.emit(frame));
    this.telemetry = {
      rateHz: applied.rateHz,
      signalNames: selected.map((s) => s.name),
      units: selected.map((s) => s.unit),
    };

    // Le firmware choisit un diviseur entier de la boucle 20 kHz : la cadence retenue
    // n'est pas toujours celle demandée, et c'est la retenue qu'on journalise.
    this.log('info', 'gui', `telemetry on: ${selected.length} signal(s) at ${applied.rateHz} Hz`);
    this.emitChange();
    return this.telemetry;
  }

  async stopTelemetry(): Promise<void> {
    const wasOn = this.telemetry !== null;
    this.detachTelemetry();
    const { client } = this.require();
    await client.subscribeTelemetry(0, []);
    if (wasOn) {
      this.log('info', 'gui', 'telemetry off');
      this.emitChange();
    }
  }

  get telemetryState(): TelemetryState | null {
    return this.telemetry;
  }

  /**
   * Prend un burst court et referme derrière lui. Sert la CLI et les agents, pas les
   * courbes temps réel.
   *
   * S'il y avait un flux en cours, il est **interrompu puis rétabli** : le device n'a
   * qu'un seul abonnement, et le burst doit pouvoir demander d'autres signaux ou une autre
   * cadence. L'interruption passe par le journal plutôt que de faire décrocher les courbes
   * de l'interface sans explication.
   */
  async sampleTelemetry(
    frames = 20,
    rateHz = 100,
    signalNames?: readonly string[],
    source: LogSource = 'gui',
  ): Promise<{ signals: SignalDesc[]; frames: TelemFrame[]; rateHz: number }> {
    const { client } = this.require();
    const selected = await this.resolveSignals(signalNames);
    this.assertTelemetrySelection(selected);

    const previous = this.telemetry;
    if (previous !== null) {
      this.log('info', 'gui', 'live telemetry paused for a burst sample');
    }
    this.detachTelemetry();

    const received: TelemFrame[] = [];
    let resolveDone = (): void => undefined;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const timer = setTimeout(() => resolveDone(), 5000);
    const off = client.onTelemetry((frame) => {
        received.push(frame);
        if (received.length >= frames) {
          clearTimeout(timer);
          resolveDone();
        }
    });
    let applied: { rateHz: number } | undefined;
    try {
      applied = await client.subscribeTelemetry(rateHz, selected.map((s) => s.id));
      await done;
    } finally {
      clearTimeout(timer);
      off();
      if (previous === null) {
        await client.subscribeTelemetry(0, []).catch(() => undefined);
      } else {
        // Rétablir exactement ce qui tournait avant, y compris la cadence retenue.
        await this.startTelemetry(previous.signalNames, previous.rateHz).catch((e: unknown) => {
          this.log('warn', 'gui', `could not restore live telemetry: ${describe(e)}`);
        });
      }
    }
    if (received.length < frames) {
      throw new TimeoutError(`telemetry sample (${received.length}/${frames})`, 5000);
    }
    this.log('info', source, `sampled ${received.length} telemetry frames at ${applied.rateHz} Hz`);
    return { signals: selected, frames: received, rateHz: applied.rateHz };
  }

  /**
   * Capture demandée par l'UI, la CLI ou un agent.
   *
   * Les signaux se désignent **par nom** et non par identifiant : c'est le dictionnaire du
   * firmware qui fait foi, et un appelant n'a pas à connaître la numérotation. La
   * résolution nom → id se fait ici, une fois.
   *
   * Tout est optionnel et le défaut est une capture immédiate pleine profondeur, ce qui
   * correspond à « montre-moi ce qui se passe ». Le déclenchement sur seuil n'a de sens
   * qu'à partir du moment où quelque chose peut provoquer un transitoire — c'est-à-dire à
   * M3 — mais la forme doit être là avant, sinon l'UI se construit autour d'un scope
   * bridé.
   */
  async captureScope(
    req: ScopeRequest = {},
    source: LogSource = 'gui',
  ): Promise<{ signals: SignalDesc[]; capture: ScopeCapture }> {
    const { client } = this.require();
    const available = await client.readSignals();
    const names = req.signalNames;
    const selected = names === undefined || names.length === 0
      ? available.slice(0, 4)
      : names.map((name) => {
          const signal = available.find((candidate) => candidate.name === name);
          if (signal === undefined) throw new Error(`unknown signal: ${name}`);
          return signal;
        });
    if (selected.length < 1 || selected.length > 4 ||
        new Set(selected.map((s) => s.id)).size !== selected.length) {
      throw new Error('scope accepts 1 to 4 unique signals');
    }

    const triggerMode = req.triggerMode ?? ScopeTrigger.IMMEDIATE;
    // Hors mode immédiat, le signal de déclenchement doit faire partie de la capture :
    // sinon le point de déclenchement n'apparaîtrait sur aucune des courbes tracées, et le
    // firmware refuserait la configuration de toute façon.
    const triggerName = req.triggerSignalName;
    const trigger = triggerName === undefined
      ? selected[0]!
      : selected.find((s) => s.name === triggerName);
    if (trigger === undefined) {
      throw new Error(`trigger signal must be one of the captured signals: ${triggerName}`);
    }

    const depth = req.depth ?? 2048;
    const pretriggerSamples = req.pretriggerSamples ?? 0;
    if (pretriggerSamples >= depth) {
      throw new Error(`pretrigger must be below depth (${pretriggerSamples} >= ${depth})`);
    }

    const capture = await client.captureScope({
      depth,
      decimation: req.decimation ?? 1,
      pretriggerSamples,
      triggerMode,
      triggerSignalId: trigger.id,
      threshold: req.threshold ?? 0,
      signalIds: selected.map((s) => s.id),
    });
    // La source est celle de l'appelant, jamais une constante : une capture lancee depuis
    // l'interface s'affichait comme une action d'agent. Le journal sert precisement a
    // distinguer qui a fait quoi — le figer a `mcp` le vidait de son sens.
    this.log(
      'info',
      source,
      `captured ${capture.samples.length} scope points on ${selected.map((s) => s.name).join(', ')}`,
    );
    return { signals: selected, capture };
  }

  /* ---------------------------------------------------------------- firmware */

  /** Lit l'état des deux slots. La carte doit déjà être en bootloader. */
  private async bootInfo(client: DeviceClient): Promise<BootInfo> {
    return client.bootInfo();
  }

  /**
   * Rebranche le câble et attend que la carte réponde.
   *
   * Une mise à jour A/B traverse trois re-énumérations USB : le port disparaît puis
   * revient, et la fenêtre est trop courte pour être devinée. On réessaie donc jusqu'à
   * `timeoutMs` plutôt que d'attendre un délai fixe, qui serait tantôt trop long tantôt
   * trop court selon la machine.
   */
  private async reattach<T>(
    probe: (client: DeviceClient) => Promise<T>,
    timeoutMs = 15_000,
  ): Promise<DeviceClient> {
    const t = this.target;
    if (t === null) throw new Error('no device connected');
    const deadline = Date.now() + timeoutMs;
    let last: unknown = null;

    for (;;) {
      let client: DeviceClient | null = null;
      try {
        const transport =
          t.kind === 'simulator'
            ? new SimulatedDevice({ flash: this.simFlash })
            : await SerialTransport.open(t.path ?? '');
        client = new DeviceClient(transport, { timeoutMs: 2000 });
        await probe(client);
        return client;
      } catch (e) {
        last = e;
        await client?.close().catch(() => undefined);
        if (Date.now() >= deadline) {
          throw new Error(`device did not come back: ${describe(last)}`);
        }
        await delay(t.kind === 'simulator' ? 1 : 250);
      }
    }
  }

  private emitFirmware(
    phase: FirmwarePhase,
    message: string,
    slot: number | null = null,
    written = 0,
    total = 0,
  ): void {
    this.onFirmware.emit({ phase, message, slot, written, total });
  }

  /**
   * Écrit une image dans le slot inactif et mène la probation jusqu'au bout.
   *
   * Reprend la séquence de `npm run cli -- firmware-update`, qui est la seule à avoir été
   * éprouvée de bout en bout. Ce n'est pas une réimplémentation : les deux appellent
   * `flashInactiveSlot()`, et ce qui diffère n'est que la façon de rendre compte.
   *
   * **Jamais depuis un agent.** Le paramètre `source` n'est pas là pour être filtré par
   * l'interrupteur de pilotage : écrire un firmware est refusé à `mcp` quoi qu'il arrive.
   * Le pire qu'un réglage mal choisi puisse faire est de mal asservir un moteur ; une image
   * fausse rend la carte muette, et la sortir de là demande une sonde et un tournevis. Ce
   * n'est pas une décision qui se délègue.
   */
  async updateFirmware(
    image: Uint8Array,
    version: string,
    source: LogSource = 'gui',
  ): Promise<{ slot: number; committed: boolean }> {
    if (source === 'mcp') {
      throw new Error('firmware updates cannot be driven by an agent; use the interface');
    }
    if (this.updating) {
      throw new Error('a firmware update is already running');
    }
    const { client } = this.require();
    const info = this.info;
    if (info === null) throw new Error('no device connected');
    if ((info.capabilities & PROTO_CAP.BOOTLOADER) === 0) {
      throw new Error('this firmware does not announce a bootloader');
    }
    if (image.length < 8) {
      throw new Error('firmware image is too small to carry a vector table');
    }

    this.updating = true;
    const sim = this.target?.kind === 'simulator';
    const settle = (ms: number): Promise<void> => delay(sim ? 1 : ms);

    try {
      // La télémétrie ne survivrait pas aux redémarrages, et un flux qui se tait sans
      // explication se lit comme une panne. On le coupe franchement.
      this.detachTelemetry();

      this.emitFirmware('entering', 'entering the bootloader');
      this.log('info', source, `firmware update: ${image.length} bytes, version ${version}`);
      await client.enterBootloader();
      await this.disconnect(true);
      await settle(750);

      const boot = await this.reattach((c) => c.bootInfo());
      let slot: number;
      try {
        const before = await this.bootInfo(boot);
        slot = before.activeSlot === 1 ? 0 : 1;
        const name = slot === 0 ? 'A' : 'B';

        this.emitFirmware('erasing', `erasing slot ${name}`, slot);
        slot = await boot.flashInactiveSlot(image, version, (written, total) => {
          this.emitFirmware('writing', `writing slot ${name}`, slot, written, total);
        });

        this.emitFirmware('verifying', `verifying slot ${name}`, slot);
        const staged = await this.bootInfo(boot);
        const meta = staged.slots[slot];
        if (staged.candidateSlot !== slot || meta === undefined || !meta.valid) {
          throw new Error(`slot ${name} was written but not accepted as a candidate`);
        }
        this.log('info', source, `slot ${name} verified, crc ${hex(meta.crc32)}`);

        this.emitFirmware('rebooting', 'restarting on the candidate', slot);
        await boot.bootReboot();
      } finally {
        await boot.close().catch(() => undefined);
      }

      // Le candidat démarre, tient sa probation, écrit sa confirmation et redémarre une
      // seconde fois. Se rattacher trop tôt prendrait sa première énumération — celle qui
      // n'a encore rien prouvé — pour un succès.
      this.emitFirmware('confirming', 'waiting for the candidate to confirm', slot);
      await settle(4000);
      const app = await this.reattach((c) => c.hello());
      await app.close().catch(() => undefined);

      // Vérifier que la promotion a bien eu lieu demande de repasser par le bootloader :
      // c'est lui qui détient les métadonnées, et c'est le seul moyen de distinguer un
      // candidat promu d'un rollback silencieux qui aurait tout remis comme avant.
      const check = await this.reattach((c) => c.hello());
      await check.enterBootloader();
      await check.close().catch(() => undefined);
      await settle(750);

      const audit = await this.reattach((c) => c.bootInfo());
      let committed = false;
      try {
        const after = await this.bootInfo(audit);
        committed = after.activeSlot === slot && after.candidateSlot === 0xff;
        this.log(
          committed ? 'info' : 'error',
          source,
          committed
            ? `firmware update committed on slot ${slot === 0 ? 'A' : 'B'}`
            : `probation not committed: the board rolled back to slot ${
                after.activeSlot === 0 ? 'A' : 'B'
              }`,
        );
        await audit.bootReboot();
      } finally {
        await audit.close().catch(() => undefined);
      }
      await settle(750);

      // Revenir à l'état où l'utilisateur nous a trouvés : connecté à l'application.
      const t = this.target;
      if (t !== null) await this.connect(t);

      this.emitFirmware(
        committed ? 'done' : 'failed',
        committed
          ? `slot ${slot === 0 ? 'A' : 'B'} is now active`
          : 'the candidate did not confirm; the board rolled back',
        slot,
      );
      return { slot, committed };
    } catch (e) {
      const why = describe(e);
      this.log('error', source, `firmware update failed: ${why}`);
      this.emitFirmware('failed', why);
      // Une mise à jour interrompue laisse la carte quelque part entre deux états. Se
      // reconnecter est ce qui permet de voir où, plutôt que de laisser l'interface
      // afficher le dernier état connu comme s'il était toujours vrai.
      const t = this.target;
      if (t !== null) await this.connect(t).catch(() => undefined);
      throw e;
    } finally {
      this.updating = false;
    }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
