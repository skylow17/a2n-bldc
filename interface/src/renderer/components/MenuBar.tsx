/**
 * Barre de menus intégrée — File, View, Device, Tools, Help.
 *
 * Dessinée dans l'interface plutôt que confiée au menu natif d'Electron : sous Windows, la
 * barre native reste blanche quel que soit le thème, et la fenêtre Control détachée doit
 * avoir la même. Le comportement suit celui d'une barre de logiciel classique :
 *
 * - un clic ouvre un menu ; tant qu'un menu est ouvert, survoler un autre titre l'ouvre ;
 * - `Alt` seul donne le focus à la barre, les flèches s'y déplacent, `Entrée` choisit,
 *   `Échap` referme ;
 * - les raccourcis affichés sont réellement actifs (`useShortcuts`), même menu fermé.
 *
 * STOP et AI CONTROL n'y sont **pas déplacés** : ils restent des boutons visibles en
 * permanence (`AGENTS.md` §4.6). Le menu Device propose STOP en plus, jamais à la place.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

export type MenuItem =
  | 'separator'
  | {
      label: string;
      shortcut?: string;
      onSelect?: () => void;
      disabled?: boolean;
      checked?: boolean;
      danger?: boolean;
      submenu?: MenuItem[];
    };

export interface Menu {
  label: string;
  items: MenuItem[];
}

type Entry = Exclude<MenuItem, 'separator'>;

const selectable = (it: MenuItem): it is Entry => it !== 'separator' && it.disabled !== true;

function MenuList({
  items,
  onClose,
  active,
  setActive,
}: {
  items: MenuItem[];
  onClose: () => void;
  active: number;
  setActive: (i: number) => void;
}): ReactNode {
  const [sub, setSub] = useState<number | null>(null);
  return (
    <div
      role="menu"
      className="min-w-56 rounded-[4px] border border-line bg-panel-2 py-1 shadow-lg shadow-black/40"
    >
      {items.map((it, i) => {
        if (it === 'separator') return <div key={`sep${i}`} className="my-1 border-t border-line-soft" />;
        const hasSub = it.submenu !== undefined;
        return (
          <div key={it.label} className="relative" onMouseEnter={() => { setActive(i); setSub(hasSub ? i : null); }}>
            <button
              type="button"
              role="menuitem"
              disabled={it.disabled === true}
              onClick={() => {
                if (hasSub) {
                  setSub(i);
                  return;
                }
                onClose();
                it.onSelect?.();
              }}
              className={`flex w-full items-center gap-3 px-3 py-1 text-left text-[12px] disabled:opacity-40 ${
                active === i && it.disabled !== true ? 'bg-accent/15 text-fg' : it.danger === true ? 'text-fault' : 'text-fg-2'
              }`}
            >
              <span className="w-3 text-[11px] text-accent">{it.checked === true ? '✓' : ''}</span>
              <span className="flex-1 whitespace-nowrap">{it.label}</span>
              {it.shortcut !== undefined && (
                <span className="font-mono text-[10px] text-fg-3">{it.shortcut}</span>
              )}
              {hasSub && <span className="text-[10px] text-fg-3">▸</span>}
            </button>
            {hasSub && sub === i && (
              <div className="absolute left-full top-[-5px] z-10">
                <MenuList items={it.submenu!} onClose={onClose} active={-1} setActive={() => undefined} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function MenuBar({ menus }: { menus: Menu[] }): ReactNode {
  const [open, setOpen] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [active, setActive] = useState(-1);
  const bar = useRef<HTMLDivElement | null>(null);

  const close = (): void => {
    setOpen(null);
    setFocus(null);
    setActive(-1);
  };

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!bar.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, []);

  // `Alt` seul, relâché sans autre touche : focus sur la barre, comme partout ailleurs.
  useEffect(() => {
    let altAlone = false;
    const down = (e: KeyboardEvent): void => {
      altAlone = e.key === 'Alt';
      const cur = open ?? focus;
      if (cur === null) return;
      const items = open !== null ? menus[open]!.items : [];
      const step = (from: number, dir: number): number => {
        for (let k = 1; k <= items.length; k++) {
          const j = (from + dir * k + items.length * 2) % items.length;
          if (selectable(items[j]!)) return j;
        }
        return from;
      };
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const n = (cur + (e.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length;
        if (open !== null) setOpen(n);
        setFocus(n);
        setActive(-1);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (open === null) {
          setOpen(cur);
          setActive(step(-1, 1));
        } else {
          setActive(step(active, e.key === 'ArrowDown' ? 1 : -1));
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (open === null) {
          setOpen(cur);
          return;
        }
        const it = items[active];
        if (it !== undefined && selectable(it) && it.submenu === undefined) {
          close();
          it.onSelect?.();
        }
      }
    };
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'Alt' && altAlone) {
        e.preventDefault();
        if (open !== null || focus !== null) close();
        else setFocus(0);
      }
      altAlone = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [menus, open, focus, active]);

  return (
    <div ref={bar} role="menubar" className="flex items-center gap-0.5">
      {menus.map((m, i) => (
        <div key={m.label} className="relative">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === i}
            onClick={() => {
              setOpen(open === i ? null : i);
              setFocus(i);
              setActive(-1);
            }}
            onMouseEnter={() => {
              if (open !== null) {
                setOpen(i);
                setActive(-1);
              }
            }}
            className={`rounded-[3px] px-2 py-0.5 text-[12px] transition-colors ${
              open === i || focus === i ? 'bg-raise text-fg' : 'text-fg-2 hover:bg-panel-2 hover:text-fg'
            }`}
          >
            {m.label}
          </button>
          {open === i && (
            <div className="absolute left-0 top-full z-[900] mt-1">
              <MenuList items={m.items} onClose={close} active={active} setActive={setActive} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ raccourcis */

/** `Ctrl+Shift+K` → forme normalisée comparable à un événement clavier. */
function matches(accel: string, e: KeyboardEvent): boolean {
  const parts = accel.split('+');
  const key = parts.pop()!.toLowerCase();
  const want = { ctrl: false, shift: false, alt: false };
  for (const p of parts) {
    const k = p.toLowerCase();
    if (k === 'ctrl') want.ctrl = true;
    if (k === 'shift') want.shift = true;
    if (k === 'alt') want.alt = true;
  }
  if ((e.ctrlKey || e.metaKey) !== want.ctrl || e.shiftKey !== want.shift || e.altKey !== want.alt) return false;
  const ek = e.key.toLowerCase();
  if (key === 'plus') return ek === '+' || ek === '=';
  if (key === 'minus') return ek === '-' || ek === '_';
  if (key === '`') return ek === '`' || e.code === 'Backquote';
  return ek === key || e.code.toLowerCase() === `digit${key}`;
}

/** Active les raccourcis de tous les menus, qu'ils soient ouverts ou non. */
export function useShortcuts(menus: Menu[]): void {
  const ref = useRef(menus);
  ref.current = menus;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Une touche nue dans un champ appartient au champ ; un raccourci porte Ctrl ou une
      // touche de fonction.
      if (!(e.ctrlKey || e.metaKey) && !/^F\d+$/.test(e.key)) return;
      const walk = (items: MenuItem[]): Entry | null => {
        for (const it of items) {
          if (it === 'separator') continue;
          if (it.submenu !== undefined) {
            const f = walk(it.submenu);
            if (f !== null) return f;
          }
          if (it.shortcut !== undefined && it.disabled !== true && matches(it.shortcut, e)) return it;
        }
        return null;
      };
      for (const m of ref.current) {
        const hit = walk(m.items);
        if (hit !== null) {
          e.preventDefault();
          hit.onSelect?.();
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Tous les raccourcis, pour la fenêtre d'aide. */
export function listShortcuts(menus: Menu[]): Array<{ menu: string; label: string; shortcut: string }> {
  const out: Array<{ menu: string; label: string; shortcut: string }> = [];
  const walk = (menu: string, items: MenuItem[]): void => {
    for (const it of items) {
      if (it === 'separator') continue;
      if (it.shortcut !== undefined) out.push({ menu, label: it.label, shortcut: it.shortcut });
      if (it.submenu !== undefined) walk(menu, it.submenu);
    }
  };
  for (const m of menus) walk(m.label, m.items);
  return out;
}
