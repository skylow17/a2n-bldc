/**
 * Mesures enregistrées et leur rangement.
 *
 * Une **mesure** est une capture Scope ou un enregistrement de télémétrie, figé avec ce qui
 * permet de la relire plus tard sans le banc : horodatage, signaux et unités, données,
 * configuration de la capture, firmware et dictionnaire du device, valeur de chaque
 * paramètre au moment de la mesure, et ce que l'utilisateur y a ajouté (titre,
 * commentaire, étiquettes). Une mesure dont on ne sait plus avec quels réglages elle a été
 * prise ne prouve rien.
 *
 * L'**arbre** range les mesures dans des dossiers, et seulement cela : supprimer un dossier
 * ne supprime aucune mesure, elles remontent d'un cran. Effacer des données de mesure est
 * une action distincte, explicite, mesure par mesure.
 *
 * Module pur — ni Electron ni système de fichiers — pour que tout se teste à part.
 */

import { z } from 'zod';

export const MEASUREMENT_SCHEMA = 1;

/** JSON n'a pas de NaN : un trou de mesure s'écrit `null` et se relit NaN. */
const sample = z.union([z.number(), z.null()]).transform((v) => (v === null ? Number.NaN : v));

const measurementSchema = z.object({
  schema: z.literal(MEASUREMENT_SCHEMA),
  id: z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/),
  kind: z.enum(['scope', 'telemetry']),
  /** Horodatage ISO 8601, en UTC. */
  createdAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not an ISO date'),
  title: z.string().max(200),
  comment: z.string().max(20000),
  tags: z.array(z.string().min(1).max(40)).max(32),
  device: z
    .object({
      product: z.string().max(64).optional(),
      fwVersion: z.string().max(64).optional(),
      protocol: z.string().max(16).optional(),
      dictHash: z.string().max(16).optional(),
      port: z.string().max(260).optional(),
    })
    .nullable(),
  /** Valeur de chaque paramètre au moment de la mesure, par nom. */
  params: z.record(z.string().max(64), z.number()),
  /** Configuration de la capture (requête scope, cadence de télémétrie…). */
  config: z.record(z.string().max(64), z.unknown()),
  signals: z.array(z.object({ name: z.string().min(1).max(64), unit: z.string().max(16) })).min(1).max(16),
  /** Abscisses en millisecondes : relatives au déclenchement (scope), au début (télémétrie). */
  t: z.array(z.number()).max(2_000_000),
  series: z.array(z.array(sample)),
  /** Repère vertical (instant de déclenchement), en ms ; `null` s'il n'y en a pas. */
  markerX: z.number().nullable(),
});

export type Measurement = z.infer<typeof measurementSchema>;

/** Ce que la liste affiche, sans les données. */
export interface MeasurementMeta {
  id: string;
  kind: Measurement['kind'];
  createdAt: string;
  title: string;
  comment: string;
  tags: string[];
  signals: string[];
  points: number;
  durationMs: number;
  fwVersion: string | null;
}

export function metaOf(m: Measurement): MeasurementMeta {
  const t0 = m.t[0] ?? 0;
  const t1 = m.t[m.t.length - 1] ?? 0;
  return {
    id: m.id,
    kind: m.kind,
    createdAt: m.createdAt,
    title: m.title,
    comment: m.comment,
    tags: m.tags,
    signals: m.signals.map((s) => s.name),
    points: m.t.length,
    durationMs: t1 - t0,
    fwVersion: m.device?.fwVersion ?? null,
  };
}

/** Lit une mesure. Les longueurs des séries doivent correspondre à `t` et aux signaux. */
export function parseMeasurement(raw: unknown): { ok: true; m: Measurement } | { ok: false; error: string } {
  const r = measurementSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    return { ok: false, error: `${i?.path.join('.') ?? ''}: ${i?.message ?? 'invalid'}` };
  }
  const m = r.data;
  if (m.series.length !== m.signals.length) {
    return { ok: false, error: `${m.series.length} series for ${m.signals.length} signals` };
  }
  if (m.series.some((s) => s.length !== m.t.length)) {
    return { ok: false, error: 'a series does not have one value per time point' };
  }
  return { ok: true, m };
}

export function serializeMeasurement(m: Measurement): string {
  // NaN → null : `JSON.stringify` le ferait aussi, mais on le dit.
  return JSON.stringify(m, (_k, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? null : v));
}

/** Titre par défaut : les signaux et l'heure, de quoi reconnaître une ligne dans la liste. */
export function defaultTitle(kind: Measurement['kind'], signals: readonly string[], at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const short = signals.map((s) => s.slice(s.indexOf('.') + 1)).join(', ');
  return `${kind === 'scope' ? 'Scope' : 'Telemetry'} ${short} — ${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`;
}

/** CSV d'une mesure : un en-tête commenté (`#`), puis une colonne par signal. */
export function measurementToCsv(m: Measurement): string {
  const lines: string[] = [];
  const meta = (k: string, v: string): void => {
    for (const line of v.split(/\r?\n/)) lines.push(`# ${k}: ${line}`);
  };
  meta('title', m.title);
  meta('created', m.createdAt);
  meta('kind', m.kind);
  if (m.device?.fwVersion !== undefined) meta('firmware', m.device.fwVersion);
  if (m.device?.dictHash !== undefined) meta('dictionary', m.device.dictHash);
  if (m.comment !== '') meta('comment', m.comment);
  if (m.tags.length > 0) meta('tags', m.tags.join(', '));
  const num = (v: number): string => {
    if (!Number.isFinite(v)) return '';
    const r = Number(v.toPrecision(7));
    return String(r);
  };
  lines.push(['time_ms', ...m.signals.map((s) => (s.unit === '' ? s.name : `${s.name} (${s.unit})`))].join(','));
  for (let i = 0; i < m.t.length; i++) {
    lines.push([num(m.t[i]!), ...m.series.map((s) => num(s[i] ?? Number.NaN))].join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** Nom de fichier sûr pour une mesure : date, puis titre nettoyé. */
export function measurementFileStem(m: Pick<Measurement, 'createdAt' | 'title' | 'kind'>): string {
  const d = new Date(m.createdAt);
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = Number.isNaN(d.getTime())
    ? 'undated'
    : `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const title = m.title
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `a2n-${m.kind}-${stamp}${title === '' ? '' : `-${title}`}`;
}

/* ------------------------------------------------------------------ arbre */

export interface Folder {
  id: string;
  name: string;
  /** Dossier parent, `null` à la racine. */
  parent: string | null;
}

export interface MeasTree {
  version: 1;
  folders: Folder[];
  /** Dossier de chaque mesure ; absente : à la racine. */
  placement: Record<string, string>;
}

export const EMPTY_TREE: MeasTree = { version: 1, folders: [], placement: {} };

const treeSchema = z.object({
  version: z.literal(1),
  folders: z.array(z.object({ id: z.string().min(1).max(64), name: z.string().min(1).max(120), parent: z.string().nullable() })),
  placement: z.record(z.string(), z.string()),
});

/**
 * Remet un arbre d'aplomb : dossier au parent inconnu ou formant une boucle → racine,
 * placement vers un dossier inconnu ou une mesure disparue → retiré.
 */
export function normalizeTree(raw: unknown, measurementIds?: ReadonlySet<string>): MeasTree {
  const r = treeSchema.safeParse(raw);
  if (!r.success) return { version: 1, folders: [], placement: {} };
  // Un identifiant en double : le premier gagne.
  const seen = new Set<string>();
  const folders = r.data.folders.filter((f) => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });
  const ids = new Set(folders.map((f) => f.id));
  const byId = new Map(folders.map((f) => [f.id, { ...f }]));
  for (const f of byId.values()) {
    if (f.parent !== null && !ids.has(f.parent)) f.parent = null;
  }
  // Boucles : on remonte ; si l'on repasse par un dossier déjà vu, on coupe à la racine.
  for (const f of byId.values()) {
    const path = new Set<string>([f.id]);
    let cur = f.parent;
    while (cur !== null) {
      if (path.has(cur)) {
        f.parent = null;
        break;
      }
      path.add(cur);
      cur = byId.get(cur)?.parent ?? null;
    }
  }
  const placement: Record<string, string> = {};
  for (const [m, f] of Object.entries(r.data.placement)) {
    if (ids.has(f) && (measurementIds === undefined || measurementIds.has(m))) placement[m] = f;
  }
  return { version: 1, folders: [...byId.values()], placement };
}

/** Le dossier et tous ceux qu'il contient, à toute profondeur. */
export function descendants(tree: MeasTree, id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of tree.folders) {
      if (f.parent !== null && out.has(f.parent) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

export function createFolder(tree: MeasTree, name: string, parent: string | null, id: string): MeasTree {
  const clean = name.trim().slice(0, 120) || 'New folder';
  const p = parent !== null && tree.folders.some((f) => f.id === parent) ? parent : null;
  return { ...tree, folders: [...tree.folders, { id, name: clean, parent: p }] };
}

export function renameFolder(tree: MeasTree, id: string, name: string): MeasTree {
  const clean = name.trim().slice(0, 120);
  if (clean === '') return tree;
  return { ...tree, folders: tree.folders.map((f) => (f.id === id ? { ...f, name: clean } : f)) };
}

/** Supprime un dossier ; ce qu'il contenait (dossiers et mesures) remonte dans son parent. */
export function deleteFolder(tree: MeasTree, id: string): MeasTree {
  const gone = tree.folders.find((f) => f.id === id);
  if (gone === undefined) return tree;
  const placement: Record<string, string> = {};
  for (const [m, f] of Object.entries(tree.placement)) {
    if (f !== id) placement[m] = f;
    else if (gone.parent !== null) placement[m] = gone.parent;
  }
  return {
    ...tree,
    folders: tree.folders.filter((f) => f.id !== id).map((f) => (f.parent === id ? { ...f, parent: gone.parent } : f)),
    placement,
  };
}

/** Déplace un dossier. Refusé (arbre inchangé) vers lui-même ou l'un de ses descendants. */
export function moveFolder(tree: MeasTree, id: string, parent: string | null): MeasTree {
  if (!tree.folders.some((f) => f.id === id)) return tree;
  if (parent !== null && (descendants(tree, id).has(parent) || !tree.folders.some((f) => f.id === parent))) return tree;
  return { ...tree, folders: tree.folders.map((f) => (f.id === id ? { ...f, parent } : f)) };
}

export function moveMeasurements(tree: MeasTree, ids: readonly string[], folder: string | null): MeasTree {
  if (folder !== null && !tree.folders.some((f) => f.id === folder)) return tree;
  const placement = { ...tree.placement };
  for (const m of ids) {
    if (folder === null) delete placement[m];
    else placement[m] = folder;
  }
  return { ...tree, placement };
}

export function forgetMeasurements(tree: MeasTree, ids: readonly string[]): MeasTree {
  const placement = { ...tree.placement };
  for (const m of ids) delete placement[m];
  return { ...tree, placement };
}

/**
 * Mesures visibles dans un dossier : `null` = toutes ; un dossier = lui et ses
 * sous-dossiers, pour qu'ouvrir « Essais » montre aussi « Essais/Charge ».
 */
export function measurementsIn(tree: MeasTree, folder: string | null, all: readonly string[]): string[] {
  if (folder === null) return [...all];
  const scope = descendants(tree, folder);
  return all.filter((m) => {
    const f = tree.placement[m];
    return f !== undefined && scope.has(f);
  });
}

/** Chemin lisible d'un dossier, de la racine vers lui. */
export function folderPath(tree: MeasTree, id: string | null): string[] {
  const out: string[] = [];
  const byId = new Map(tree.folders.map((f) => [f.id, f]));
  let cur = id;
  const guard = new Set<string>();
  while (cur !== null && !guard.has(cur)) {
    guard.add(cur);
    const f = byId.get(cur);
    if (f === undefined) break;
    out.unshift(f.name);
    cur = f.parent;
  }
  return out;
}

export type SortKey = 'createdAt' | 'title' | 'kind' | 'points';

export function sortMeta(list: readonly MeasurementMeta[], key: SortKey, desc: boolean): MeasurementMeta[] {
  const dir = desc ? -1 : 1;
  return [...list].sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return c === 0 ? a.createdAt.localeCompare(b.createdAt) * dir : c * dir;
  });
}

/** Filtre texte : titre, commentaire, étiquettes, signaux. */
export function filterMeta(list: readonly MeasurementMeta[], query: string): MeasurementMeta[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...list];
  return list.filter((m) =>
    [m.title, m.comment, ...m.tags, ...m.signals].some((s) => s.toLowerCase().includes(q)),
  );
}
