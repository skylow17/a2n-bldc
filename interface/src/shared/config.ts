/**
 * Configuration de l'interface, persistée dans un fichier `config.json`.
 *
 * Le fichier vit dans le dossier de données choisi par l'utilisateur (par défaut
 * `Documents/A2N BLDC`) : on peut le lire, le sauvegarder, l'exporter vers un autre poste et
 * le réimporter. Ce module est pur — ni Electron ni système de fichiers — pour que la
 * lecture tolérante se teste à part.
 *
 * ### Lecture tolérante, champ par champ
 *
 * Un fichier de config se modifie à la main et se transporte d'une version à l'autre. Le
 * refuser en bloc pour une seule valeur fausse ferait perdre tout le reste ; l'accepter tel
 * quel ferait entrer n'importe quoi. On valide donc **chaque champ** : un champ invalide
 * reprend son défaut, une clé inconnue est ignorée, et chaque écart produit un avertissement
 * lisible, que l'interface montre à l'import. Rien n'est ignoré en silence.
 *
 * Aucune limite de sécurité ne vit ici : elles sont dans le firmware (`AGENTS.md` §4.2).
 */

import { z } from 'zod';

export const CONFIG_VERSION = 1;

/** Couleur imposée à une courbe : `#rrggbb`, ou `slot:N`, un créneau de la palette du thème. */
const hexColor = z
  .string()
  .regex(/^(#[0-9a-fA-F]{6}|slot:(1[0-2]|[1-9]))$/, 'expected #rrggbb or slot:1..12');

/** Un nombre pris dans une liste fermée — les choix qu'offrent les menus de l'interface. */
const oneOf = (values: readonly number[]) =>
  z.number().refine((n) => values.includes(n), { message: `expected one of ${values.join(', ')}` });

export const SCOPE_DEPTHS = [256, 512, 1024, 2048] as const;
export const SCOPE_DECIMATIONS = [1, 2, 4, 8, 16, 32, 64] as const;
export const SCOPE_PRETRIGGER_PCT = [0, 10, 25, 50] as const;
export const TELEMETRY_RATES = [100, 200, 500] as const;
export const TELEMETRY_WINDOWS = [1, 2, 5, 15, 30, 60] as const;

/** Schéma de chaque champ, section par section. Les défauts sont dans `DEFAULT_CONFIG`. */
const FIELDS = {
  ui: {
    theme: z.enum(['dark', 'light']),
    /** `icons` : les explications sont repliées derrière une icône ; `inline` : affichées. */
    helpMode: z.enum(['icons', 'inline']),
    /** Facteur de zoom de la fenêtre (Ctrl +/−). */
    zoom: z.number().min(0.5).max(2),
  },
  plots: {
    /** Couleur imposée par signal, par nom. Absent : couleur automatique. */
    traceColors: z.record(z.string().min(1).max(64), hexColor),
    lineWidth: z.number().min(0.5).max(4),
    /** Opacité du fond de la sélection de zoom, en fraction. */
    selectionOpacity: z.number().min(0.05).max(0.6),
  },
  scope: {
    depth: oneOf(SCOPE_DEPTHS),
    decimation: oneOf(SCOPE_DECIMATIONS),
    pretriggerPct: oneOf(SCOPE_PRETRIGGER_PCT),
  },
  telemetry: {
    rateHz: oneOf(TELEMETRY_RATES),
    windowS: oneOf(TELEMETRY_WINDOWS),
  },
  measurements: {
    /** Chaque capture Scope réussie entre dans l'historique. */
    autoSaveScope: z.boolean(),
    /** Durée maximale d'un enregistrement de télémétrie, en secondes. */
    recordMaxS: z.number().int().min(5).max(3600),
  },
  mcp: {
    enabled: z.boolean(),
    port: z.number().int().min(1024).max(65535),
  },
  layout: {
    consoleOpen: z.boolean(),
    consoleH: z.number().int().min(96).max(4000),
    /** Hauteur du tile des mesures dans la vue Scope. */
    measurementsH: z.number().int().min(80).max(4000),
  },
} as const;

type Section = keyof typeof FIELDS;
type SectionOf<S extends Section> = { [K in keyof (typeof FIELDS)[S]]: z.infer<(typeof FIELDS)[S][K]> };

export type AppConfig = { version: number } & { [S in Section]: SectionOf<S> };

export const DEFAULT_CONFIG: AppConfig = {
  version: CONFIG_VERSION,
  ui: { theme: 'dark', helpMode: 'icons', zoom: 1 },
  plots: { traceColors: {}, lineWidth: 1.5, selectionOpacity: 0.2 },
  scope: { depth: 2048, decimation: 1, pretriggerPct: 0 },
  telemetry: { rateHz: 200, windowS: 5 },
  measurements: { autoSaveScope: true, recordMaxS: 300 },
  mcp: { enabled: true, port: 4817 },
  layout: { consoleOpen: true, consoleH: 288, measurementsH: 220 },
};

/** Patch partiel : une section, ou quelques champs d'une section. */
export type ConfigPatch = { [S in Section]?: Partial<SectionOf<S>> };

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Valide un objet quelconque contre la configuration, champ par champ.
 *
 * Rend toujours une configuration complète et valide ; `warnings` dit ce qui a été écarté.
 */
export function normalizeConfig(raw: unknown): { config: AppConfig; warnings: string[] } {
  const config = clone(DEFAULT_CONFIG);
  const warnings: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push('not a JSON object: defaults used');
    return { config, warnings };
  }
  const obj = raw as Record<string, unknown>;
  if (obj['version'] !== undefined && obj['version'] !== CONFIG_VERSION) {
    warnings.push(`version ${String(obj['version'])} read as version ${CONFIG_VERSION}`);
  }
  for (const key of Object.keys(obj)) {
    if (key !== 'version' && !(key in FIELDS)) warnings.push(`unknown section "${key}" ignored`);
  }
  for (const section of Object.keys(FIELDS) as Section[]) {
    const given = obj[section];
    if (given === undefined) continue;
    if (typeof given !== 'object' || given === null || Array.isArray(given)) {
      warnings.push(`${section}: not an object, defaults used`);
      continue;
    }
    const fields = FIELDS[section] as Record<string, z.ZodType>;
    const target = config[section] as Record<string, unknown>;
    for (const [field, value] of Object.entries(given as Record<string, unknown>)) {
      const schema = fields[field];
      if (schema === undefined) {
        warnings.push(`${section}.${field}: unknown, ignored`);
        continue;
      }
      if (section === 'plots' && field === 'traceColors') {
        // Une couleur fausse ne doit pas faire perdre les autres : entrée par entrée.
        const out: Record<string, string> = {};
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          for (const [name, c] of Object.entries(value as Record<string, unknown>)) {
            if (hexColor.safeParse(c).success && name.length > 0 && name.length <= 64) out[name] = c as string;
            else warnings.push(`plots.traceColors.${name}: ${JSON.stringify(c)} is not #rrggbb or slot:N, ignored`);
          }
        } else {
          warnings.push('plots.traceColors: not an object, ignored');
        }
        target[field] = out;
        continue;
      }
      const parsed = schema.safeParse(value);
      if (parsed.success) target[field] = parsed.data;
      else warnings.push(`${section}.${field}: ${JSON.stringify(value)} rejected, default kept`);
    }
  }
  return { config, warnings };
}

/** Lit le texte d'un `config.json`. Un JSON illisible donne les défauts et un avertissement. */
export function parseConfig(text: string): { config: AppConfig; warnings: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      config: clone(DEFAULT_CONFIG),
      warnings: [`not valid JSON (${e instanceof Error ? e.message : String(e)}): defaults used`],
    };
  }
  return normalizeConfig(raw);
}

export function serializeConfig(c: AppConfig): string {
  return `${JSON.stringify(c, null, 2)}\n`;
}

/**
 * Applique un patch, puis revalide : un patch venu du renderer passe par le même juge qu'un
 * fichier. `traceColors` est **remplacé** et non fusionné, pour qu'on puisse retirer une
 * couleur imposée en renvoyant la table sans elle.
 */
export function mergeConfig(base: AppConfig, patch: ConfigPatch): { config: AppConfig; warnings: string[] } {
  const merged = clone(base) as unknown as Record<string, Record<string, unknown>>;
  for (const [section, fields] of Object.entries(patch)) {
    if (fields === undefined || !(section in FIELDS)) continue;
    merged[section] = { ...(merged[section] ?? {}), ...(fields as Record<string, unknown>) };
  }
  return normalizeConfig(merged);
}
