/**
 * Aide repliée : une icône ⓘ qui montre son texte au survol, et le garde au clic.
 *
 * Les explications de l'interface sont utiles la première fois et encombrantes ensuite :
 * dépliées en paragraphes, elles mangeaient la surface des valeurs et des courbes. Elles
 * passent derrière une icône. Le réglage `ui.helpMode` (`inline`) les remet en clair pour
 * qui les préfère.
 *
 * Ne passent **jamais** ici : une erreur, un refus du firmware, un avertissement de
 * sécurité. Ce qu'il faut voir sans le chercher reste affiché.
 *
 * La bulle est rendue dans `document.body` et positionnée en `fixed` : un panneau qui défile
 * (`overflow: auto`) la couperait sinon. Elle se recale pour rester dans la fenêtre.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useConfig } from '../config.js';

const BUBBLE_W = 340;
const MARGIN = 8;

export function Hint({
  children,
  label = 'Help',
  className = '',
}: {
  children: ReactNode;
  /** Nom accessible de l'icône. */
  label?: string;
  className?: string;
}): ReactNode {
  const { config } = useConfig();
  const icon = useRef<HTMLButtonElement | null>(null);
  const bubble = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const open = hover || pinned;

  useLayoutEffect(() => {
    if (!open || icon.current === null) return;
    const r = icon.current.getBoundingClientRect();
    const h = bubble.current?.offsetHeight ?? 80;
    const left = Math.max(MARGIN, Math.min(window.innerWidth - BUBBLE_W - MARGIN, r.left - 12));
    // Sous l'icône si la place y est, au-dessus sinon.
    const below = r.bottom + 6;
    const top = below + h + MARGIN > window.innerHeight ? Math.max(MARGIN, r.top - h - 6) : below;
    setPos({ left, top });
  }, [open]);

  useEffect(() => {
    if (!pinned) return undefined;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (icon.current?.contains(t) || bubble.current?.contains(t)) return;
      setPinned(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPinned(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [pinned]);

  if (config.ui.helpMode === 'inline') {
    return <div className={`px-3 py-2 text-[12px] leading-relaxed text-fg-3 ${className}`}>{children}</div>;
  }

  return (
    <>
      <button
        ref={icon}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={(e) => {
          e.stopPropagation();
          setPinned((p) => !p);
        }}
        className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold leading-none normal-case tracking-normal transition-colors ${
          pinned ? 'border-accent text-accent' : 'border-fg-3 text-fg-3 hover:border-fg-2 hover:text-fg-2'
        } ${className}`}
      >
        i
      </button>
      {open &&
        createPortal(
          <div
            ref={bubble}
            role="tooltip"
            style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: BUBBLE_W }}
            className="selectable fixed z-[1000] rounded-[4px] border border-line bg-panel-2 px-3 py-2 text-[12px] font-normal normal-case leading-relaxed tracking-normal text-fg-2 shadow-lg shadow-black/40"
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
