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
export type YMode = 'auto' | 'zero' | 'locked';

export function nextYRange(
  prev: readonly [number, number] | null,
  dataMin: number | null,
  dataMax: number | null,
  mode: YMode = 'auto',
): [number, number] {
  if (prev !== null && mode === 'locked') {
    return [prev[0], prev[1]];   /* l'utilisateur a fige l'echelle : on n'y touche plus */
  }
  if (dataMin === null || dataMax === null || !Number.isFinite(dataMin) || !Number.isFinite(dataMax)) {
    return prev === null ? [0, 1] : [prev[0], prev[1]];
  }

  // Centre sur zero : un courant signe se lit a sa position par rapport a l'axe, et une
  // echelle qui ne contient pas zero ment sur le signe autant que sur l'amplitude.
  const lo = mode === 'zero' ? -Math.max(Math.abs(dataMin), Math.abs(dataMax)) : dataMin;
  const hi = mode === 'zero' ? Math.max(Math.abs(dataMin), Math.abs(dataMax)) : dataMax;

  const span = Math.max(hi - lo, Math.abs(hi) * 1e-6, 1e-9);
  const pad = span * 0.1;
  const want: [number, number] = [lo - pad, hi + pad];

  if (prev === null) return want;

  const prevSpan = prev[1] - prev[0];
  const fits = lo >= prev[0] && hi <= prev[1];
  // En dessous du tiers, l'echelle precedente est devenue trop large et le trace s'aplatit.
  const fillsEnough = prevSpan > 0 && (hi - lo) / prevSpan > 0.34;
  return fits && fillsEnough ? [prev[0], prev[1]] : want;
}

/**
 * Greffon de navigation : molette pour zoomer, glissement pour deplacer, double-clic pour
 * tout remontrer.
 *
 * Reserve aux captures. Sur un flux qui defile, uPlot propose de base un glissement qui
 * zoome, et c'est un piege : la courbe continue d'avancer sous la selection, on se retrouve
 * sur une fenetre fixe pendant que les donnees filent ailleurs, sans rien qui dise comment
 * revenir. Une capture, elle, ne bouge plus — la navigation y a tout son sens, et c'est
 * meme la seule facon de regarder deux mille points sur huit cents pixels.
 *
 * Le zoom est **centre sur le pointeur** et non sur le milieu du graphe : on zoome sur ce
 * qu'on regarde, ce qui evite de devoir recadrer apres chaque cran de molette.
 */
/** Remontre toute la capture. Un seul endroit, appele par le double-clic et par le bouton. */
function fitX(u: uPlot): void {
  const xs = u.data[0];
  if (xs === undefined || xs.length === 0) return;
  u.setScale('x', { min: xs[0] as number, max: xs[xs.length - 1] as number });
}

function navPlugin(): uPlot.Plugin {
  return {
    hooks: {
      ready: (u: uPlot) => {
        const over = u.over;

        over.addEventListener(
          'wheel',
          (e: WheelEvent) => {
            e.preventDefault();
            const sx = u.scales['x'];
            if (sx?.min === undefined || sx.max === undefined) return;
            const rect = over.getBoundingClientRect();
            const anchor = u.posToVal(e.clientX - rect.left, 'x');
            const factor = e.deltaY < 0 ? 0.82 : 1 / 0.82;
            u.setScale('x', {
              min: anchor - (anchor - sx.min) * factor,
              max: anchor + (sx.max - anchor) * factor,
            });
          },
          { passive: false },
        );

        over.addEventListener('mousedown', (e: MouseEvent) => {
          // Le glissement simple appartient a uPlot : c'est le **zoom par selection**, et
          // c'est le geste qu'on attend d'un oscilloscope. Le deplacement se fait donc a la
          // molette enfoncee ou avec `Shift`, comme dans tous les outils de trace.
          if (e.button !== 1 && !(e.button === 0 && e.shiftKey)) return;
          const sx = u.scales['x'];
          if (sx?.min === undefined || sx.max === undefined) return;
          const x0 = e.clientX;
          const min0 = sx.min;
          const max0 = sx.max;
          const perPx = (max0 - min0) / u.bbox.width * devicePixelRatio;
          let moved = false;

          const move = (m: MouseEvent): void => {
            const d = (m.clientX - x0) * perPx;
            if (Math.abs(m.clientX - x0) > 2) { moved = true; }
            u.setScale('x', { min: min0 - d, max: max0 - d });
          };
          const up = (): void => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            // Un clic sans deplacement reste un clic : on ne l'avale pas.
            if (moved) { over.style.cursor = ''; }
          };
          over.style.cursor = 'grabbing';
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        });

        over.addEventListener('dblclick', () => fitX(u));
      },
    },
  };
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
  /**
   * Source vivante, interrogee a chaque trame d'affichage.
   *
   * C'est la regle de `AGENTS.md` §3 : « uPlot est mis a jour par `requestAnimationFrame`,
   * pas par echantillon recu. Aucun re-render React declenche par une trame de telemetrie. »
   * Quand `feed` est fourni, `t` et `series` ne servent plus : le graphe lit lui-meme, au
   * rythme de l'ecran, un tampon que personne ne recopie. Le flux arrive par lots de 33 ms,
   * l'ecran affiche a 60 Hz ; lier les deux faisait avancer la courbe par a-coups.
   */
  feed?: (() => { t: readonly number[]; series: ReadonlyArray<readonly number[]> } | null) | null;
  /**
   * Largeur de la fenetre temporelle, dans l'unite de l'axe X. `null` = toute la memoire.
   *
   * Sur un flux, une fenetre fixe est ce qui rend le defilement previsible : sans elle
   * l'axe s'etire pendant que le tampon se remplit, puis glisse quand il deborde, et la
   * vitesse apparente de la courbe change en cours de route sans que rien l'explique.
   */
  xWindow?: number | null;
  /** Comportement de l'echelle verticale — voir `nextYRange`. */
  yMode?: YMode;
  /** Molette, glissement et double-clic. Reserve aux captures : voir `navPlugin`. */
  interactive?: boolean;
  /**
   * Clef de synchronisation. Les graphes qui la partagent alignent leur curseur et leur axe
   * des temps : zoomer sur l'un zoome les autres. Des graphes empiles qui montrent le meme
   * instant doivent le montrer au meme endroit, sinon on compare des abscisses differentes
   * sans s'en apercevoir.
   */
  syncKey?: string | null;
  /**
   * Compteur de remise a la vue complete. Chaque increment refait tenir toute la capture
   * dans le cadre. Un compteur plutot qu'un `ref` imperatif : l'appelant n'a rien a tenir.
   */
  resetZoom?: number;
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
  feed = null,
  xWindow = null,
  yMode = 'auto',
  interactive = false,
  syncKey = null,
  resetZoom = 0,
}: TimeSeriesChartProps): ReactNode {
  const host = useRef<HTMLDivElement | null>(null);
  const plot = useRef<uPlot | null>(null);
  const yRange = useRef<[number, number] | null>(null);

  // Les libelles et les couleurs arrivent sous forme de tableaux construits a chaque rendu
  // par l'appelant (`indices.map(...)`). Les mettre dans les dependances de l'effet revient
  // a comparer des identites toujours neuves : uPlot etait detruit et reconstruit trente
  // fois par seconde, et c'est exactement ce que l'en-tete de ce fichier dit qu'il ne faut
  // pas faire. On compare donc leur contenu, et on lit les tableaux par reference.
  const cfg = useRef({ labels, colors, series });
  cfg.current = { labels, colors, series };
  const labelsKey = labels.join('|');
  const colorsKey = colors.join('|');
  // Le repère est lu à chaque tracé : il passe par une référence pour que le greffon n'ait
  // pas à être recréé — et donc le graphe non plus — quand il bouge.
  const marker = useRef<number | null>(markerX);
  marker.current = markerX;
  // Lus a chaque trace, donc par reference : les changer ne doit pas reconstruire le canvas.
  const live = useRef({ feed, xWindow, yMode });
  live.current = { feed, xWindow, yMode };

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
              const r = nextYRange(yRange.current, lo, hi, live.current.yMode);
              yRange.current = r;
              return r;
            },
          },
        },
        legend: { live: true },
        cursor: {
          // Sur un flux, le survol lit une valeur et rien d'autre : un glissement qui zoome
          // ferait decrocher une courbe qui defile, sans moyen evident de revenir. Sur une
          // capture, qui ne bouge plus, la navigation est au contraire indispensable.
          // Selection rectangle sur l'axe des temps quand la navigation est permise. Pas sur
          // l'axe vertical : sur une capture on zoome sur un intervalle de temps, et laisser
          // l'ordonnee se figer sur une selection cacherait ce qui sort du cadre juste apres.
          drag: interactive ? { x: true, y: false } : { x: false, y: false },
          points: { size: 6 },
          ...(syncKey === null
            ? {}
            : { sync: { key: syncKey, scales: ['x', null] as [string, null] } }),
        },
        plugins: interactive ? [navPlugin()] : [],
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
  }, [labelsKey, colorsKey, unit, height, showXLabel, xLabel, interactive, syncKey]);

  // `feed` est une fonction que l'appelant recree a chaque rendu : la mettre dans les
  // dependances relancerait la boucle d'affichage pour rien. Seule compte sa presence, et
  // la fonction elle-meme est lue par reference a chaque trame.
  const hasFeed = feed !== null && feed !== undefined;

  /* Source statique — une capture.
   *
   * **Uniquement quand les donnees changent vraiment.** `series` est reconstruit par
   * l'appelant a chaque rendu (`indices.map(...)`), et `setData` remet les echelles a zero :
   * le zoom et le deplacement se perdaient donc au moindre rendu du parent, sans qu'aucun
   * geste de l'utilisateur ne l'explique. On compare l'identite du tableau de temps, qui est
   * stable tant que la capture ne change pas, et on lit les series par reference. */
  const lastT = useRef<readonly number[] | null>(null);
  useEffect(() => {
    const u = plot.current;
    if (u === null || hasFeed) return;
    if (lastT.current === t) return;
    lastT.current = t;
    u.setData([t as number[], ...(cfg.current.series as number[][])] as uPlot.AlignedData);
  }, [t, hasFeed]);

  /* Retour a la vue complete, demande de l'exterieur. Un compteur plutot qu'une fonction
   * imperative : le parent n'a rien a tenir, il incremente. */
  useEffect(() => {
    const u = plot.current;
    if (u !== null && resetZoom > 0) fitX(u);
  }, [resetZoom]);

  /* Source vivante — le flux. Une seule boucle d'affichage, aucun rendu React impliqué. */
  useEffect(() => {
    if (!hasFeed) return undefined;
    let raf = 0;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const u = plot.current;
      const d = live.current.feed?.();
      if (u === null || d === undefined || d === null || d.t.length === 0) return;

      u.setData([d.t as number[], ...(d.series as number[][])] as uPlot.AlignedData, false);

      // Fenetre glissante : on impose l'etendue plutot que de laisser uPlot prendre celle
      // des donnees, pour que la vitesse de defilement ne depende pas du remplissage.
      const w = live.current.xWindow;
      const last = d.t[d.t.length - 1] ?? 0;
      if (w !== null && w !== undefined && w > 0) {
        u.setScale('x', { min: last - w, max: last });
      } else {
        u.setScale('x', { min: d.t[0] ?? 0, max: last });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hasFeed]);

  return <div ref={host} className="a2n-chart w-full" />;
}
