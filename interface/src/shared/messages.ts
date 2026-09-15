/**
 * Encodage et décodage des payloads, message par message — `docs/protocol.md` §4 et §5.
 *
 * Ces fonctions ne touchent ni au transport ni au framing : elles transforment un payload en
 * objet et réciproquement. C'est ce qui permet de les tester sur des octets figés, sans
 * matériel ni port série.
 */

import { PayloadReader, PayloadWriter } from './frame.js';
import { PARAM_ENTRY_WIRE_LEN, readParamEntry, type ParamDesc } from './params.js';
import {
  PROTO_ERR_NAME,
  SIGNAL_ENTRY_WIRE_LEN,
  type DeviceInfo,
  type SignalDesc,
  type ScopeStateValue,
  type ScopeTriggerValue,
} from './protocol.js';

/* ------------------------------------------------------------------ handshake */

export function encodeHello(): Uint8Array {
  return new Uint8Array(0);
}

export function decodeDeviceInfo(payload: Uint8Array): DeviceInfo {
  const r = new PayloadReader(payload);
  const protocolVersion = r.u16();
  const product = r.fixedString(16);
  const fwVersion = r.fixedString(16);
  const paramDictHash = r.u32();
  const uid: [number, number, number] = [r.u32(), r.u32(), r.u32()];
  const paramCount = r.u16();
  const telemSignalCount = r.u16();
  const capabilities = r.u32();

  return {
    protocolVersion,
    protocolMajor: (protocolVersion >> 8) & 0xff,
    protocolMinor: protocolVersion & 0xff,
    product,
    fwVersion,
    paramDictHash,
    uid,
    paramCount,
    telemSignalCount,
    capabilities,
  };
}

/* ------------------------------------------------------------------ dictionnaire */

export function encodeParamDictGet(startIndex: number, count: number): Uint8Array {
  return new PayloadWriter().u16(startIndex).u16(count).build();
}

export interface ParamDictPage {
  startIndex: number;
  total: number;
  entries: ParamDesc[];
}

export function decodeParamDictEntry(payload: Uint8Array): ParamDictPage {
  const r = new PayloadReader(payload);
  const startIndex = r.u16();
  const total = r.u16();
  const count = r.u16();

  if (r.remaining !== count * PARAM_ENTRY_WIRE_LEN) {
    throw new RangeError(
      `page de dictionnaire incohérente : ${count} entrées annoncées, ${r.remaining} octets restants`,
    );
  }

  const entries: ParamDesc[] = [];
  for (let i = 0; i < count; i++) entries.push(readParamEntry(r));
  return { startIndex, total, entries };
}

/* ------------------------------------------------------------------ lecture / écriture */

export function encodeParamRead(ids: readonly number[]): Uint8Array {
  const w = new PayloadWriter().u16(ids.length);
  for (const id of ids) w.u16(id);
  return w.build();
}

/** Statut par paramètre — miroir de `ParamStatus_t` côté firmware. */
export const ParamStatus = {
  OK: 0,
  ERR_ID: 1,
  ERR_READ_ONLY: 2,
  ERR_RANGE: 3,
  ERR_STATE: 4,
} as const;

export const PARAM_STATUS_NAME: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(Object.entries(ParamStatus).map(([k, v]) => [v, k])),
);

export interface ParamReadResult {
  id: number;
  status: number;
  value: number;
}

export function decodeParamRead(payload: Uint8Array): ParamReadResult[] {
  const r = new PayloadReader(payload);
  const count = r.u16();
  const out: ParamReadResult[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ id: r.u16(), status: r.u8(), value: r.f32() });
  }
  return out;
}

export interface ParamWriteRequest {
  id: number;
  value: number;
}

export function encodeParamWrite(writes: readonly ParamWriteRequest[]): Uint8Array {
  const w = new PayloadWriter().u16(writes.length);
  for (const { id, value } of writes) w.u16(id).f32(value);
  return w.build();
}

export interface ParamWriteResult {
  id: number;
  status: number;
}

export function decodeParamWrite(payload: Uint8Array): ParamWriteResult[] {
  const r = new PayloadReader(payload);
  const count = r.u16();
  const out: ParamWriteResult[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ id: r.u16(), status: r.u8() });
  }
  return out;
}

/* ------------------------------------------------------------------ télémétrie */

export function encodeTelemSignals(startIndex: number, count: number): Uint8Array {
  return new PayloadWriter().u16(startIndex).u16(count).build();
}

export interface SignalPage {
  startIndex: number;
  total: number;
  signals: SignalDesc[];
}

export function decodeTelemSignals(payload: Uint8Array): SignalPage {
  const r = new PayloadReader(payload);
  const startIndex = r.u16();
  const total = r.u16();
  const count = r.u16();
  if (r.remaining !== count * SIGNAL_ENTRY_WIRE_LEN) {
    throw new RangeError(
      `inconsistent signal page: expected ${count * SIGNAL_ENTRY_WIRE_LEN} bytes, got ${r.remaining}`,
    );
  }
  const signals: SignalDesc[] = [];
  for (let i = 0; i < count; i++) {
    signals.push({
      id: r.u16(),
      type: r.u8(),
      flags: r.u8(),
      name: r.fixedString(32),
      unit: r.fixedString(8),
    });
  }
  return { startIndex, total, signals };
}

export interface TelemSubscription {
  rateHz: number;
  signalIds: number[];
}

export function encodeTelemSubscribe(rateHz: number, signalIds: readonly number[]): Uint8Array {
  const w = new PayloadWriter().u16(rateHz).u8(signalIds.length).u8(0);
  for (const id of signalIds) w.u16(id);
  return w.build();
}

export function decodeTelemSubscribe(payload: Uint8Array): TelemSubscription {
  const r = new PayloadReader(payload);
  const rateHz = r.u16();
  const count = r.u8();
  const reserved = r.u8();
  if (reserved !== 0 || r.remaining !== count * 2) {
    throw new RangeError('inconsistent telemetry subscription');
  }
  const signalIds: number[] = [];
  for (let i = 0; i < count; i++) signalIds.push(r.u16());
  return { rateHz, signalIds };
}

export interface TelemFrame {
  timestampUs: number;
  sampleSeq: number;
  values: number[];
}

export function decodeTelemFrame(payload: Uint8Array): TelemFrame {
  const r = new PayloadReader(payload);
  const timestampUs = r.u32();
  const sampleSeq = r.u16();
  const count = r.u8();
  const reserved = r.u8();
  if (reserved !== 0 || r.remaining !== count * 4) {
    throw new RangeError('inconsistent telemetry frame');
  }
  const values: number[] = [];
  for (let i = 0; i < count; i++) values.push(r.f32());
  return { timestampUs, sampleSeq, values };
}

/* ------------------------------------------------------------------ scope */

export interface ScopeConfig {
  depth: number;
  decimation: number;
  pretriggerSamples: number;
  triggerMode: ScopeTriggerValue;
  triggerSignalId: number;
  threshold: number;
  signalIds: number[];
}

export function encodeScopeConfig(config: ScopeConfig): Uint8Array {
  const w = new PayloadWriter()
    .u16(config.depth)
    .u16(config.decimation)
    .u16(config.pretriggerSamples)
    .u8(config.triggerMode)
    .u8(config.signalIds.length)
    .u16(config.triggerSignalId)
    .f32(config.threshold);
  for (const id of config.signalIds) w.u16(id);
  return w.build();
}

export function decodeScopeConfig(payload: Uint8Array): ScopeConfig {
  const r = new PayloadReader(payload);
  const depth = r.u16();
  const decimation = r.u16();
  const pretriggerSamples = r.u16();
  const triggerMode = r.u8() as ScopeTriggerValue;
  const count = r.u8();
  const triggerSignalId = r.u16();
  const threshold = r.f32();
  if (r.remaining !== count * 2) throw new RangeError('inconsistent scope configuration');
  const signalIds: number[] = [];
  for (let i = 0; i < count; i++) signalIds.push(r.u16());
  return {
    depth,
    decimation,
    pretriggerSamples,
    triggerMode,
    triggerSignalId,
    threshold,
    signalIds,
  };
}

export interface ScopeStatus {
  state: ScopeStateValue;
  signalCount: number;
  captured: number;
  depth: number;
  triggerIndex: number;
  decimation: number;
  samplePeriodNs: number;
  startTimestampUs: number;
}

export function decodeScopeStatus(payload: Uint8Array): ScopeStatus {
  const r = new PayloadReader(payload);
  const state = r.u8() as ScopeStateValue;
  const signalCount = r.u8();
  const captured = r.u16();
  const depth = r.u16();
  const triggerIndex = r.u16();
  const decimation = r.u16();
  const reserved = r.u16();
  const samplePeriodNs = r.u32();
  const startTimestampUs = r.u32();
  if (reserved !== 0 || r.remaining !== 0) throw new RangeError('inconsistent scope status');
  return {
    state,
    signalCount,
    captured,
    depth,
    triggerIndex,
    decimation,
    samplePeriodNs,
    startTimestampUs,
  };
}

export function encodeScopeRead(start: number, count: number): Uint8Array {
  return new PayloadWriter().u16(start).u16(count).build();
}

export interface ScopeChunk {
  start: number;
  total: number;
  signalCount: number;
  samples: number[][];
}

export function decodeScopeRead(payload: Uint8Array): ScopeChunk {
  const r = new PayloadReader(payload);
  const start = r.u16();
  const total = r.u16();
  const count = r.u16();
  const signalCount = r.u8();
  const reserved = r.u8();
  if (reserved !== 0 || signalCount === 0 || r.remaining !== count * signalCount * 4) {
    throw new RangeError('inconsistent scope data chunk');
  }
  const samples: number[][] = [];
  for (let point = 0; point < count; point++) {
    const values: number[] = [];
    for (let signal = 0; signal < signalCount; signal++) values.push(r.f32());
    samples.push(values);
  }
  return { start, total, signalCount, samples };
}

/* ------------------------------------------------------------------ bootloader */

export interface BootSlotInfo {
  address: number;
  capacity: number;
  imageSize: number;
  crc32: number;
  valid: boolean;
  version: string;
}

export interface BootInfo {
  protocolVersion: number;
  bootloaderVersion: string;
  activeSlot: number;
  candidateSlot: number;
  candidateAttempted: boolean;
  slots: readonly [BootSlotInfo, BootSlotInfo];
}

export function decodeBootInfo(payload: Uint8Array): BootInfo {
  const r = new PayloadReader(payload);
  const protocolVersion = r.u16();
  const bootloaderVersion = r.fixedString(16);
  const activeSlot = r.u8();
  const candidateSlot = r.u8();
  const candidateAttempted = r.u8() !== 0;
  if (r.u8() !== 0) throw new RangeError('invalid BOOT_INFO reserved field');
  const slots: BootSlotInfo[] = [];
  for (let i = 0; i < 2; i++) {
    const address = r.u32();
    const capacity = r.u32();
    const imageSize = r.u32();
    const crc32 = r.u32();
    const valid = r.u8() !== 0;
    if (r.u8() !== 0 || r.u8() !== 0 || r.u8() !== 0) {
      throw new RangeError('invalid BOOT_INFO slot reserved field');
    }
    slots.push({ address, capacity, imageSize, crc32, valid, version: r.fixedString(16) });
  }
  if (r.remaining !== 0) throw new RangeError('invalid BOOT_INFO length');
  return { protocolVersion, bootloaderVersion, activeSlot, candidateSlot, candidateAttempted,
    slots: slots as unknown as readonly [BootSlotInfo, BootSlotInfo] };
}

export function encodeBootErase(slot: number): Uint8Array {
  return new PayloadWriter().u8(slot).u8(0).u8(0).u8(0).build();
}

export function encodeBootWrite(slot: number, offset: number, data: Uint8Array): Uint8Array {
  return new PayloadWriter().u8(slot).u8(0).u16(data.length).u32(offset).raw(data).build();
}

export function decodeBootWriteAck(payload: Uint8Array): { slot: number; length: number; offset: number } {
  const r = new PayloadReader(payload);
  const slot = r.u8();
  if (r.u8() !== 0) throw new RangeError('invalid BOOT_WRITE reserved field');
  const length = r.u16();
  const offset = r.u32();
  if (r.remaining !== 0) throw new RangeError('invalid BOOT_WRITE response length');
  return { slot, length, offset };
}

export function encodeBootVerify(
  slot: number,
  imageSize: number,
  expectedCrc32: number,
  version: string,
): Uint8Array {
  const text = new Uint8Array(16);
  text.set(new TextEncoder().encode(version).subarray(0, 16));
  return new PayloadWriter()
    .u8(slot).u8(0).u8(0).u8(0)
    .u32(imageSize).u32(expectedCrc32).raw(text).build();
}

/* ------------------------------------------------------------------ erreurs */

export interface ProtocolErrorPayload {
  code: number;
  name: string;
  detail: string;
}

/** Payload d'une réponse portant le bit erreur : `u16 code` + chaîne facultative.
 *  Distinct de la classe `ProtocolError` de `client.ts`, qui est ce qui est *levé*. */
export function decodeError(payload: Uint8Array): ProtocolErrorPayload {
  const r = new PayloadReader(payload);
  const code = r.u16();
  const detail = r.remaining > 0 ? new TextDecoder().decode(r.bytes(r.remaining)) : '';
  return { code, name: PROTO_ERR_NAME[code] ?? `0x${code.toString(16)}`, detail };
}
