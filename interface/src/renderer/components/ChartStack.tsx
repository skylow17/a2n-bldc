/**
 * Pile de graphes qui se partagent la hauteur disponible.
 *
 * Les hauteurs étaient jusqu'ici des constantes en pixels — 120 px par graphe au-delà de
 * deux courbes, quelle que soit la taille de la fenêtre. Sur un écran de portable ça
 * débordait, en plein écran ça laissait la moitié de la surface vide, et dans les deux cas
 * le panneau se mettait à défiler : c'est ce qu'on voit comme des données tronquées.
 *
 * ### La règle, et pourquoi elle a deux bornes
 *
 * La hauteur se partage entre les graphes, puis se **borne des deux côtés** :
 *
 *  - un **plancher**, parce qu'un graphe de trente pixels ne se lit pas. Passé ce seuil on
 *    préfère assumer le débordement et laisser défiler : une bande illisible qui tient dans
 *    le cadre est pire qu'une courbe lisible qu'il faut faire défiler ;
 *  - un **plafond**, parce qu'une seule courbe étirée sur un écran entier n'apprend rien de
 *    plus. Au-delà, la hauteur supplémentaire n'ajoute que du blanc.
 *
 * Entre les deux, la surface suit la fenêtre — ce qui est exactement ce qu'on attend en
 * passant en plein écran.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

/** En dessous, les graduations se chevauchent et la courbe n'est plus lisible. */
export const CHART_MIN_H = 96;
/** Au-delà, la hauteur n'ajoute plus d'information. */
export const CHART_MAX_H = 420;

/**
 * Hauteur d'un graphe, la pile en comptant `count`. Fonction pure : c'est la seule logique
 * de ce fichier, et un arrondi de travers y passerait inaperçu à la relecture.
 *
 * @param available hauteur utile du conteneur, en pixels.
 * @param count     nombre de graphes empilés.
 * @param gap       espace pris entre deux graphes.
 */
export function chartHeight(
  available: number,
  count: number,
  gap = 0,
  min = CHART_MIN_H,
  max = CHART_MAX_H,
): number {
  if (count <= 0) return min;
  // Tant que le conteneur n'a pas été mesuré, on rend le plancher plutôt qu'un zéro : un
  // graphe de hauteur nulle ne se remet pas à jour tout seul quand la mesure arrive.
  if (!Number.isFinite(available) || available <= 0) return min;
  const usable = available - gap * Math.max(0, count - 1);
  return Math.max(min, Math.min(max, Math.floor(usable / count)));
}

/**
 * Mesure la hauteur utile d'un conteneur et la tient à jour.
 *
 * `ResizeObserver` et non un écouteur sur la fenêtre : un panneau change aussi de taille
 * quand la console se replie ou qu'une barre apparaît, sans que la fenêtre bouge.
 */
export function useAvailableHeight(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [h, setH] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    setH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  return [ref, h];
}

/**
 * Enveloppe une pile de graphes. L'enfant est une fonction qui reçoit la hauteur à donner
 * à chacun — c'est la mesure du conteneur qui la décide, et elle n'est connue qu'ici.
 *
 * Le conteneur défile quand le plancher est atteint : c'est le cas assumé, pas un oubli.
 */
export function ChartStack({
  count,
  gap = 0,
  min = CHART_MIN_H,
  max = CHART_MAX_H,
  className = '',
  children,
}: {
  count: number;
  gap?: number;
  min?: number;
  max?: number;
  className?: string;
  children: (height: number) => ReactNode;
}): ReactNode {
  const [ref, available] = useAvailableHeight();
  return (
    <div ref={ref} className={`min-h-0 flex-1 overflow-auto ${className}`}>
      {children(chartHeight(available, count, gap, min, max))}
    </div>
  );
}
