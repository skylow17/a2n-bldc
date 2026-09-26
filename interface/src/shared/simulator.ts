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
import { crc16, crc32 } from './crc16.js';
import { MSG, FRAME_FLAG, PROTO_ERR } from './protocol.js';
import {
  PROTO_CAP,
  ScopeState,
  ScopeTrigger,
  type SignalDesc,
} from './protocol.js';
import {
  PARAM_ENTRY_WIRE_LEN,
  paramDictHash,
  writeParamEntry,
  type ParamDesc,
  type ParamTypeValue,
} from './params.js';
import {
  ParamStatus,
  decodeScopeConfig,
  decodeTelemSubscribe,
  encodeScopeConfig,
  type ScopeConfig,
  type TelemSubscription,
} from './messages.js';
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
  'board.vref_mv': 3300,
  'pwm.freq_hz': 20_000,
  'pwm.arr': 3599,
  'pwm.deadtime_ns': 500,
  'pwm.ccr4_trig': 3579,
};

export const DEFAULT_SIM_SIGNALS: readonly SignalDesc[] = [
  { id: 1, type: 6, flags: 0, name: 'current.raw_ia_count', unit: 'count' },
  { id: 2, type: 6, flags: 0, name: 'current.raw_ib_count', unit: 'count' },
  { id: 3, type: 6, flags: 0, name: 'current.raw_ic_count', unit: 'count' },
  { id: 4, type: 6, flags: 0, name: 'loop.duration_ns', unit: 'ns' },
  { id: 5, type: 6, flags: 0, name: 'loop.max_duration_ns', unit: 'ns' },
  { id: 6, type: 6, flags: 0, name: 'loop.load_pct', unit: '%' },
];

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
  /**
   * Flash persistante à réutiliser. Omettre revient à prendre une carte neuve ; passer le
   * même objet à plusieurs transports simule plusieurs branchements de la même carte, ce
   * qu'une mise à jour A/B traverse trois fois.
   */
  flash?: SimFlash;
  /**
   * Ce que fait l'image candidate pendant sa probation.
   *
   * `confirm` est le chemin nominal. `fail` modélise `Boot/Test/trial_fail.s` : l'image
   * démarre et ne confirme jamais, ce qui doit produire un rollback au démarrage suivant.
   * C'est le seul moyen d'éprouver ce chemin sans carte.
   */
  trialOutcome?: 'confirm' | 'fail';
}

/**
 * Partie non volatile de la carte simulée : les deux slots, leurs métadonnées, et où en est
 * la séquence A/B. Un appelant qui veut simuler plusieurs branchements de la **même** carte
 * partage cet objet entre les transports successifs ; en créer un nouveau revient à prendre
 * une carte neuve.
 */
export interface SimFlash {
  activeSlot: number;
  candidateSlot: number;
  /** Le candidat a déjà été essayé : le prochain démarrage sans confirmation le rejette. */
  candidateAttempted: boolean;
  /** L'image qui va s'exécuter est en probation et doit confirmer. */
  trialPending: boolean;
  slots: Uint8Array[];
  meta: { imageSize: number; crc32: number; valid: boolean; version: string }[];
}

export function newSimFlash(): SimFlash {
  return {
    activeSlot: 0,
    candidateSlot: 0xff,
    candidateAttempted: false,
    trialPending: false,
    slots: [new Uint8Array(224 * 1024).fill(0xff), new Uint8Array(224 * 1024).fill(0xff)],
    meta: [
      { imageSize: 0, crc32: 0, valid: false, version: '' },
      { imageSize: 0, crc32: 0, valid: false, version: '' },
    ],
  };
}

export class SimulatedDevice implements Transport {
  private readonly dataEmitter = new Emitter<Uint8Array>();
  private readonly errorEmitter = new Emitter<Error>();
  private readonly stream = new FrameStream();
  private readonly values = new Map<number, number>();
  /** Ce que `PARAM_SAVE_NVM` a écrit : l'équivalent de la flash, pour la durée du simulateur. */
  private readonly nvm = new Map<number, number>();
  private nvmSeq = 0;
  private readonly params: readonly ParamDesc[];
  private readonly dictHash: number;
  private readonly opts: Required<SimulatorOptions>;
  private open = true;
  private rxFrames = 0;
  private rxErrors = 0;
  private pwmEnabled = false;
  private safetyReason: string = 'ok';
  private safetyLatched = false;
  private safetyTrips = 0;
  private sensRounds = 0;
  private encReads = 0;
  private encMagnet = true;
  private pushSeq = 0;
  private telemSeq = 0;
  private telemTimer: ReturnType<typeof setInterval> | null = null;
  private telem: TelemSubscription = { rateHz: 0, signalIds: [] };
  private scopeConfig: ScopeConfig = {
    depth: 2048,
    decimation: 1,
    pretriggerSamples: 0,
    triggerMode: ScopeTrigger.IMMEDIATE,
    triggerSignalId: 1,
    threshold: 0,
    signalIds: [1, 2, 3],
  };
  private scopeSamples: number[][] = [];
  private scopeStartedUs = 0;
  /**
   * Ce qui survit à une reconnexion, comme la flash d'une vraie carte.
   *
   * Sans ça, chaque `new SimulatedDevice()` repartait d'une carte sortie d'usine — or une
   * mise à jour A/B se déroule justement à travers trois reconnexions. Le chemin d'écriture
   * était donc intestable : tout ce qu'on venait d'écrire disparaissait au moment précis où
   * il aurait fallu le relire.
   */
  private readonly flash: SimFlash;
  /** Effacements de la session courante : volatil, un reset les oublie. Comme le firmware. */
  private bootErased = new Set<number>();

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
      flash: options.flash ?? newSimFlash(),
      trialOutcome: options.trialOutcome ?? 'confirm',
    };
    this.flash = this.opts.flash;
    // Pas d'appel a onPowerUp() ici : construire un transport, c'est brancher un cable, pas
    // appuyer sur reset. Une vraie carte traverse une re-enumeration USB sans redemarrer —
    // et c'est vital pour la probation, dont la marque "essaye" est justement ce qui
    // declenche le rollback au demarrage SUIVANT. Confondre les deux faisait echouer toute
    // mise a jour a la premiere reconnexion.
    this.dictHash = paramDictHash(this.params);
    this.resetValues();
  }

  /**
   * Ce que fait le bootloader au démarrage, modélisé d'après `Boot/Src/boot_flash.c`.
   *
   * L'ordre est celui du firmware, et il compte : la marque « essayé » est posée **avant**
   * que le candidat ne s'exécute. Un candidat qui ne confirme pas est donc abandonné au
   * démarrage suivant, sans qu'il ait eu à signaler quoi que ce soit — c'est le rollback
   * automatique, et il repose sur l'absence d'un message, jamais sur sa présence.
   */
  private onPowerUp(): void {
    const f = this.flash;
    if (f.candidateSlot === 0xff || !f.meta[f.candidateSlot]?.valid) {
      f.candidateSlot = 0xff;
      f.candidateAttempted = false;
      f.trialPending = false;
      return;
    }
    if (!f.candidateAttempted) {
      f.candidateAttempted = true;
      f.trialPending = true;
      return;
    }
    // Deuxième passage sans confirmation entre-temps : l'essai a échoué. L'image reste
    // valide en flash — un rollback choisit, il ne détruit pas.
    f.candidateSlot = 0xff;
    f.candidateAttempted = false;
    f.trialPending = false;
  }

  /**
   * L'application candidate atteint son point de santé et confirme.
   *
   * Déclenché au premier `HELLO` : côté carte, la confirmation vient de la superloop une
   * fois la boucle temps réel prouvée vivante, et `HELLO` est le premier signe équivalent
   * qu'un hôte puisse observer ici.
   */
  private confirmTrialIfAny(): void {
    const f = this.flash;
    if (!f.trialPending) return;
    f.trialPending = false;
    if (this.opts.trialOutcome === 'fail') {
      // L'image démarre et ne confirme jamais : `Boot/Test/trial_fail.s`. La marque
      // « essayé » reste posée, et le prochain démarrage fera le rollback.
      return;
    }
    if (f.candidateSlot !== 0xff && f.meta[f.candidateSlot]?.valid === true) {
      f.activeSlot = f.candidateSlot;
      f.candidateSlot = 0xff;
      f.candidateAttempted = false;
    }
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
    if (this.telemTimer !== null) clearInterval(this.telemTimer);
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

  private replyFrameFlags(msgId: number, flags: number, seq: number, payload: Uint8Array): void {
    this.reply(encodeFrame(msgId, flags, seq, payload));
  }

  private push(msgId: number, payload: Uint8Array): void {
    this.reply(encodeFrame(msgId, FRAME_FLAG.PUSH, this.pushSeq++, payload));
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
        this.confirmTrialIfAny();
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
      case MSG.PARAM_SAVE_NVM: {
        // Comme le firmware : les entrées qui portent `persistent`, valeur courante, et un
        // numéro d'enregistrement qui ne fait que croître.
        const persistent = this.params.filter((p) => (p.flags & 0x02) !== 0);
        this.nvmSeq += 1;
        for (const p of persistent) this.nvm.set(p.id, this.values.get(p.id) ?? p.def);
        this.replyFrame(MSG.PARAM_SAVE_NVM, seq,
          new PayloadWriter().u16(persistent.length).u32(this.nvmSeq).build());
        break;
      }
      case MSG.TELEM_SIGNALS:
        this.onSignals(seq, payload);
        break;
      case MSG.TELEM_SUBSCRIBE:
        this.onSubscribe(seq, payload);
        break;
      case MSG.SCOPE_CONFIG:
        this.onScopeConfig(seq, payload);
        break;
      case MSG.SCOPE_ARM:
        this.onScopeArm(seq, payload);
        break;
      case MSG.SCOPE_STATUS:
        if (payload.length !== 0) this.replyError(MSG.SCOPE_STATUS, seq, PROTO_ERR.LEN);
        else this.replyFrame(MSG.SCOPE_STATUS, seq, this.scopeStatusPayload());
        break;
      case MSG.SCOPE_READ:
        this.onScopeRead(seq, payload);
        break;
      case MSG.BOOT_ENTER:
        if (payload.length !== 0) this.replyError(MSG.BOOT_ENTER, seq, PROTO_ERR.LEN);
        else this.replyFrame(MSG.BOOT_ENTER, seq, new Uint8Array(0));
        break;
      case MSG.BOOT_INFO:
        if (payload.length !== 0) this.replyError(MSG.BOOT_INFO, seq, PROTO_ERR.LEN);
        else this.replyFrame(MSG.BOOT_INFO, seq, this.bootInfoPayload());
        break;
      case MSG.BOOT_ERASE:
        this.onBootErase(seq, payload);
        break;
      case MSG.BOOT_WRITE:
        this.onBootWrite(seq, payload);
        break;
      case MSG.BOOT_VERIFY:
        this.onBootVerify(seq, payload);
        break;
      case MSG.BOOT_ROLLBACK:
        if (payload.length !== 0) this.replyError(MSG.BOOT_ROLLBACK, seq, PROTO_ERR.LEN);
        else if (this.flash.candidateSlot === 0xff) this.replyError(MSG.BOOT_ROLLBACK, seq, PROTO_ERR.STATE);
        else {
          this.flash.candidateSlot = 0xff;
          this.flash.candidateAttempted = false;
          this.replyFrame(MSG.BOOT_ROLLBACK, seq, new Uint8Array(0));
        }
        break;
      case MSG.BOOT_REBOOT:
        if (payload.length !== 0) this.replyError(MSG.BOOT_REBOOT, seq, PROTO_ERR.LEN);
        else {
          // Redémarre : ça ne promeut rien. La version précédente rendait le candidat actif
          // sur-le-champ, ce qui faisait disparaître la probation — donc le rollback avec
          // elle, et toute la raison d'avoir deux slots. C'est `onPowerUp()` qui décide.
          this.replyFrame(MSG.BOOT_REBOOT, seq, new Uint8Array(0));
          this.bootErased.clear();
          this.onPowerUp();
        }
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
      .u16(DEFAULT_SIM_SIGNALS.length)
      // Le simulateur implemente les six messages du bootloader (§8) : ne pas lever le bit
      // rendait `firmware-update` impossible a exercer ici, et le chemin d'ecriture — erase,
      // fragmentage, CRC, probation — n'avait alors jamais tourne nulle part.
      .u32(PROTO_CAP.TELEMETRY | PROTO_CAP.SCOPE | PROTO_CAP.BOOTLOADER | PROTO_CAP.NVM)
      .build();
  }

  private onSignals(seq: number, payload: Uint8Array): void {
    if (payload.length !== 4) return this.replyError(MSG.TELEM_SIGNALS, seq, PROTO_ERR.LEN);
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const start = view.getUint16(0, true);
    let count = view.getUint16(2, true) || 1;
    if (start >= DEFAULT_SIM_SIGNALS.length) {
      return this.replyError(MSG.TELEM_SIGNALS, seq, PROTO_ERR.RANGE);
    }
    count = Math.min(count, 11, DEFAULT_SIM_SIGNALS.length - start);
    const fixed = (text: string, width: number): Uint8Array => {
      const out = new Uint8Array(width);
      out.set(new TextEncoder().encode(text).subarray(0, width));
      return out;
    };
    const w = new PayloadWriter().u16(start).u16(DEFAULT_SIM_SIGNALS.length).u16(count);
    for (const s of DEFAULT_SIM_SIGNALS.slice(start, start + count)) {
      w.u16(s.id).u8(s.type).u8(s.flags).raw(fixed(s.name, 32)).raw(fixed(s.unit, 8));
    }
    this.replyFrame(MSG.TELEM_SIGNALS, seq, w.build());
  }

  private onSubscribe(seq: number, payload: Uint8Array): void {
    let requested: TelemSubscription;
    try {
      requested = decodeTelemSubscribe(payload);
    } catch {
      return this.replyError(MSG.TELEM_SUBSCRIBE, seq, PROTO_ERR.LEN);
    }
    if (requested.signalIds.length > 16 || new Set(requested.signalIds).size !== requested.signalIds.length) {
      return this.replyError(MSG.TELEM_SUBSCRIBE, seq, PROTO_ERR.ARG);
    }
    if (requested.signalIds.some((id) => !DEFAULT_SIM_SIGNALS.some((s) => s.id === id))) {
      return this.replyError(MSG.TELEM_SUBSCRIBE, seq, PROTO_ERR.ID);
    }
    if (this.telemTimer !== null) clearInterval(this.telemTimer);
    const rateHz = requested.rateHz === 0 || requested.signalIds.length === 0
      ? 0
      : Math.floor(20_000 / Math.round(20_000 / Math.max(100, Math.min(500, requested.rateHz))));
    this.telem = { rateHz, signalIds: rateHz === 0 ? [] : [...requested.signalIds] };
    this.telemSeq = 0;
    const response = new PayloadWriter().u16(rateHz).u8(this.telem.signalIds.length).u8(0);
    for (const id of this.telem.signalIds) response.u16(id);
    this.replyFrame(MSG.TELEM_SUBSCRIBE, seq, response.build());
    if (rateHz > 0) {
      this.telemTimer = setInterval(() => this.emitTelemetry(), 1000 / rateHz);
    } else {
      this.telemTimer = null;
    }
  }

  private signalValue(id: number, sample: number): number {
    const phase = sample * 0.03125;
    switch (id) {
      case 1: return Math.fround(2048 + 40 * Math.sin(phase));
      case 2: return Math.fround(2048 + 40 * Math.sin(phase - (2 * Math.PI) / 3));
      case 3: return Math.fround(2048 + 40 * Math.sin(phase + (2 * Math.PI) / 3));
      case 4: return 300;
      case 5: return 340;
      case 6: return 0.6;
      default: return 0;
    }
  }

  private emitTelemetry(): void {
    if (!this.open || this.telem.rateHz === 0) return;
    const sample = this.telemSeq;
    const w = new PayloadWriter()
      .u32(Math.floor(performance.now() * 1000) >>> 0)
      .u16(this.telemSeq++)
      .u8(this.telem.signalIds.length)
      .u8(0);
    for (const id of this.telem.signalIds) w.f32(this.signalValue(id, sample));
    this.push(MSG.TELEM_FRAME, w.build());
  }

  private onScopeConfig(seq: number, payload: Uint8Array): void {
    let config: ScopeConfig;
    try {
      config = decodeScopeConfig(payload);
    } catch {
      return this.replyError(MSG.SCOPE_CONFIG, seq, PROTO_ERR.LEN);
    }
    const idsKnown = config.signalIds.every((id) => DEFAULT_SIM_SIGNALS.some((s) => s.id === id));
    const triggerSelected = config.triggerMode === ScopeTrigger.IMMEDIATE ||
      config.signalIds.includes(config.triggerSignalId);
    if (config.depth < 1 || config.depth > 2048 || config.decimation < 1 ||
        config.decimation > 256 || config.pretriggerSamples >= config.depth ||
        config.signalIds.length < 1 || config.signalIds.length > 4 ||
        new Set(config.signalIds).size !== config.signalIds.length || !idsKnown || !triggerSelected) {
      return this.replyError(MSG.SCOPE_CONFIG, seq, PROTO_ERR.ARG);
    }
    this.scopeConfig = { ...config, signalIds: [...config.signalIds] };
    this.scopeSamples = [];
    this.replyFrame(MSG.SCOPE_CONFIG, seq, encodeScopeConfig(this.scopeConfig));
  }

  private onScopeArm(seq: number, payload: Uint8Array): void {
    if (payload.length !== 0) return this.replyError(MSG.SCOPE_ARM, seq, PROTO_ERR.LEN);
    this.scopeStartedUs = Math.floor(performance.now() * 1000) >>> 0;
    this.scopeSamples = Array.from({ length: this.scopeConfig.depth }, (_, sample) =>
      this.scopeConfig.signalIds.map((id) => this.signalValue(id, sample * this.scopeConfig.decimation)),
    );
    this.replyFrame(MSG.SCOPE_STATUS, seq, this.scopeStatusPayload());
    this.push(MSG.SCOPE_STATUS, this.scopeStatusPayload());
  }

  private scopeStatusPayload(): Uint8Array {
    const complete = this.scopeSamples.length === this.scopeConfig.depth;
    return new PayloadWriter()
      .u8(complete ? ScopeState.COMPLETE : ScopeState.IDLE)
      .u8(this.scopeConfig.signalIds.length)
      .u16(this.scopeSamples.length)
      .u16(this.scopeConfig.depth)
      .u16(complete ? this.scopeConfig.pretriggerSamples : 0xffff)
      .u16(this.scopeConfig.decimation)
      .u16(0)
      .u32(50_000 * this.scopeConfig.decimation)
      .u32(complete ? this.scopeStartedUs : 0)
      .build();
  }

  private onScopeRead(seq: number, payload: Uint8Array): void {
    if (payload.length !== 4) return this.replyError(MSG.SCOPE_READ, seq, PROTO_ERR.LEN);
    if (this.scopeSamples.length !== this.scopeConfig.depth) {
      return this.replyError(MSG.SCOPE_READ, seq, PROTO_ERR.STATE);
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const start = view.getUint16(0, true);
    let count = view.getUint16(2, true);
    if (start >= this.scopeSamples.length || count === 0) {
      return this.replyError(MSG.SCOPE_READ, seq, PROTO_ERR.RANGE);
    }
    const max = Math.floor((512 - 8) / (4 * this.scopeConfig.signalIds.length));
    count = Math.min(count, max, this.scopeSamples.length - start);
    const w = new PayloadWriter()
      .u16(start)
      .u16(this.scopeSamples.length)
      .u16(count)
      .u8(this.scopeConfig.signalIds.length)
      .u8(0);
    for (const point of this.scopeSamples.slice(start, start + count)) {
      for (const value of point) w.f32(value);
    }
    const more = start + count < this.scopeSamples.length ? FRAME_FLAG.MORE : 0;
    this.replyFrameFlags(MSG.SCOPE_READ, FRAME_FLAG.RESPONSE | more, seq, w.build());
  }

  private bootInfoPayload(): Uint8Array {
    const fixed = (text: string): Uint8Array => {
      const out = new Uint8Array(16);
      out.set(new TextEncoder().encode(text).subarray(0, 16));
      return out;
    };
    const w = new PayloadWriter()
      .u16(0x0200).raw(fixed('0.1.0'))
      .u8(this.flash.activeSlot).u8(this.flash.candidateSlot)
      .u8(this.flash.candidateAttempted ? 1 : 0).u8(0);
    for (let slot = 0; slot < 2; slot++) {
      const meta = this.flash.meta[slot]!;
      w.u32(slot === 0 ? 0x08008000 : 0x08040000)
        .u32(224 * 1024)
        .u32(meta.imageSize)
        .u32(meta.crc32)
        .u8(meta.valid ? 1 : 0).u8(0).u8(0).u8(0)
        .raw(fixed(meta.version));
    }
    return w.build();
  }

  private onBootErase(seq: number, payload: Uint8Array): void {
    if (payload.length !== 4 || payload[1] !== 0 || payload[2] !== 0 || payload[3] !== 0) {
      return this.replyError(MSG.BOOT_ERASE, seq, PROTO_ERR.LEN);
    }
    const slot = payload[0]!;
    if (slot > 1 || slot === this.flash.activeSlot) {
      return this.replyError(MSG.BOOT_ERASE, seq, PROTO_ERR.STATE);
    }
    this.flash.slots[slot]!.fill(0xff);
    this.flash.meta[slot] = { imageSize: 0, crc32: 0, valid: false, version: '' };
    this.bootErased.add(slot);
    this.replyFrame(MSG.BOOT_ERASE, seq, payload);
  }

  private onBootWrite(seq: number, payload: Uint8Array): void {
    if (payload.length < 8) return this.replyError(MSG.BOOT_WRITE, seq, PROTO_ERR.LEN);
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const slot = payload[0]!;
    const length = view.getUint16(2, true);
    const offset = view.getUint32(4, true);
    if (payload[1] !== 0 || length < 8 || length > 504 || length % 8 !== 0 ||
        offset % 8 !== 0 || payload.length !== 8 + length) {
      return this.replyError(MSG.BOOT_WRITE, seq, PROTO_ERR.LEN);
    }
    if (slot > 1 || slot === this.flash.activeSlot || !this.bootErased.has(slot) ||
        offset + length > this.flash.slots[slot]!.length) {
      return this.replyError(MSG.BOOT_WRITE, seq, PROTO_ERR.STATE);
    }
    this.flash.slots[slot]!.set(payload.subarray(8), offset);
    this.replyFrame(MSG.BOOT_WRITE, seq, payload.subarray(0, 8));
  }

  private onBootVerify(seq: number, payload: Uint8Array): void {
    if (payload.length !== 28) return this.replyError(MSG.BOOT_VERIFY, seq, PROTO_ERR.LEN);
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const slot = payload[0]!;
    const size = view.getUint32(4, true);
    const expected = view.getUint32(8, true);
    const base = slot === 0 ? 0x08008000 : 0x08040000;
    const image = this.flash.slots[slot];
    if (slot > 1 || image === undefined || !this.bootErased.has(slot) || slot === this.flash.activeSlot ||
        size < 8 || size > image.length) {
      return this.replyError(MSG.BOOT_VERIFY, seq, PROTO_ERR.STATE);
    }
    const vectors = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const sp = vectors.getUint32(0, true);
    const reset = vectors.getUint32(4, true);
    const vectorValid = sp >= 0x20000000 && sp <= 0x2001ff00 && (reset & 1) === 1 &&
      (reset & ~1) >= base && (reset & ~1) < base + image.length;
    if (!vectorValid || crc32(image.subarray(0, size)) !== expected) {
      return this.replyError(MSG.BOOT_VERIFY, seq, PROTO_ERR.FLASH);
    }
    const version = new TextDecoder().decode(payload.subarray(12, 28)).replace(/\0.*$/s, '');
    this.flash.meta[slot] = { imageSize: size, crc32: expected, valid: true, version };
    this.flash.candidateSlot = slot;
    this.replyFrame(MSG.BOOT_VERIFY, seq, new Uint8Array(0));
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

  /**
   * Coupure de securite, comme le firmware la produirait. Le simulateur n'a pas d'horloge
   * de watchdog : declencher la coupure est un geste explicite, sinon le test attendrait un
   * delai reel pour verifier un chemin qui n'a rien de temporel.
   */
  tripSafety(reason: 'host_gone' | 'cmd_timeout' | 'drv_fault'): void {
    this.pwmEnabled = false;
    this.safetyReason = reason;
    this.safetyLatched = true;
    this.safetyTrips += 1;
  }

  /**
   * Retire ou remet l'aimant devant le capteur. Point d'accroche de test, pas une commande :
   * le firmware n'en a aucune pour ca — l'aimant est une piece mecanique. En faire une ligne
   * de console ici creerait une commande que la carte ne connait pas, c'est-a-dire la
   * divergence exacte que `docs/protocol.md` existe pour empecher.
   */
  setMagnet(present: boolean): void {
    this.encMagnet = present;
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
            `sysclk=144000000 pwm_hz=20000 arr=3599 deadtime_ns=500 vref_mv=3300`,
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
        this.safetyReason = 'requested';
        this.replyLine('OK');
        break;
      case 'SAFETY?':
        this.replyLine(
          `OK reason=${this.safetyReason} latched=${this.safetyLatched ? 1 : 0} ` +
            `outputs=${this.pwmEnabled ? 1 : 0} since_cmd_ms=0 trips=${this.safetyTrips} host=1`,
        );
        break;
      case 'FAULTCLR':
        this.safetyLatched = false;
        this.safetyReason = 'ok';
        this.replyLine('OK');
        break;
      case 'PWM?':
        this.replyLine(`OK enabled=${this.pwmEnabled ? 1 : 0}`);
        break;
      case 'SENS.ALL?': {
        // Des valeurs plausibles et lentement variables : un tableau de bord figé ne
        // permet pas de voir qu'il est vivant, et des valeurs aleatoires empecheraient
        // un test de conclure. Une derive douce fait les deux.
        const t = (Date.now() % 60_000) / 60_000;
        const wobble = (amp: number): number => Math.round(amp * Math.sin(t * 2 * Math.PI));
        this.replyLine(
          `OK rounds=${++this.sensRounds} vref_mv=3300 vrefint_raw=1502 ` +
            `vin_mv=${15000 + wobble(120)} vmot_mv=${14950 + wobble(140)} ` +
            `v5_mv=${4920 + wobble(25)} v3v3_mv=${3300 + wobble(12)} ` +
            `csa_raw=2048,2048,2048 csa_mv=1650,1650,1650 ` +
            `mcu_temp_c=${38 + wobble(3)}`,
        );
        break;
      }
      case 'ENC?': {
        // Le simulateur porte un aimant et un arbre qui tourne lentement : c'est l'etat
        // nominal, celui dont on a besoin pour construire une vue. L'etat degrade se force
        // par `setMagnet(false)` — une interface qui ne sait afficher que le cas sain est
        // une interface qu'on decouvre en panne au banc.
        const rev = (Date.now() % 8000) / 8000;            // un tour toutes les 8 s
        const raw = Math.round(rev * 4096) % 4096;
        const pos = Math.round(rev * 2 * Math.PI * 1000);
        this.encReads += 17;
        this.replyLine(
          `OK present=1 magnet=${this.encMagnet ? 1 : 0} ` +
            `status=${this.encMagnet ? '20' : '13'} mag=${this.encMagnet ? 1818 : 4} ` +
            `raw=${raw} turns=0 ` +
            `pos_mrad=${pos} vel_mrad_s=785 bus_hz=1000000 ` +
            `xfer_us=57 period_us=59 age_max_us=118 ok=${this.encReads} err=0`,
        );
        break;
      }
      case 'DRV?':
        this.replyLine(
          'OK spi=1 nfault=0 events=0 fs1=000 fs2=000 ctrl=000 hs=377 ls=377 ocp=145 csa=283',
        );
        break;
      case 'LINK?':
        this.replyLine('OK tx_dropped=0 rx_dropped=0 long=0 host=1');
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
