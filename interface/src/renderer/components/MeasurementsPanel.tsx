/**
 * Tile « Measurements » : l'arborescence des dossiers à gauche, la liste des mesures à
 * droite.
 *
 * - Un clic sur une ligne ouvre la mesure dans la zone de résultat ; `Ctrl` et `Maj`
 *   étendent la sélection, comme dans un explorateur de fichiers.
 * - On glisse des mesures (ou un dossier) sur un dossier pour les y ranger, sur « All
 *   measurements » pour les remettre à la racine.
 * - Clic droit sur un dossier ou une mesure : les actions de l'élément.
 * - Les colonnes trient ; le champ de recherche filtre sur le titre, le commentaire, les
 *   étiquettes et les signaux.
 *
 * Supprimer un dossier ne supprime aucune mesure : elles remontent d'un cran. Supprimer des
 * mesures demande une confirmation qui dit combien.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import {
  createFolder,
  deleteFolder,
  filterMeta,
  measurementsIn,
  moveFolder,
  moveMeasurements,
  renameFolder,
  sortMeta,
  type Folder,
  type MeasTree,
  type MeasurementMeta,
  type SortKey,
} from '../../shared/measurement.js';
import { useCommand } from '../commands.js';
import { api, useAction } from '../useDevice.js';
import { Button } from './ui.js';

const DRAG_MEAS = 'application/x-a2n-measurements';
const DRAG_FOLDER = 'application/x-a2n-folder';

type CtxItem = { label: string; onSelect: () => void; danger?: boolean } | 'separator';

function ContextMenu({
  at,
  items,
  onClose,
}: {
  at: { x: number; y: number };
  items: CtxItem[];
  onClose: () => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ left: Math.min(at.x, window.innerWidth - 220), top: Math.min(at.y, window.innerHeight - 24 * items.length - 16) }}
      className="fixed z-[1000] min-w-48 rounded-[4px] border border-line bg-panel-2 py-1 shadow-lg shadow-black/40"
    >
      {items.map((it, i) =>
        it === 'separator' ? (
          <div key={`s${i}`} className="my-1 border-t border-line-soft" />
        ) : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              it.onSelect();
            }}
            className={`block w-full px-3 py-1 text-left text-[12px] hover:bg-accent/15 ${it.danger === true ? 'text-fault' : 'text-fg-2 hover:text-fg'}`}
          >
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
  if (ms < 120_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}

/* ------------------------------------------------------------------ arbre */

function FolderNode({
  folder,
  tree,
  depth,
  selected,
  counts,
  onSelect,
  onDrop,
  onContext,
  renaming,
  onRenamed,
}: {
  folder: Folder;
  tree: MeasTree;
  depth: number;
  selected: string | null;
  counts: Map<string, number>;
  onSelect: (id: string) => void;
  onDrop: (e: React.DragEvent, folder: string | null) => void;
  onContext: (e: React.MouseEvent, f: Folder) => void;
  renaming: string | null;
  onRenamed: (id: string, name: string | null) => void;
}): ReactNode {
  const [open, setOpen] = useState(true);
  const [over, setOver] = useState(false);
  const children = tree.folders.filter((f) => f.parent === folder.id).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div>
      <div
        draggable={renaming !== folder.id}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_FOLDER, folder.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          onDrop(e, folder.id);
        }}
        onClick={() => onSelect(folder.id)}
        onContextMenu={(e) => onContext(e, folder)}
        className={`flex cursor-pointer items-center gap-1 rounded-[3px] py-0.5 pr-1 text-[12px] ${
          over ? 'bg-accent/25 text-fg' : selected === folder.id ? 'bg-accent/15 text-accent' : 'text-fg-2 hover:bg-panel-2'
        }`}
        style={{ paddingLeft: 4 + depth * 12 }}
      >
        <button
          type="button"
          aria-label={open ? 'Collapse' : 'Expand'}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          className={`w-3 text-[10px] text-fg-3 ${children.length === 0 ? 'invisible' : ''}`}
        >
          {open ? '▾' : '▸'}
        </button>
        <span className="text-[11px] text-fg-3">▣</span>
        {renaming === folder.id ? (
          <input
            autoFocus
            defaultValue={folder.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => onRenamed(folder.id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenamed(folder.id, e.currentTarget.value);
              if (e.key === 'Escape') onRenamed(folder.id, null);
            }}
            className="min-w-0 flex-1 rounded-[2px] border border-line bg-raise px-1 text-[12px] text-fg outline-none"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
        )}
        <span className="font-mono text-[10px] text-fg-3">{counts.get(folder.id) ?? 0}</span>
      </div>
      {open &&
        children.map((c) => (
          <FolderNode
            key={c.id}
            folder={c}
            tree={tree}
            depth={depth + 1}
            selected={selected}
            counts={counts}
            onSelect={onSelect}
            onDrop={onDrop}
            onContext={onContext}
            renaming={renaming}
            onRenamed={onRenamed}
          />
        ))}
    </div>
  );
}

/* ------------------------------------------------------------------ tile */

export function MeasurementsPanel({
  metas,
  tree,
  openId,
  onOpen,
  folder,
  onFolder,
}: {
  metas: MeasurementMeta[];
  tree: MeasTree;
  /** Mesure affichée dans la zone de résultat. */
  openId: string | null;
  onOpen: (id: string) => void;
  /** Dossier sélectionné : les nouvelles mesures y sont rangées. */
  folder: string | null;
  onFolder: (id: string | null) => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'createdAt', desc: true });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ at: { x: number; y: number }; items: CtxItem[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [rootOver, setRootOver] = useState(false);
  const act = useAction();

  // Le dossier sélectionné a pu disparaître (supprimé, import d'un autre arbre).
  useEffect(() => {
    if (folder !== null && !tree.folders.some((f) => f.id === folder)) onFolder(null);
  }, [tree, folder, onFolder]);

  const setTree = (t: MeasTree): void => void act.run(() => api().measSetTree(t));

  const counts = useMemo(() => {
    const ids = metas.map((m) => m.id);
    return new Map(tree.folders.map((f) => [f.id, measurementsIn(tree, f.id, ids).length]));
  }, [metas, tree]);

  const shown = useMemo(() => {
    const inFolder = new Set(measurementsIn(tree, folder, metas.map((m) => m.id)));
    return sortMeta(filterMeta(metas.filter((m) => inFolder.has(m.id)), query), sort.key, sort.desc);
  }, [metas, tree, folder, query, sort]);

  // La sélection ne garde que ce qui existe encore.
  useEffect(() => {
    setSel((s) => {
      const ids = new Set(metas.map((m) => m.id));
      const next = new Set([...s].filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [metas]);

  const selectedIds = (): string[] => (sel.size > 0 ? [...sel] : openId !== null ? [openId] : []);

  const newFolder = (parent: string | null): void => {
    const id = crypto.randomUUID();
    setTree(createFolder(tree, 'New folder', parent, id));
    onFolder(id);
    setRenaming(id);
  };

  const exportIds = (ids: string[], format: 'csv' | 'json'): void => {
    if (ids.length > 0) void act.run(() => api().measExport(ids, format));
  };

  const importInto = (f: string | null): void => void act.run(() => api().measImport(f));

  useCommand('measurement:import', () => importInto(folder));

  const onDrop = (e: React.DragEvent, target: string | null): void => {
    e.preventDefault();
    const meas = e.dataTransfer.getData(DRAG_MEAS);
    const fold = e.dataTransfer.getData(DRAG_FOLDER);
    if (meas !== '') setTree(moveMeasurements(tree, JSON.parse(meas) as string[], target));
    else if (fold !== '' && fold !== target) setTree(moveFolder(tree, fold, target));
  };

  const folderMenu = (e: React.MouseEvent, f: Folder): void => {
    e.preventDefault();
    const inside = measurementsIn(tree, f.id, metas.map((m) => m.id));
    setCtx({
      at: { x: e.clientX, y: e.clientY },
      items: [
        { label: 'New subfolder', onSelect: () => newFolder(f.id) },
        { label: 'Rename', onSelect: () => setRenaming(f.id) },
        { label: 'Import measurements here…', onSelect: () => importInto(f.id) },
        'separator',
        { label: `Export ${inside.length} as CSV…`, onSelect: () => exportIds(inside, 'csv') },
        { label: `Export ${inside.length} as JSON…`, onSelect: () => exportIds(inside, 'json') },
        'separator',
        { label: 'Delete folder (keeps measurements)', danger: true, onSelect: () => setTree(deleteFolder(tree, f.id)) },
      ],
    });
  };

  const rowMenu = (e: React.MouseEvent, m: MeasurementMeta): void => {
    e.preventDefault();
    const ids = sel.has(m.id) ? [...sel] : [m.id];
    if (!sel.has(m.id)) setSel(new Set([m.id]));
    const n = ids.length;
    setCtx({
      at: { x: e.clientX, y: e.clientY },
      items: [
        ...(n === 1 ? [{ label: 'Open', onSelect: () => onOpen(m.id) }] : []),
        { label: `Export ${n > 1 ? `${n} ` : ''}as CSV…`, onSelect: () => exportIds(ids, 'csv') },
        { label: `Export ${n > 1 ? `${n} ` : ''}as JSON…`, onSelect: () => exportIds(ids, 'json') },
        { label: 'Move to root', onSelect: () => setTree(moveMeasurements(tree, ids, null)) },
        'separator',
        { label: `Delete ${n > 1 ? `${n} measurements` : 'measurement'}…`, danger: true, onSelect: () => setConfirmDelete(ids) },
      ],
    });
  };

  const clickRow = (e: React.MouseEvent, m: MeasurementMeta): void => {
    if (e.ctrlKey || e.metaKey) {
      setSel((s) => {
        const n = new Set(s);
        if (n.has(m.id)) n.delete(m.id);
        else n.add(m.id);
        return n;
      });
      setAnchor(m.id);
      return;
    }
    if (e.shiftKey && anchor !== null) {
      const a = shown.findIndex((x) => x.id === anchor);
      const b = shown.findIndex((x) => x.id === m.id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSel(new Set(shown.slice(lo, hi + 1).map((x) => x.id)));
        return;
      }
    }
    setSel(new Set());
    setAnchor(m.id);
    onOpen(m.id);
  };

  const header = (key: SortKey, label: string, className = ''): ReactNode => (
    <th
      className={`cursor-pointer select-none px-2 py-1 font-semibold hover:text-fg ${className}`}
      onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key === 'createdAt' }))}
    >
      {label}
      {sort.key === key ? (sort.desc ? ' ▾' : ' ▴') : ''}
    </th>
  );

  const roots = tree.folders.filter((f) => f.parent === null).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[4px] border border-line-soft bg-panel">
      <header className="flex shrink-0 items-center gap-2 border-b border-line-soft px-3 py-1.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-2">Measurements</h2>
        <span className="font-mono text-[11px] text-fg-3">
          {shown.length}/{metas.length}
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter: title, comment, signal…"
          className="ml-2 w-56 rounded-[3px] border border-line bg-raise px-2 py-0.5 text-[12px] text-fg outline-none focus:border-fg-3"
        />
        <div className="flex-1" />
        {act.error !== null && (
          <span className="max-w-xs truncate text-[11px] text-fault" title={act.error}>
            {act.error}
          </span>
        )}
        {sel.size > 0 && <span className="text-[11px] text-fg-3">{sel.size} selected</span>}
        <Button onClick={() => newFolder(folder)} title="New folder inside the selected one">
          New folder
        </Button>
        <Button onClick={() => importInto(folder)} title="Import measurement files (JSON) into the selected folder">
          Import…
        </Button>
        <Button disabled={selectedIds().length === 0} onClick={() => exportIds(selectedIds(), 'csv')}>
          CSV…
        </Button>
        <Button disabled={selectedIds().length === 0} onClick={() => exportIds(selectedIds(), 'json')}>
          JSON…
        </Button>
        <Button tone="danger" disabled={selectedIds().length === 0} onClick={() => setConfirmDelete(selectedIds())}>
          Delete…
        </Button>
      </header>

      {confirmDelete !== null && (
        <div className="flex shrink-0 items-center gap-2 border-b border-fault/40 bg-raise px-3 py-1.5">
          <span className="text-[12px] text-fg">
            Delete {confirmDelete.length} measurement{confirmDelete.length > 1 ? 's' : ''} from disk? This cannot be undone.
          </span>
          <Button
            tone="danger"
            onClick={() => {
              const ids = confirmDelete;
              setConfirmDelete(null);
              setSel(new Set());
              void act.run(() => api().measDelete(ids));
            }}
          >
            Delete
          </Button>
          <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Arborescence */}
        <div className="w-56 shrink-0 overflow-auto border-r border-line-soft p-1">
          <div
            onClick={() => onFolder(null)}
            onDragOver={(e) => {
              e.preventDefault();
              setRootOver(true);
            }}
            onDragLeave={() => setRootOver(false)}
            onDrop={(e) => {
              setRootOver(false);
              onDrop(e, null);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtx({
                at: { x: e.clientX, y: e.clientY },
                items: [
                  { label: 'New folder', onSelect: () => newFolder(null) },
                  { label: 'Import measurements…', onSelect: () => importInto(null) },
                ],
              });
            }}
            className={`flex cursor-pointer items-center gap-1 rounded-[3px] px-1 py-0.5 text-[12px] ${
              rootOver ? 'bg-accent/25 text-fg' : folder === null ? 'bg-accent/15 text-accent' : 'text-fg-2 hover:bg-panel-2'
            }`}
          >
            <span className="w-3" />
            <span className="flex-1">All measurements</span>
            <span className="font-mono text-[10px] text-fg-3">{metas.length}</span>
          </div>
          {roots.map((f) => (
            <FolderNode
              key={f.id}
              folder={f}
              tree={tree}
              depth={0}
              selected={folder}
              counts={counts}
              onSelect={onFolder}
              onDrop={onDrop}
              onContext={folderMenu}
              renaming={renaming}
              onRenamed={(id, name) => {
                setRenaming(null);
                if (name !== null) setTree(renameFolder(tree, id, name));
              }}
            />
          ))}
          {tree.folders.length === 0 && (
            <p className="px-2 py-2 text-[11px] text-fg-3">Drag measurements onto a folder to file them.</p>
          )}
        </div>

        {/* Liste */}
        <div className="min-w-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 bg-panel">
              <tr className="border-b border-line-soft text-left text-[11px] text-fg-3">
                {header('createdAt', 'Time', 'w-40')}
                {header('title', 'Title')}
                {header('kind', 'Type', 'w-20')}
                <th className="px-2 py-1 font-semibold">Signals</th>
                {header('points', 'Points', 'w-36 text-right')}
                <th className="w-6 px-1 py-1" title="Has a comment" />
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => {
                const active = m.id === openId;
                const picked = sel.has(m.id);
                return (
                  <tr
                    key={m.id}
                    draggable
                    onDragStart={(e) => {
                      const ids = sel.has(m.id) ? [...sel] : [m.id];
                      e.dataTransfer.setData(DRAG_MEAS, JSON.stringify(ids));
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onClick={(e) => clickRow(e, m)}
                    onContextMenu={(e) => rowMenu(e, m)}
                    className={`cursor-pointer border-b border-line-soft/50 ${
                      picked ? 'bg-accent/20' : active ? 'bg-accent/10' : 'hover:bg-panel-2'
                    }`}
                  >
                    <td className={`px-2 py-0.5 font-mono text-[11px] ${active ? 'text-accent' : 'text-fg-2'}`}>
                      {fmtDate(m.createdAt)}
                    </td>
                    <td className="max-w-0 truncate px-2 py-0.5 text-fg" title={m.title}>
                      {m.title}
                    </td>
                    <td className="px-2 py-0.5 text-[11px] text-fg-3">{m.kind}</td>
                    <td className="max-w-0 truncate px-2 py-0.5 font-mono text-[11px] text-fg-3" title={m.signals.join(', ')}>
                      {m.signals.join(', ')}
                    </td>
                    <td className="whitespace-nowrap px-2 py-0.5 text-right font-mono text-[11px] text-fg-3">
                      {m.points} · {fmtDuration(m.durationMs)}
                    </td>
                    <td className="px-1 py-0.5 text-center text-[11px] text-fg-3" title={m.comment}>
                      {m.comment !== '' ? '✎' : ''}
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-[12px] text-fg-3">
                    {metas.length === 0
                      ? 'No measurement yet. Each capture is kept here, timestamped.'
                      : query !== ''
                        ? `Nothing matches “${query}”.`
                        : 'This folder is empty.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {ctx !== null && <ContextMenu at={ctx.at} items={ctx.items} onClose={() => setCtx(null)} />}
    </section>
  );
}
