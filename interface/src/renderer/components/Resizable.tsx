/**
 * Panneaux redimensionnables à la main.
 *
 * Les tailles choisies pour vous ne conviennent jamais à tout le monde : une colonne de
 * détail confortable sur un 27 pouces écrase le tracé sur un portable, et un panneau de
 * rails qui tient en six lignes n'a pas besoin de la même hauteur qu'une console. Plutôt
 * que d'affiner indéfiniment des constantes, on rend la main.
 *
 * ### Trois règles, et elles comptent toutes les trois
 *
 * **On ne peut pas se coincer.** Toute taille est bornée des deux côtés, et le plafond de
 * la colonne latérale se calcule sur la largeur réelle de la fenêtre : on ne doit jamais
 * pouvoir réduire l'instrument à rien en élargissant le détail.
 *
 * **Un réglage se retrouve.** Chaque taille est mémorisée sous sa propre clef. On ne règle
 * pas sa mise en page vingt fois par jour, et la reperdre à chaque lancement est ce qui
 * fait qu'on cesse d'y toucher.
 *
 * **Le défaut reste atteignable.** Un double-clic sur la poignée y revient. Sans ça, une
 * manipulation malheureuse laisse une fenêtre bancale que plus rien ne répare.
 *
 * L'accès clavier n'est pas une politesse : la poignée est focalisable, les flèches la
 * déplacent, `Shift` accélère. C'est aussi la seule façon d'ajuster finement sans souris
 * précise, sur un banc où l'on n'a pas toujours les deux mains libres.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** Borne une taille. Fonction pure, testée : c'est elle qui empêche de se coincer. */
export function clampSize(px: number, min: number, max: number): number {
  const hi = Math.max(min, max);
  return Math.round(Math.max(min, Math.min(hi, px)));
}

function load(key: string, fallback: number | null): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    if (raw === 'fill') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: number | null): void {
  try {
    localStorage.setItem(key, value === null ? 'fill' : String(value));
  } catch {
    /* stockage indisponible : le réglage vaut pour cette session, et c'est tout */
  }
}

/**
 * Poignée de redimensionnement.
 *
 * L'écoute du mouvement se fait sur la **fenêtre** et non sur la poignée : un geste rapide
 * sort d'une bande de six pixels avant que le navigateur ait émis l'événement suivant, et
 * la poignée lâcherait en plein glissement.
 */
function Handle({
  axis,
  onDrag,
  onReset,
  label,
}: {
  axis: 'y' | 'x';
  onDrag: (deltaPx: number) => void;
  onReset: () => void;
  label: string;
}): ReactNode {
  const start = useRef(0);

  const down = (e: React.MouseEvent): void => {
    e.preventDefault();
    start.current = axis === 'y' ? e.clientY : e.clientX;
    const move = (m: MouseEvent): void => {
      const now = axis === 'y' ? m.clientY : m.clientX;
      onDrag(now - start.current);
      start.current = now;
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
    };
    // Sans ça, le glissement sélectionne le texte de toute la fenêtre au passage.
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      role="separator"
      aria-orientation={axis === 'y' ? 'horizontal' : 'vertical'}
      aria-label={label}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onMouseDown={down}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const less = axis === 'y' ? 'ArrowUp' : 'ArrowLeft';
        const more = axis === 'y' ? 'ArrowDown' : 'ArrowRight';
        if (e.key === less) { e.preventDefault(); onDrag(-step); }
        if (e.key === more) { e.preventDefault(); onDrag(step); }
      }}
      className={`shrink-0 bg-transparent transition-colors hover:bg-accent focus:bg-accent focus:outline-none ${
        axis === 'y' ? 'h-1.5 cursor-row-resize' : 'w-1.5 cursor-col-resize'
      }`}
    />
  );
}

/**
 * Enveloppe un contenu d'une hauteur réglable.
 *
 * `null` veut dire « prends ce qui reste » : c'est le défaut, et il vaut mieux que n'importe
 * quel nombre tant que l'utilisateur n'a rien demandé. Dès qu'il tire la poignée, la hauteur
 * devient explicite et le reste.
 */
export function ResizableY({
  storageKey,
  defaultH = null,
  min = 96,
  max = 1200,
  className = '',
  label = 'Resize panel',
  children,
}: {
  storageKey: string;
  defaultH?: number | null;
  min?: number;
  max?: number;
  className?: string;
  label?: string;
  children: ReactNode;
}): ReactNode {
  const [h, setH] = useState<number | null>(() => load(storageKey, defaultH));
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => save(storageKey, h), [storageKey, h]);

  const drag = useCallback(
    (d: number) => {
      // Au premier glissement la hauteur est encore « ce qui reste » : on part de la
      // hauteur réellement occupée, pour que la poignée ne fasse pas sauter le panneau.
      setH((prev) => clampSize((prev ?? box.current?.clientHeight ?? min) + d, min, max));
    },
    [min, max],
  );

  return (
    <>
      <div
        ref={box}
        className={`min-h-0 ${h === null ? 'flex-1' : ''} ${className}`}
        style={h === null ? undefined : { height: h }}
      >
        {children}
      </div>
      <Handle axis="y" label={label} onDrag={drag} onReset={() => setH(defaultH)} />
    </>
  );
}

/**
 * Colonne latérale de largeur réglable.
 *
 * Le plafond se calcule sur la fenêtre plutôt que d'être écrit en dur : sur un écran
 * étroit, une colonne de 600 px ne laisserait plus rien au tracé, et c'est précisément la
 * situation qu'on cherche à rendre impossible.
 */
export function ResizableX({
  storageKey,
  defaultW,
  min = 240,
  className = '',
  label = 'Resize side column',
  children,
}: {
  storageKey: string;
  defaultW: number;
  min?: number;
  className?: string;
  label?: string;
  children: ReactNode;
}): ReactNode {
  const [w, setW] = useState<number>(() => load(storageKey, defaultW) ?? defaultW);

  useEffect(() => save(storageKey, w), [storageKey, w]);

  const drag = useCallback((d: number) => {
    // Tirer vers la gauche élargit la colonne : elle est à droite, donc le signe s'inverse.
    setW((prev) => clampSize(prev - d, min, Math.round(window.innerWidth * 0.5)));
  }, [min]);

  return (
    <>
      <Handle axis="x" label={label} onDrag={drag} onReset={() => setW(defaultW)} />
      <aside className={`shrink-0 ${className}`} style={{ width: w }}>
        {children}
      </aside>
    </>
  );
}
