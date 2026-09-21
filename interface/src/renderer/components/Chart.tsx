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
/** Nombre de créneaux de la palette. Au-delà, on ne fabrique pas de teinte. */
export const SERIES_SLOT_COUNT = 8;

export function seriesColor(index: number): string {
  // Au-delà de huit courbes, aucune teinte supplémentaire n'est fabriquée : l'appelant
  // regroupe ou facette. Le gris dit « cette courbe n'a plus d'identité propre ».
  if (index < 0 || index >= SERIES_SLOT_COUNT) return token('--color-fg-3', '#636d7b');
  // Lue sur la racine, donc suivant le thème : le jeu clair et le jeu sombre sont deux
  // palettes choisies, pas l'une l'inversion de l'autre.
  return token(`--color-series-${index + 1}`, '#3987e5');
}

/**
 * Prochaine etendue verticale, avec hysteresis.
 *
 * Sans elle, uPlot recalcule le minimum et le maximum a chaque lot de trames : sur un
 * signal bruite, les bornes bougent trente fois par seconde et toute la courbe respire.
 * Ce n'est pas du bruit de mesure qu'on voit alors, c'est l'axe qui remue.
 *
 * Deux regles, et elles tirent dans des sens opposes :
 *  - on **garde** l'etendue precedente tant que les donnees y tiennent, pour que l'axe ne
 *    bouge pas a chaque trame ;
 *  - on la **reprend** quand les donnees en sortent, ou quand elles n'en occupent plus
 *    qu'une petite part — sinon un transitoire ecraserait la suite du trace pour toujours.
 *
 * Le plancher d'etendue evite le dernier piege : une serie parfaitement plate donnerait une
 * etendue nulle, donc une division par zero et une courbe qui saute d'un bord a l'autre au
 * moindre bit de bruit. Une ligne plate doit se tracer plate.
 *
 * Fonction pure, donc testee a part : c'est la seule logique delicate de ce fichier, le
 * reste n'est que du canvas.
 */
export function nextYRange(
  prev: readonly [number, number] | null,
  dataMin: number | null,
  dataMax: number | null,
): [number, number] {
  if (dataMin === null || dataMax === null || !Number.isFinite(dataMin) || !Number.isFinite(dataMax)) {
    return prev === null ? [0, 1] : [prev[0], prev[1]];
  }
  const span = Math.max(dataMax - dataMin, Math.abs(dataMax) * 1e-6, 1e-9);
  const pad = span * 0.1;
  const want: [number, number] = [dataMin - pad, dataMax + pad];

  if (prev === null) return want;

  const prevSpan = prev[1] - prev[0];
  const fits = dataMin >= prev[0] && dataMax <= prev[1];
  // En dessous du tiers, l'echelle precedente est devenue trop large et le trace s'aplatit.
  const fillsEnough = prevSpan > 0 && (dataMax - dataMin) / prevSpan > 0.34;
  return fits && fillsEnough ? [prev[0], prev[1]] : want;
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
  const yRange = useRef<[number, number] | null>(null);

  // Les libelles et les couleurs arrivent sous forme de tableaux construits a chaque rendu
  // par l'appelant (`indices.map(...)`). Les mettre dans les dependances de l'effet revient
  // a comparer des identites toujours neuves : uPlot etait detruit et reconstruit trente
  // fois par seconde, et c'est exactement ce que l'en-tete de ce fichier dit qu'il ne faut
  // pas faire. On compare donc leur contenu, et on lit les tableaux par reference.
  const cfg = useRef({ labels, colors });
  cfg.current = { labels, colors };
  const labelsKey = labels.join('|');
  const colorsKey = colors.join('|');
  // Le repère est lu à chaque tracé : il passe par une référence pour que le greffon n'ait
  // pas à être recréé — et donc le graphe non plus — quand il bouge.
  const marker = useRef<number | null>(markerX);
  marker.current = markerX;

  useLayoutEffect(() => {
    const el = host.current;
    if (el === null || cfg.current.labels.length === 0) return undefined;
    yRange.current = null;      /* nouvelles courbes, nouvelle echelle */

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
        scales: {
          x: { time: false },
          y: {
            range: (_self: uPlot, lo: number, hi: number) => {
              const r = nextYRange(yRange.current, lo, hi);
              yRange.current = r;
              return r;
            },
          },
        },
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
          ...cfg.current.labels.map((label, i) => ({
            label,
            stroke: cfg.current.colors[i] ?? ink2,
            width: 2,
            points: { show: false },
          })),
        ],
      },
      [[], ...cfg.current.labels.map(() => [])] as uPlot.AlignedData,
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
    // Volontairement sans `labels` ni `colors` : leurs **contenus** sont dans les
    // dependances via `labelsKey` et `colorsKey`, et leurs identites changent a chaque
    // rendu. Les y remettre reconstruirait le canvas en continu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelsKey, colorsKey, unit, height, showXLabel, xLabel]);

  useEffect(() => {
    const u = plot.current;
    if (u === null) return;
    u.setData([t as number[], ...(series as number[][])] as uPlot.AlignedData);
  }, [t, series, markerX]);

  return <div ref={host} className="a2n-chart w-full" />;
}
