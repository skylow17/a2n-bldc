/**
 * Pastille de couleur d'une courbe, et choix manuel de sa couleur.
 *
 * Un clic sur la pastille ouvre la palette : les douze créneaux du thème, une couleur libre,
 * et « Auto » pour revenir à l'attribution automatique (`traceColors.ts`). Le choix est
 * rangé par **nom de signal** dans `plots.traceColors` de la config : il vaut pour le Scope,
 * le Dashboard et les mesures enregistrées, et survit au redémarrage.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useConfig } from '../config.js';
import { SLOT_COUNT, assignTraceStyles, type TraceStyle } from '../traceColors.js';

/** Couleur utilisable en CSS : un créneau devient sa variable, qui suit le thème. */
export function cssColor(spec: string): string {
  const m = /^slot:(\d+)$/.exec(spec);
  return m === null ? spec : `var(--color-series-${m[1]})`;
}

/** Styles des courbes d'une sélection, avec les couleurs imposées de la config. */
export function useTraceStyles(names: readonly string[], units: readonly string[]): Map<string, TraceStyle> {
  const overrides = useConfig().config.plots.traceColors;
  const key = `${names.join('|')}/${units.join('|')}/${JSON.stringify(overrides)}`;
  return useMemo(() => {
    const styles = assignTraceStyles(names, units, overrides);
    return new Map(names.map((n, i) => [n, styles[i]!]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** Petit trait de légende : plein, ou pointillé pour une consigne. */
function Stroke({ style }: { style: TraceStyle | undefined }): ReactNode {
  if (style === undefined) return <span className="inline-block h-[3px] w-3" />;
  const c = cssColor(style.color);
  return (
    <span
      className="inline-block h-[3px] w-3 rounded-[2px]"
      style={
        style.dash
          ? { backgroundImage: `linear-gradient(90deg, ${c} 60%, transparent 60%)`, backgroundSize: '5px 3px' }
          : { background: c }
      }
      aria-hidden="true"
    />
  );
}

export function TraceSwatch({ name, style }: { name: string; style: TraceStyle | undefined }): ReactNode {
  const { config, update } = useConfig();
  const btn = useRef<HTMLButtonElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const forced = config.plots.traceColors[name];

  useEffect(() => {
    if (!open) return undefined;
    const r = btn.current?.getBoundingClientRect();
    if (r !== undefined) {
      setPos({ left: Math.min(window.innerWidth - 228, r.left), top: Math.min(window.innerHeight - 140, r.bottom + 4) });
    }
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const set = (spec: string | null): void => {
    const next = { ...config.plots.traceColors };
    if (spec === null) delete next[name];
    else next[name] = spec;
    update({ plots: { traceColors: next } });
  };

  // Une couleur libre arrive en `#rrggbb` ; celle d'un créneau se lit sur le thème courant.
  const pickerValue = (() => {
    if (forced?.startsWith('#') === true) return forced;
    const spec = style?.color ?? 'slot:1';
    if (spec.startsWith('#')) return spec;
    const v = getComputedStyle(document.documentElement).getPropertyValue(`--color-series-${spec.slice(5)}`).trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#3d8fec';
  })();

  return (
    <>
      <button
        ref={btn}
        type="button"
        title={`Colour of ${name}${forced !== undefined ? ' (set by hand)' : ''} — click to change`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={`flex h-4 items-center rounded-[2px] px-0.5 hover:bg-raise ${forced !== undefined ? 'ring-1 ring-fg-3' : ''}`}
      >
        <Stroke style={style} />
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            style={{ left: pos.left, top: pos.top }}
            className="fixed z-[1000] w-56 rounded-[4px] border border-line bg-panel-2 p-2 shadow-lg shadow-black/40"
          >
            <p className="mb-1.5 truncate font-mono text-[11px] text-fg-2">{name}</p>
            <div className="grid grid-cols-6 gap-1">
              {Array.from({ length: SLOT_COUNT }, (_, i) => {
                const spec = `slot:${i + 1}`;
                const active = (forced ?? style?.color) === spec;
                return (
                  <button
                    key={spec}
                    type="button"
                    title={`Palette colour ${i + 1}`}
                    onClick={() => {
                      set(spec);
                      setOpen(false);
                    }}
                    className={`h-6 rounded-[3px] border ${active ? 'border-fg' : 'border-transparent'}`}
                    style={{ background: cssColor(spec) }}
                  />
                );
              })}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[11px] text-fg-2">
                Custom
                <input
                  type="color"
                  value={pickerValue}
                  onChange={(e) => set(e.target.value)}
                  className="h-6 w-8 cursor-pointer rounded-[3px] border border-line bg-raise"
                />
              </label>
              <div className="flex-1" />
              <button
                type="button"
                disabled={forced === undefined}
                onClick={() => {
                  set(null);
                  setOpen(false);
                }}
                className="rounded-[3px] border border-line px-2 py-0.5 text-[11px] text-fg-2 hover:border-fg-3 disabled:opacity-40"
              >
                Auto
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
