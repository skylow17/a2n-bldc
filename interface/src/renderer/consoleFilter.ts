/**
 * Filtres de la console.
 *
 * Le journal mélange trois choses qui n'ont pas la même valeur pour qui regarde : ce que
 * l'opérateur a tapé, ce que la carte a répondu, et ce que l'interface se demande à
 * elle-même pour tenir ses tableaux à jour — battement de sécurité huit fois par seconde,
 * relevé de supervision deux fois. Le troisième groupe est légitime et doit rester
 * consultable, mais il ne doit pas noyer les deux autres.
 *
 * Trois règles ont guidé la forme :
 *
 *  - **`debug` masqué par défaut**, puisque c'est là que vit le trafic automatique. Tout le
 *    reste est visible, parce qu'un filtre qui cache une erreur par défaut est pire que pas
 *    de filtre du tout.
 *  - **Le filtre se déclare.** Le nombre de lignes masquées est toujours affiché : un
 *    filtre qu'on a oublié d'enlever transforme un journal en mensonge par omission.
 *  - **Le réglage survit à la session.** On change de vue vingt fois pendant un réglage, et
 *    reconfigurer un filtre à chaque retour finit par décourager de s'en servir.
 */

import type { LogEntry, LogLevel, LogSource } from '../main/device/DeviceCore.js';

export const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'] as const;
export const SOURCES: readonly LogSource[] = ['device', 'gui', 'mcp'] as const;

export interface ConsoleFilter {
  levels: LogLevel[];
  sources: LogSource[];
  /** Sous-chaîne à chercher dans le texte, insensible à la casse. Vide = pas de filtre. */
  match: string;
}

export const DEFAULT_FILTER: ConsoleFilter = {
  levels: ['info', 'warn', 'error'],
  sources: [...SOURCES],
  match: '',
};

export function isDefault(f: ConsoleFilter): boolean {
  return (
    f.match === '' &&
    f.levels.length === DEFAULT_FILTER.levels.length &&
    f.sources.length === SOURCES.length &&
    DEFAULT_FILTER.levels.every((l) => f.levels.includes(l))
  );
}

/** Vrai si rien n'est masqué du tout — la seule situation où le compteur peut se taire. */
export function showsEverything(f: ConsoleFilter): boolean {
  return f.match === '' && f.levels.length === LEVELS.length && f.sources.length === SOURCES.length;
}

export function applyFilter(entries: LogEntry[], f: ConsoleFilter): LogEntry[] {
  const needle = f.match.trim().toLowerCase();
  return entries.filter(
    (e) =>
      f.levels.includes(e.level) &&
      f.sources.includes(e.source) &&
      (needle === '' || e.text.toLowerCase().includes(needle)),
  );
}

/** Ajoute ou retire une valeur. Une liste vide est permise : elle veut dire « rien ». */
export function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

const STORAGE_KEY = 'a2n.console.filter';

export function load(): ConsoleFilter {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_FILTER;
    const p = JSON.parse(raw) as Partial<ConsoleFilter>;
    // Relu défensivement : un réglage écrit par une version antérieure, ou trafiqué à la
    // main, ne doit pas faire disparaître silencieusement des lignes du journal.
    const levels = Array.isArray(p.levels) ? p.levels.filter((l) => LEVELS.includes(l)) : null;
    const sources = Array.isArray(p.sources) ? p.sources.filter((s) => SOURCES.includes(s)) : null;
    return {
      levels: levels ?? DEFAULT_FILTER.levels,
      sources: sources ?? DEFAULT_FILTER.sources,
      match: typeof p.match === 'string' ? p.match : '',
    };
  } catch {
    return DEFAULT_FILTER;
  }
}

export function save(f: ConsoleFilter): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(f));
  } catch {
    // Stockage indisponible : le filtre reste valable pour cette session, et perdre un
    // réglage d'affichage ne mérite pas de remonter jusqu'à l'utilisateur.
  }
}
