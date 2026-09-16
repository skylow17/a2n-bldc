/**
 * Tracé temps réel, sur uPlot.
 *
 * uPlot n'est pas un composant React : il possède son canvas et se met à jour par appels.
 * On le crée donc une fois, et chaque lot de trames appelle `setData` — reconstruire le
 * graphe à chaque rendu jetterait le canvas trente fois par seconde et ferait clignoter la
 * courbe.
 *
 * **Une seule échelle verticale par graphe.** C'est la règle qui décide de la forme de
 * cette vue : un graphe à deux axes Y laisse croire qu'on peut comparer des courbes qui
 * n'ont pas la même unité. Le Dashboard trace donc un graphe par unité — les counts bruts
 * de l'ADC d'un côté, les nanosecondes de l'autre, le pourcentage de charge encore
 * ailleurs. C'est aussi ce que dit la physique : un count et une microseconde ne se
 * comparent pas.
 *
 * Libellés en anglais (AGENTS.md §5).
 */

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import uPlot from 'uplot';

import 'uplot/dist/uPlot.min.css';

/**
 * Palette catégorielle, ordre fixe, jamais recyclée.
 *
 * Huit teintes pensées pour un fond sombre et validées comme un ensemble contre la surface
 * réelle des panneaux (#14181e) : bande de clarté, plancher de chroma, séparation en vision
 * des couleurs déficiente et contraste ≥ 3:1 passent tous.
 *
 * L'ordre est fixe : un signal garde sa couleur quel que soit le nombre de courbes
 * affichées. Une couleur attribuée par rang changerait de sens dès qu'on retire un signal.
 *
 * Aucune n'est reprise des couleurs d'état de l'interface — l'ambre demande une action, le
 * vert et le rouge disent OK et faute. Une courbe rouge ne doit pas se lire comme un défaut.
 */
export const SERIES_COLORS = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
] as const;

export function seriesColor(index: number): string {
  // Au-delà de huit courbes, aucune teinte supplémentaire n'est fabriquée : l'appelant
  // regroupe ou facette. Le gris dit « cette courbe n'a plus d'identité propre ».
  return SERIES_COLORS[index] ?? '#636d7b';
}

export interface TimeSeriesChartProps {
  /** Temps en secondes, commun à toutes les séries. */
  t: readonly number[];
  /** Une série de valeurs par courbe, alignée sur `t`. */
  series: ReadonlyArray<readonly number[]>;
  /** Nom de chaque courbe, dans l'ordre de `series`. */
  labels: readonly string[];
  /** Couleur de chaque courbe — fournie par l'appelant pour rester stable par signal. */
  colors: readonly string[];
  /** Unité commune à l'axe vertical. */
  unit: string;
  /**
   * Étiquette de l'axe des temps.
   *
   * Des graphes empilés partagent le même axe X : le répéter sous chacun consomme de la
   * hauteur pour redire trois fois la même chose. On ne l'écrit que sous le dernier.
   */
  showXLabel?: boolean;
  /** Texte de cette étiquette. Une capture scope compte en ms, un flux en s. */
  xLabel?: string;
  /**
   * Repère vertical, en unités de l'axe X.
   *
   * Sert à marquer l'instant de déclenchement d'une capture. Sans lui, un pré-trigger ne
   * se lit pas : rien ne dit où finit l'avant et où commence l'après.
   */
  markerX?: number | null;
  height?: number;
}

/** Regroupe des signaux par unité — une échelle verticale par groupe. */
export function groupByUnit(
  names: readonly string[],
  units: readonly string[],
): Array<[string, number[]]> {
  const byUnit = new Map<string, number[]>();
  names.forEach((_n, i) => {
    const unit = units[i] ?? '';
    const bucket = byUnit.get(unit);
    if (bucket === undefined) byUnit.set(unit, [i]);
    else bucket.push(i);
  });
  return [...byUnit.entries()];
}

/* Jetons du thème, lus une fois. uPlot dessine sur un canvas : il lui faut des couleurs
 * résolues, une variable CSS ne lui sert à rien. */
function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === '' ? fallback : v;
}

export function TimeSeriesChart({
  t,
  series,
  labels,
  colors,
  unit,
  showXLabel = true,
  xLabel = 'time (s)',
  markerX = null,
  height = 200,
}: TimeSeriesChartProps): ReactNode {
  const host = useRef<HTMLDivElement | null>(null);
  const plot = useRef<uPlot | null>(null);
  // Le repère est lu à chaque tracé : il passe par une référence pour que le greffon n'ait
  // pas à être recréé — et donc le graphe non plus — quand il bouge.
  const marker = useRef<number | null>(markerX);
  marker.current = markerX;

  // L'identité du graphe tient aux courbes qu'il porte, pas à leurs valeurs : tant que la
  // liste ne change pas, le même uPlot est réutilisé et seules les données bougent.
  const key = labels.join(',');

  useLayoutEffect(() => {
    const el = host.current;
    if (el === null || labels.length === 0) return undefined;

    const grid = token('--color-line-soft', '#1f252d');
    const ink3 = token('--color-fg-3', '#636d7b');
    const ink2 = token('--color-fg-2', '#96a0af');

    const axis = {
      stroke: ink3,
      grid: { stroke: grid, width: 1 },
      ticks: { stroke: grid, width: 1 },
      font: '11px ui-monospace, Consolas, monospace',
    };

    const u = new uPlot(
      {
        width: el.clientWidth || 600,
        height,
        // Le temps est un écoulement en secondes depuis le début du flux, pas une date.
        scales: { x: { time: false } },
        legend: { live: true },
        cursor: {
          // Le survol lit une valeur ; il ne sélectionne pas une plage. Un glissement qui
          // zoome ferait décrocher une courbe qui défile, sans moyen évident de revenir.
          drag: { x: false, y: false },
          points: { size: 6 },
        },
        axes: [
          showXLabel
            ? { ...axis, label: xLabel, labelFont: '11px ui-monospace, monospace', labelSize: 20, labelGap: 0 }
            : { ...axis },
          { ...axis, label: unit, labelFont: '11px ui-monospace, monospace', labelSize: 20, labelGap: 0, size: 56 },
        ],
        hooks: {
          draw: [
            (self: uPlot) => {
              const x = marker.current;
              if (x === null) return;
              const px = self.valToPos(x, 'x', true);
              const c = self.ctx;
              c.save();
              c.strokeStyle = ink2;
              c.lineWidth = 1;
              c.setLineDash([4, 3]);
              c.beginPath();
              c.moveTo(px, self.bbox.top);
              c.lineTo(px, self.bbox.top + self.bbox.height);
              c.stroke();
              c.restore();
            },
          ],
        },
        series: [
          { label: 's' },
          ...labels.map((label, i) => ({
            label,
            stroke: colors[i] ?? ink2,
            width: 2,
            points: { show: false },
          })),
        ],
      },
      [[], ...labels.map(() => [])] as uPlot.AlignedData,
      el,
    );
    plot.current = u;

    // Le panneau se redimensionne avec la fenêtre : sans cela le canvas garde sa largeur
    // initiale et la courbe se retrouve tronquée ou perdue dans du vide.
    const ro = new ResizeObserver(() => {
      u.setSize({ width: el.clientWidth || 600, height });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
  }, [key, unit, height, colors, labels, showXLabel, xLabel]);

  useEffect(() => {
    const u = plot.current;
    if (u === null) return;
    u.setData([t as number[], ...(series as number[][])] as uPlot.AlignedData);
  }, [t, series, markerX]);

  return <div ref={host} className="a2n-chart w-full" />;
}
