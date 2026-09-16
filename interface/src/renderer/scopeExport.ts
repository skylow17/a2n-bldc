/**
 * Export d'une capture scope en CSV.
 *
 * Un tableau et rien d'autre : une colonne de temps, une colonne par signal, pas de lignes
 * de commentaire en tête. Un en-tête décoratif oblige chaque outil qui relit le fichier à
 * savoir le sauter, et c'est exactement ce qui rend un export inutilisable ailleurs.
 *
 * L'unité voyage dans le nom de colonne, comme dans le protocole : une valeur sans unité
 * est une valeur qu'on finit par mal interpréter.
 */

export interface ScopeExport {
  /** Temps de chaque point, en millisecondes relatives au déclenchement. */
  t: readonly number[];
  /** Une série par signal, alignée sur `t`. */
  series: ReadonlyArray<readonly number[]>;
  names: readonly string[];
  units: readonly string[];
}

/**
 * Formate un nombre pour le CSV.
 *
 * Six chiffres significatifs : un `f32` venu du firmware n'en porte qu'environ sept de
 * vérité, et les décimales suivantes sont du bruit de représentation binaire qui gonfle le
 * fichier sans rien ajouter. La notation exponentielle est évitée — trop d'outils la lisent
 * comme du texte.
 */
function num(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  const r = Number(v.toPrecision(6));
  return Math.abs(r) < 1e-4 || Math.abs(r) >= 1e15 ? r.toFixed(9).replace(/0+$/, '') : String(r);
}

function header(names: readonly string[], units: readonly string[]): string {
  const cols = names.map((n, i) => {
    const u = units[i] ?? '';
    return u === '' ? n : `${n} (${u})`;
  });
  return ['time_ms', ...cols].join(',');
}

export function captureToCsv(capture: ScopeExport): string {
  const lines = [header(capture.names, capture.units)];

  for (let i = 0; i < capture.t.length; i++) {
    const row = [num(capture.t[i] ?? NaN)];
    for (const s of capture.series) row.push(num(s[i] ?? NaN));
    lines.push(row.join(','));
  }

  // Terminaison par une fin de ligne : un fichier texte qui n'en a pas fait râler la moitié
  // des outils en ligne de commande.
  return `${lines.join('\n')}\n`;
}

/**
 * Nom de fichier proposé.
 *
 * Il porte l'horodatage et la profondeur parce que c'est ce qui distingue deux captures
 * d'une même session de réglage — et qu'une boîte de dialogue qui propose toujours le même
 * nom conduit à écraser la capture précédente.
 */
export function captureFileName(sampleCount: number, at = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `a2n-scope-${stamp}-${sampleCount}pts.csv`;
}
