/**
 * Recettes de configuration — format `.a2nrcp` (`interface/AGENTS.md` §4).
 *
 * Une recette est un jeu de valeurs de paramètres, **par nom**, rattaché à la forme du
 * dictionnaire qui l'a produite (`param_dict_hash`). Ce module ne fait que du pur : lire et
 * valider un fichier, capturer l'état d'un device, et comparer une recette au device. Rien
 * ici n'écrit sur la carte — l'application se fait paramètre par paramètre, par le même
 * chemin que la vue Tuning, et le firmware reste seul juge de chaque valeur.
 *
 * Deux règles de la spécification, tenues ici plutôt que dans la vue :
 *
 *  - une recette ne s'applique jamais en aveugle : `diffRecipe` rend une ligne par entrée,
 *    y compris celles qu'on n'appliquera pas (inconnues, lecture seule, hors bornes), pour
 *    qu'aucune ne soit ignorée en silence ;
 *  - un hash qui diffère n'est pas une erreur mais une confirmation à obtenir : le diff le
 *    dit (`hashMatch`), la vue la demande.
 */

import { z } from 'zod';

import { PARAM_FLAG, ParamType } from './params.js';

export const RECIPE_SCHEMA = 1;
export const RECIPE_EXTENSION = 'a2nrcp';

/** Validation d'un fichier. Tout ce qui entre est validé (`interface/AGENTS.md` §6). */
const recipeSchema = z.object({
  schema: z.literal(RECIPE_SCHEMA),
  name: z.string().min(1).max(64),
  description: z.string().max(2000).optional(),
  created: z.string().max(40),
  fw_version: z.string().max(32).optional(),
  /**
   * Hash du dictionnaire, 8 chiffres hexadécimaux. **Absent** pour une recette partielle —
   * un profil qui ne nomme que quelques réglages et s'applique par nom sur n'importe quel
   * firmware qui les porte.
   */
  param_dict_hash: z.string().regex(/^[0-9a-fA-F]{8}$/).optional(),
  params: z.record(z.string().min(1).max(32), z.number().finite()),
});

export type Recipe = z.infer<typeof recipeSchema>;

/** Ce que le diff a besoin de savoir d'un paramètre du device — un sous-ensemble du snapshot. */
export interface DeviceParamView {
  name: string;
  unit: string;
  type: number;
  flags: number;
  min: number;
  max: number;
  value: number | null;
}

export function formatDictHash(hash: number): string {
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function parseRecipe(text: string): { ok: true; recipe: Recipe } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = recipeSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first !== undefined && first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
    return { ok: false, error: `not a recipe${where}: ${first?.message ?? 'rejected'}` };
  }
  return { ok: true, recipe: parsed.data };
}

/** Texte du fichier : JSON indenté, clés de paramètres triées, pour des diffs git lisibles. */
export function serializeRecipe(r: Recipe): string {
  const params: Record<string, number> = {};
  for (const k of Object.keys(r.params).sort()) params[k] = r.params[k]!;
  return `${JSON.stringify({ ...r, params }, null, 2)}\n`;
}

/**
 * Capture l'état du device : toutes les valeurs **inscriptibles** lues. Les paramètres en
 * lecture seule décrivent la carte, pas un réglage ; les rejouer n'aurait aucun sens.
 */
export function captureRecipe(
  name: string,
  device: { fwVersion: string; paramDictHash: number },
  params: readonly DeviceParamView[],
  now: Date = new Date(),
  description?: string,
): Recipe {
  const values: Record<string, number> = {};
  for (const p of params) {
    if ((p.flags & PARAM_FLAG.READ_ONLY) !== 0 || p.value === null) continue;
    values[p.name] = p.value;
  }
  return {
    schema: RECIPE_SCHEMA,
    name,
    ...(description !== undefined && description !== '' ? { description } : {}),
    created: now.toISOString(),
    fw_version: device.fwVersion,
    param_dict_hash: formatDictHash(device.paramDictHash),
    params: values,
  };
}

export type DiffStatus =
  /** Valeur identique à celle du device : rien à écrire. */
  | 'same'
  /** À écrire. */
  | 'change'
  /** Nom absent du dictionnaire de ce firmware : jamais écrit, toujours listé. */
  | 'unknown'
  /** Paramètre en lecture seule sur ce firmware. */
  | 'read_only'
  /** Hors des bornes que ce firmware annonce : refusé plutôt que rogné. */
  | 'out_of_range';

export interface DiffRow {
  name: string;
  unit: string;
  file: number;
  device: number | null;
  status: DiffStatus;
  /** Mesuré sur la carte (`calibrated`) : l'écraser défait une calibration. */
  calibrated: boolean;
  /** Refusé par le firmware tant que les sorties sont actives. */
  requiresDisarm: boolean;
}

export interface RecipeDiff {
  rows: DiffRow[];
  /** `null` : recette partielle, ou device inconnu — aucune comparaison de forme possible. */
  hashMatch: boolean | null;
}

const INTEGER_TYPES: ReadonlySet<number> = new Set([
  ParamType.U8,
  ParamType.I8,
  ParamType.U16,
  ParamType.I16,
  ParamType.U32,
  ParamType.I32,
  ParamType.BOOL,
  ParamType.ENUM,
]);

/**
 * Égalité telle que le firmware la verrait. Toutes les valeurs circulent en `f32` et les
 * types entiers sont arrondis au plus proche (`docs/protocol.md` §5) : `0.0011` écrit dans
 * un fichier et `0.0010999999940…` relu de la carte sont la même valeur.
 */
function sameOnDevice(p: DeviceParamView, file: number, device: number): boolean {
  if (INTEGER_TYPES.has(p.type)) return Math.round(file) === Math.round(device);
  return Math.fround(file) === Math.fround(device);
}

export function diffRecipe(
  recipe: Recipe,
  params: readonly DeviceParamView[],
  deviceHash: number | null,
): RecipeDiff {
  const byName = new Map(params.map((p) => [p.name, p]));
  const rows: DiffRow[] = [];
  for (const [name, file] of Object.entries(recipe.params)) {
    const p = byName.get(name);
    if (p === undefined) {
      rows.push({ name, unit: '', file, device: null, status: 'unknown', calibrated: false, requiresDisarm: false });
      continue;
    }
    let status: DiffStatus;
    if ((p.flags & PARAM_FLAG.READ_ONLY) !== 0) status = 'read_only';
    else if (file < p.min || file > p.max) status = 'out_of_range';
    else if (p.value !== null && sameOnDevice(p, file, p.value)) status = 'same';
    else status = 'change';
    rows.push({
      name,
      unit: p.unit,
      file,
      device: p.value,
      status,
      calibrated: (p.flags & PARAM_FLAG.CALIBRATED) !== 0,
      requiresDisarm: (p.flags & PARAM_FLAG.REQUIRES_DISARM) !== 0,
    });
  }
  // Ordre du dictionnaire du device, puis les inconnus : la lecture suit celle de Tuning.
  const order = new Map(params.map((p, i) => [p.name, i]));
  rows.sort((a, b) => (order.get(a.name) ?? Infinity) - (order.get(b.name) ?? Infinity) || a.name.localeCompare(b.name));

  const hashMatch =
    recipe.param_dict_hash === undefined || deviceHash === null
      ? null
      : recipe.param_dict_hash.toLowerCase() === formatDictHash(deviceHash);
  return { rows, hashMatch };
}

/**
 * Lignes cochées par défaut : ce qui change, **sauf** les valeurs calibrées. Une recette
 * venue d'une autre carte porte sa calibration, pas la nôtre ; l'écraser doit être un choix
 * explicite, ligne par ligne.
 */
export function defaultSelection(diff: RecipeDiff): Set<string> {
  return new Set(diff.rows.filter((r) => r.status === 'change' && !r.calibrated).map((r) => r.name));
}

/* ------------------------------------------------------------------ profils intégrés */

/**
 * Profils de rigidité de l'arbre : des recettes **partielles**, sans hash, qui ne nomment que
 * les réglages des boucles de vitesse et de position (`docs/protocol.md` §5). Ils passent par
 * le même diff que n'importe quelle recette : un firmware qui ne porte pas ces réglages les
 * voit listés comme inconnus, et ses propres bornes décident du reste. Aucune borne n'est
 * recopiée ici — seulement des valeurs, que le firmware accepte ou refuse.
 *
 * L'inertie n'y figure pas : c'est une mesure de la mécanique montée, pas un goût.
 */
export const BUILTIN_PROFILES: readonly Recipe[] = [
  {
    schema: RECIPE_SCHEMA,
    name: 'Soft',
    description:
      'Compliant shaft: gentle on the mechanics and quiet, slower to reject a load torque. ' +
      'For fragile loads, belts, or first runs of a new setup.',
    created: '2026-09-27T00:00:00.000Z',
    params: { 'ctrl.speed.bw_hz': 20, 'ctrl.speed.zero_ratio': 6, 'ctrl.pos.bw_hz': 1.5 },
  },
  {
    schema: RECIPE_SCHEMA,
    name: 'Balanced',
    description:
      'The firmware defaults, validated on the bare rotor at step 12 and 13: 30 Hz speed, ' +
      '3 Hz position, integrator zero at a quarter of the speed bandwidth.',
    created: '2026-09-27T00:00:00.000Z',
    params: { 'ctrl.speed.bw_hz': 30, 'ctrl.speed.zero_ratio': 4, 'ctrl.pos.bw_hz': 3 },
  },
  {
    schema: RECIPE_SCHEMA,
    name: 'Stiff',
    description:
      'Holds the position tighter against a load and settles faster, at the cost of more ' +
      'current ripple, noise and overshoot. Not validated under load yet.',
    created: '2026-09-27T00:00:00.000Z',
    params: { 'ctrl.speed.bw_hz': 40, 'ctrl.speed.zero_ratio': 3, 'ctrl.pos.bw_hz': 5 },
  },
];

/** Nom de fichier proposé : le nom de la recette, réduit à ce qu'un système de fichiers accepte. */
export function recipeFileName(name: string): string {
  const base = name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'recipe';
  return `${base}.${RECIPE_EXTENSION}`;
}
