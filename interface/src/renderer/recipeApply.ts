/**
 * Application d'une recette sur le device, ligne par ligne.
 *
 * Commun à la vue Recipes et au panneau de réglage des boucles : un seul chemin d'écriture,
 * celui de la vue Tuning (`writeParam`), donc la même journalisation et le même juge — le
 * firmware. Une écriture groupée n'est pas une transaction (`docs/protocol.md` §5) : chaque
 * valeur reçoit son propre résultat, et une valeur refusée n'arrête pas les suivantes.
 */

import type { DeviceSnapshot } from '../main/device/DeviceCore.js';
import type { DeviceParamView, DiffRow, Recipe } from '../shared/recipe.js';
import { api } from './useDevice.js';

export interface ApplyResult {
  name: string;
  ok: boolean;
  /** Valeur relue après écriture, ou raison du refus. */
  detail: string;
}

export function deviceParams(state: DeviceSnapshot): DeviceParamView[] {
  return state.params.map((p) => ({
    name: p.name,
    unit: p.unit,
    type: p.type,
    flags: p.flags,
    min: p.min,
    max: p.max,
    value: p.value,
  }));
}

/** N'écrit que les lignes `change` sélectionnées : jamais une inconnue, une lecture seule ou un hors-bornes. */
export async function applyRows(recipe: Recipe, rows: readonly DiffRow[], selected: ReadonlySet<string>): Promise<ApplyResult[]> {
  const out: ApplyResult[] = [];
  for (const r of rows) {
    if (r.status !== 'change' || !selected.has(r.name)) continue;
    const value = recipe.params[r.name]!;
    try {
      const after = await api().writeParam(r.name, value);
      out.push({ name: r.name, ok: true, detail: `${after}${r.unit === '' ? '' : ` ${r.unit}`}` });
    } catch (e) {
      out.push({ name: r.name, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
