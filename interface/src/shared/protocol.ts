/**
 * Constantes du protocole A2N BLDC v2 — `docs/protocol.md`.
 *
 * Jumeau de `controller-2/Core/Inc/comm/proto.h`. Toute valeur ici doit exister à l'identique
 * là-bas, et l'évolution passe d'abord par la spécification.
 */

export const PROTOCOL_VERSION = 0x0200; // 2.0

export const MSG = {
  HELLO: 0x0001,
  DEVICE_INFO: 0x0002,
  PARAM_DICT_GET: 0x0010,
  PARAM_DICT_ENTRY: 0x0011,
  PARAM_READ: 0x0012,
  PARAM_WRITE: 0x0013,
  PARAM_SAVE_NVM: 0x0014,
  PARAM_RESET_DEFAULTS: 0x0015,
} as const;

export type MsgId = (typeof MSG)[keyof typeof MSG];

export const FRAME_FLAG = {
  RESPONSE: 0x01,
  ERROR: 0x02,
  PUSH: 0x04,
  MORE: 0x08,
} as const;

export const PROTO_ERR = {
  CRC: 1,
  LEN: 2,
  ID: 3,
  ARG: 4,
  RANGE: 5,
  STATE: 6,
  BUSY: 7,
  NOTARMED: 8,
  LOCKED: 9,
  NVM: 10,
  FLASH: 11,
} as const;

export const PROTO_ERR_NAME: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(Object.entries(PROTO_ERR).map(([k, v]) => [v, k])),
);

/**
 * Capacités annoncées au handshake. Le firmware ne lève un bit que lorsque la fonction est
 * réellement implémentée : l'interface s'en sert pour griser ce qui n'existe pas encore,
 * plutôt que de proposer un bouton qui échouera.
 */
export const PROTO_CAP = {
  TELEMETRY: 0x0000_0001,
  SCOPE: 0x0000_0002,
  NVM: 0x0000_0004,
  CAN: 0x0000_0008,
  BOOTLOADER: 0x0000_0010,
  ENCODER_INC: 0x0000_0020,
} as const;

export const FRAME_PAYLOAD_MAX = 512;
export const FRAME_HEADER_LEN = 4;
export const FRAME_CRC_LEN = 2;
export const FRAME_RAW_MAX = FRAME_HEADER_LEN + FRAME_PAYLOAD_MAX + FRAME_CRC_LEN;
export const FRAME_RAW_MIN = FRAME_HEADER_LEN + FRAME_CRC_LEN;

/** Identité renvoyée par `DEVICE_INFO` — `docs/protocol.md` §4. */
export interface DeviceInfo {
  protocolVersion: number;
  protocolMajor: number;
  protocolMinor: number;
  product: string;
  fwVersion: string;
  paramDictHash: number;
  uid: readonly [number, number, number];
  paramCount: number;
  telemSignalCount: number;
  capabilities: number;
}

export function hasCapability(info: DeviceInfo, cap: number): boolean {
  return (info.capabilities & cap) !== 0;
}
