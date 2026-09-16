/**
 * Réduction des captures avant de les rendre à un agent.
 *
 * Une capture scope pleine, c'est 2 048 points × 4 signaux, soit 8 192 flottants. Les
 * rendre tels quels dans un résultat d'outil noierait la fenêtre de contexte de l'agent
 * pour un bénéfice nul : personne ne lit huit mille nombres. Ce module donne par défaut ce
 * qu'on regarde réellement en premier — bornes, moyenne, dernière valeur — et ne laisse
 * passer les points bruts que si on les demande, décimés à un plafond explicite.
 *
 * Le fichier de capture complet reste accessible par la CLI et, plus tard, par l'export de
 * l'interface. L'agent n'est pas le bon canal pour un dump.
 */

export interface SeriesSummary {
  name: string;
  unit: string;
  min: number;
  max: number;
  mean: number;
  /** Dernière valeur de la série — celle qui répond à « où en est-on ». */
  last: number;
}

/**
 * Arrondit à 6 chiffres significatifs.
 *
 * Un `f32` venu du firmware n'a qu'environ 7 chiffres significatifs de vérité ; les
 * décimales suivantes affichées par `toString()` sont du bruit de représentation binaire,
 * et elles coûtent des octets dans chaque résultat d'outil.
 */
export function round6(v: number): number {
  if (!Number.isFinite(v)) return v;
  if (v === 0) return 0;
  return Number(v.toPrecision(6));
}

export function summarizeSeries(name: string, unit: string, values: readonly number[]): SeriesSummary {
  if (values.length === 0) {
    return { name, unit, min: NaN, max: NaN, mean: NaN, last: NaN };
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return {
    name,
    unit,
    min: round6(min),
    max: round6(max),
    mean: round6(sum / values.length),
    last: round6(values[values.length - 1] as number),
  };
}

/**
 * Décime une série à `maxPoints` au plus, en conservant le premier et le dernier point.
 *
 * Conserver les extrémités n'est pas cosmétique : sans cela, la fin d'une réponse
 * indicielle — c'est-à-dire la valeur établie, celle qu'on cherche — peut disparaître de
 * l'échantillon rendu.
 */
export function decimateSeries(values: readonly number[], maxPoints: number): number[] {
  if (maxPoints < 2) {
    return values.length === 0 ? [] : [round6(values[values.length - 1] as number)];
  }
  if (values.length <= maxPoints) {
    return values.map(round6);
  }
  const out: number[] = [];
  const last = values.length - 1;
  for (let i = 0; i < maxPoints; i++) {
    // Répartition sur [0, last] bornes incluses : i = 0 donne 0, i = maxPoints-1 donne last.
    const idx = Math.round((i * last) / (maxPoints - 1));
    out.push(round6(values[idx] as number));
  }
  return out;
}

/** Extrait la colonne `index` d'une capture rangée par point. */
export function column(samples: readonly (readonly number[])[], index: number): number[] {
  const out: number[] = [];
  for (const point of samples) {
    const v = point[index];
    if (v !== undefined) out.push(v);
  }
  return out;
}
