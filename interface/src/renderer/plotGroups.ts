/**
 * Graphes d'une mesure affichée : quelles courbes, dans quels graphes.
 *
 * Deux choix de l'utilisateur, à la relecture d'une mesure :
 *
 * - **masquer** des courbes, pour regarder les autres sans elles ;
 * - **séparer** : un graphe par courbe au lieu d'un graphe par unité. Chaque courbe a alors
 *   sa propre échelle verticale — les formes se comparent, plus les niveaux.
 *
 * Fonction pure, testée. Les indices rendus sont ceux des séries de la mesure.
 */

import { groupByUnit } from './components/Chart.js';

export function plotGroups(
  names: readonly string[],
  units: readonly string[],
  hidden: ReadonlySet<string>,
  split: boolean,
): Array<{ key: string; unit: string; indices: number[] }> {
  const visible = names.map((_n, i) => i).filter((i) => !hidden.has(names[i]!));
  if (split) {
    return visible.map((i) => ({ key: `${names[i]}~${i}`, unit: units[i] ?? '', indices: [i] }));
  }
  const vn = visible.map((i) => names[i]!);
  const vu = visible.map((i) => units[i] ?? '');
  return groupByUnit(vn, vu).map(([unit, local]) => ({
    key: unit,
    unit,
    indices: local.map((j) => visible[j]!),
  }));
}
