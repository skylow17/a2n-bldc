/**
 * Dictionnaire de paramètres auto-décrit — `docs/protocol.md` §5.
 *
 * Le firmware décrit ses paramètres, l'interface construit ses panneaux à partir de cette
 * description. Rien de la liste n'est codé en dur ici : c'est exactement ce qui évite qu'une
 * liste maintenue des deux côtés diverge.
 *
 * Jumeau de `controller-2/Core/Src/comm/param.c`.
 */

import { crc32 } from './crc16.js';
import { PayloadReader, PayloadWriter } from './frame.js';

export const ParamType = {
  U8: 0,
  I8: 1,
  U16: 2,
  I16: 3,
  U32: 4,
  I32: 5,
  F32: 6,
  BOOL: 7,
  ENUM: 8,
} as const;

export type ParamTypeValue = (typeof ParamType)[keyof typeof ParamType];

export const PARAM_TYPE_NAME: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(Object.entries(ParamType).map(([k, v]) => [v, k.toLowerCase()])),
);

export const PARAM_FLAG = {
  READ_ONLY: 0x01,
  PERSISTENT: 0x02,
  REQUIRES_DISARM: 0x04,
  ADVANCED: 0x08,
  CALIBRATED: 0x10,
} as const;

export const PARAM_NAME_LEN = 32;
export const PARAM_UNIT_LEN = 8;
export const PARAM_GROUP_LEN = 24;

/** Taille d'une entrée sérialisée telle qu'elle circule dans `PARAM_DICT_ENTRY`. */
export const PARAM_ENTRY_WIRE_LEN =
  2 + 1 + 1 + PARAM_NAME_LEN + PARAM_UNIT_LEN + 4 + 4 + 4 + PARAM_GROUP_LEN; // 80

export interface ParamDesc {
  id: number;
  type: ParamTypeValue;
  flags: number;
  name: string;
  unit: string;
  group: string;
  min: number;
  max: number;
  def: number;
}

export function isReadOnly(p: ParamDesc): boolean {
  return (p.flags & PARAM_FLAG.READ_ONLY) !== 0;
}

export function isPersistent(p: ParamDesc): boolean {
  return (p.flags & PARAM_FLAG.PERSISTENT) !== 0;
}

/** Lit une entrée depuis un curseur positionné au début de celle-ci. */
export function readParamEntry(r: PayloadReader): ParamDesc {
  const id = r.u16();
  const type = r.u8() as ParamTypeValue;
  const flags = r.u8();
  const name = r.fixedString(PARAM_NAME_LEN);
  const unit = r.fixedString(PARAM_UNIT_LEN);
  const min = r.f32();
  const max = r.f32();
  const def = r.f32();
  const group = r.fixedString(PARAM_GROUP_LEN);
  return { id, type, flags, name, unit, group, min, max, def };
}

/**
 * Re-sérialise une entrée exactement comme le firmware l'a émise.
 *
 * Utile uniquement pour recalculer le hash (ci-dessous) : on ne renvoie jamais une entrée au
 * firmware. Toute divergence ici fausserait la vérification d'intégrité, d'où les tests qui
 * confrontent cette fonction aux octets réellement reçus.
 */
export function writeParamEntry(p: ParamDesc): Uint8Array {
  const fixed = (s: string, width: number): Uint8Array => {
    const out = new Uint8Array(width);
    out.set(new TextEncoder().encode(s).subarray(0, width));
    return out;
  };
  return new PayloadWriter()
    .u16(p.id)
    .u8(p.type)
    .u8(p.flags)
    .raw(fixed(p.name, PARAM_NAME_LEN))
    .raw(fixed(p.unit, PARAM_UNIT_LEN))
    .f32(p.min)
    .f32(p.max)
    .f32(p.def)
    .raw(fixed(p.group, PARAM_GROUP_LEN))
    .build();
}

/**
 * Hash de la **forme** du dictionnaire : CRC-32 de la concaténation des entrées sérialisées,
 * dans l'ordre de la table.
 *
 * Deux firmwares de même hash acceptent la même recette. Et comme le calcul porte sur les
 * octets qui circulent, le comparer à celui annoncé dans `DEVICE_INFO` vérifie du même coup
 * que le dictionnaire a été transféré intégralement et dans le bon ordre.
 */
export function paramDictHash(entries: readonly ParamDesc[]): number {
  const all = new Uint8Array(entries.length * PARAM_ENTRY_WIRE_LEN);
  entries.forEach((p, i) => all.set(writeParamEntry(p), i * PARAM_ENTRY_WIRE_LEN));
  return crc32(all);
}

/**
 * Contraint une valeur au domaine déclaré, en respectant le type.
 *
 * L'interface s'en sert avant d'envoyer : le firmware refuserait de toute façon une valeur
 * hors bornes, mais mieux vaut ne pas la lui envoyer. Ce n'est pas une garantie de sécurité
 * — celle-ci est dans le firmware et nulle part ailleurs — juste une commodité de saisie.
 */
export function clampToParam(p: ParamDesc, value: number): number {
  if (!Number.isFinite(value)) return p.def;
  let v = Math.min(Math.max(value, p.min), p.max);
  switch (p.type) {
    case ParamType.F32:
      return v;
    case ParamType.BOOL:
      return v !== 0 ? 1 : 0;
    default:
      // Arrondi au plus proche, comme le firmware : un 2.9999997 issu d'un aller-retour
      // flottant doit se ranger en 3, pas en 2.
      v = Math.round(v);
      return Math.min(Math.max(v, p.min), p.max);
  }
}

/** Index pratique : accès par identifiant et par nom, tous deux uniques. */
export class ParamDictionary {
  private readonly byId = new Map<number, ParamDesc>();
  private readonly byName = new Map<string, ParamDesc>();

  constructor(
    readonly entries: readonly ParamDesc[],
    readonly hash: number = paramDictHash(entries),
  ) {
    for (const p of entries) {
      this.byId.set(p.id, p);
      this.byName.set(p.name, p);
    }
  }

  get(idOrName: number | string): ParamDesc | undefined {
    return typeof idOrName === 'number' ? this.byId.get(idOrName) : this.byName.get(idOrName);
  }

  /** Groupes dans l'ordre d'apparition — c'est l'ordre d'affichage voulu par le firmware. */
  groups(): string[] {
    const seen: string[] = [];
    for (const p of this.entries) {
      if (!seen.includes(p.group)) seen.push(p.group);
    }
    return seen;
  }

  get size(): number {
    return this.entries.length;
  }
}
