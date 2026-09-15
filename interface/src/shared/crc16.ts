/**
 * CRC-16/CCITT-FALSE — polynôme 0x1021, init 0xFFFF, sans réflexion, xorout 0x0000.
 *
 * Jumeau de `controller-2/Core/Src/comm/crc16.c`. Attention au nom : plusieurs CRC-16
 * différents circulent sous l'étiquette « CCITT ». Le seul arbitre est le vecteur de
 * référence `crc16("123456789") === 0x29B1`, vérifié par les tests des deux côtés.
 */

export const CRC16_INIT = 0xffff;

const TABLE = ((): Uint16Array => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    t[i] = crc;
  }
  return t;
})();

export function crc16Update(crc: number, data: Uint8Array): number {
  let c = crc & 0xffff;
  for (const byte of data) {
    c = ((c << 8) ^ TABLE[((c >> 8) ^ byte) & 0xff]!) & 0xffff;
  }
  return c;
}

export function crc16(data: Uint8Array): number {
  return crc16Update(CRC16_INIT, data);
}

/**
 * CRC-32/ISO-HDLC (celui de zlib) — polynôme réfléchi 0xEDB88320, init et xorout 0xFFFFFFFF.
 * Sert uniquement au hash du dictionnaire de paramètres (voir `params.ts`).
 * Vecteur de référence : `crc32("123456789") === 0xCBF43926`.
 */
const TABLE32 = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c = (TABLE32[(c ^ byte) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}
