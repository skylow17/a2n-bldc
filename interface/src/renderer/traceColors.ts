/**
 * Couleur et trait de chaque courbe.
 *
 * Jusqu'ici la couleur d'un signal était son **rang dans le dictionnaire** du firmware. Avec
 * vingt-deux signaux pour huit teintes, tout signal au-delà du huitième sortait gris — dont
 * `foc.iq_a` et sa consigne, ceux qu'on regarde le plus — et deux courbes d'un même graphe
 * pouvaient recevoir des teintes voisines. Le Scope devenait illisible.
 *
 * La règle est maintenant **une couleur = un sens physique**, stable d'une capture à
 * l'autre :
 *
 * - les trois phases ont trois teintes fixes, brutes comme corrigées ;
 * - chaque grandeur de commande a la sienne (Iq, Id, Vq, Vd, vitesse, position…) ;
 * - une **consigne** prend la teinte de la mesure qu'elle commande, **en pointillé** :
 *   `foc.iq_ref_a` se lit contre `foc.iq_a`, et c'est l'écart entre les deux qu'on regarde ;
 * - un signal que la table ne connaît pas prend la première teinte libre de son graphe.
 *
 * Deux garanties : jamais de gris (douze teintes, et des graphes de quatre courbes au plus
 * côté Scope, huit côté Dashboard), et **jamais deux courbes de même couleur dans un même
 * graphe**, sauf une consigne et sa mesure — c'est voulu. Un graphe, c'est une unité
 * (`groupByUnit`) : deux signaux d'unités différentes peuvent partager une teinte sans
 * risque de confusion.
 *
 * L'utilisateur peut imposer une couleur par signal (`plots.traceColors` dans la config) :
 * elle passe avant tout le reste. Fonctions pures, testées ; la résolution des créneaux en
 * couleurs du thème se fait dans `Chart.tsx`.
 */

/** Nombre de teintes de la palette (`--color-series-1..12`). */
export const SLOT_COUNT = 12;

/** Une couleur imposée : un créneau de palette (suit le thème) ou une couleur fixe. */
export type ColorSpec = `slot:${number}` | `#${string}`;

export interface TraceStyle {
  color: ColorSpec;
  /** Pointillé : une consigne. */
  dash: boolean;
}

/** Créneau sémantique par motif de nom, dans l'ordre de priorité. */
const RULES: Array<[RegExp, number]> = [
  [/(^|\.)(raw_)?ia(_|$)/, 1],
  [/(^|\.)(raw_)?ib(_|$)/, 2],
  [/(^|\.)(raw_)?ic(_|$)/, 3],
  [/(^|\.)iq(_|$)/, 4],
  [/(^|\.)id(_|$)/, 5],
  [/(^|\.)vq(_|$)/, 6],
  [/(^|\.)vd(_|$)/, 7],
  [/(^|\.)vel(_|$)/, 8],
  [/(^|\.)pos(_|$)/, 9],
  [/(^|\.)theta_e(_|$)/, 10],
  [/^ol\.theta/, 11],
  [/^loop\./, 12],
];

/**
 * Consignes dont la mesure ne se déduit pas du nom en retirant `_ref` : la consigne de
 * vitesse s'appelle `w_ref`, la mesure `vel`.
 */
const REF_PAIRS: Record<string, string> = {
  'foc.w_ref_rad_s': 'enc.vel_rad_s',
};

/** La mesure qu'une consigne commande, ou `null` si ce n'est pas une consigne. */
export function referenceOf(name: string): string | null {
  const paired = REF_PAIRS[name];
  if (paired !== undefined) return paired;
  if (!/_ref(_|$)/.test(name)) return null;
  return name.replace(/_ref(?=_|$)/, '');
}

/** Créneau sémantique d'un signal, ou `null` s'il n'en a pas. */
export function semanticSlot(name: string): number | null {
  const base = referenceOf(name) ?? name;
  for (const [re, slot] of RULES) if (re.test(base)) return slot;
  return null;
}

/**
 * Style de chaque courbe d'une sélection, regroupée par unité.
 *
 * @param names     signaux tracés, dans l'ordre de sélection
 * @param units     unité de chacun — elle définit le graphe où il sera tracé
 * @param overrides couleurs imposées par l'utilisateur, par nom de signal
 */
export function assignTraceStyles(
  names: readonly string[],
  units: readonly string[],
  overrides: Readonly<Record<string, string>> = {},
): TraceStyle[] {
  const out: TraceStyle[] = new Array<TraceStyle>(names.length);
  // Couleurs déjà prises, par graphe (unité), et par quel signal de base.
  const taken = new Map<string, Map<string, string>>();
  const takenIn = (unit: string): Map<string, string> => {
    let m = taken.get(unit);
    if (m === undefined) taken.set(unit, (m = new Map()));
    return m;
  };

  // Deux passes : d'abord ce qui a une couleur voulue (imposée ou sémantique), puis le
  // reste, qui se range dans ce qui est libre. Sans cela, un signal inconnu sélectionné en
  // premier prendrait le bleu de la phase A tracée après lui.
  const pending: number[] = [];
  names.forEach((name, i) => {
    const unit = units[i] ?? '';
    const used = takenIn(unit);
    const owner = referenceOf(name) ?? name;
    const dash = referenceOf(name) !== null;
    const forced = overrides[name] ?? (dash ? overrides[owner] : undefined);
    const slot = semanticSlot(name);
    const want: ColorSpec | null =
      forced !== undefined ? (forced as ColorSpec) : slot !== null ? `slot:${slot}` : null;
    // La couleur voulue est libre, ou tenue par la même grandeur (consigne et mesure).
    if (want !== null && (forced !== undefined || !used.has(want) || used.get(want) === owner)) {
      out[i] = { color: want, dash };
      used.set(want, owner);
    } else {
      pending.push(i);
    }
  });

  for (const i of pending) {
    const name = names[i]!;
    const unit = units[i] ?? '';
    const used = takenIn(unit);
    const owner = referenceOf(name) ?? name;
    let color: ColorSpec = `slot:${SLOT_COUNT}`;
    for (let s = 1; s <= SLOT_COUNT; s++) {
      const c: ColorSpec = `slot:${s}`;
      if (!used.has(c)) {
        color = c;
        break;
      }
    }
    out[i] = { color, dash: referenceOf(name) !== null };
    used.set(color, owner);
  }
  return out;
}

/** Vrai pour une valeur acceptable dans `plots.traceColors`. */
export function isColorSpec(v: string): v is ColorSpec {
  return /^#[0-9a-fA-F]{6}$/.test(v) || /^slot:(1[0-2]|[1-9])$/.test(v);
}
