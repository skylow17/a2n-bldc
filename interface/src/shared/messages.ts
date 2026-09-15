/**
 * Encodage et décodage des payloads, message par message — `docs/protocol.md` §4 et §5.
 *
 * Ces fonctions ne touchent ni au transport ni au framing : elles transforment un payload en
 * objet et réciproquement. C'est ce qui permet de les tester sur des octets figés, sans
 * matériel ni port série.
 */

import { PayloadReader, PayloadWriter } from './frame.js';
import { PARAM_ENTRY_WIRE_LEN, readParamEntry, type ParamDesc } from './params.js';
import { PROTO_ERR_NAME, type DeviceInfo } from './protocol.js';

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

/* ------------------------------------------------------------------ erreurs */

export interface ProtocolError {
  code: number;
  name: string;
  detail: string;
}

/** Payload d'une réponse portant le bit erreur : `u16 code` + chaîne facultative. */
export function decodeError(payload: Uint8Array): ProtocolError {
  const r = new PayloadReader(payload);
  const code = r.u16();
  const detail = r.remaining > 0 ? new TextDecoder().decode(r.bytes(r.remaining)) : '';
  return { code, name: PROTO_ERR_NAME[code] ?? `0x${code.toString(16)}`, detail };
}
