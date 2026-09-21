/**
 * Console — le canal ASCII, tel qu'on le verrait depuis un terminal série.
 *
 * Elle est conservée parce que c'est le seul moyen de diagnostiquer la carte sans aucun
 * outil, et parce qu'elle a été ce qui fonctionnait le mieux dans le firmware v1. Elle
 * partage le lien avec le canal binaire : les deux cohabitent sans se gêner.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { DeviceSnapshot, LogEntry } from '../../main/device/DeviceCore.js';
import { Button, Empty } from '../components/ui.js';
import { QUICK_COMMANDS, searchCommands } from '../consoleCommands.js';
import { api, useAction } from '../useDevice.js';
import {
  DEFAULT_FILTER,
  LEVELS,
  SOURCES,
  applyFilter,
  load,
  save,
  showsEverything,
  toggle,
  type ConsoleFilter,
} from '../consoleFilter.js';



/**
 * Rappel des commandes, replie par defaut.
 *
 * Le jeu de commandes de diagnostic a plus que triple pendant M2, et la syntaxe vivait
 * uniquement dans `docs/protocol.md`. Au banc, aller la chercher veut dire lacher une sonde.
 * Un clic recopie la commande dans le champ de saisie sans l'envoyer : on relit ses
 * arguments avant de mettre quoi que ce soit sous tension.
 */
function CommandHelp({ onPick }: { onPick: (syntax: string) => void }): ReactNode {
  const [query, setQuery] = useState('');
  const groups = searchCommands(query);

  return (
    <div className="flex min-h-0 w-72 shrink-0 flex-col gap-2 rounded-[4px] border border-line-soft bg-panel p-2">
      <input
        className="shrink-0 rounded-[3px] border border-line bg-raise px-2 py-1 font-mono text-[11px] text-fg outline-none focus:border-fg-3"
        placeholder="search commands…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {groups.length === 0 && (
          <p className="px-1 py-2 text-[11px] text-fg-3">No command matches.</p>
        )}
        {groups.map((g) => (
          <section key={g.title} className="mb-2">
            <h4 className="px-1 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-3">
              {g.title}
            </h4>
            {g.commands.map((c) => (
              <button
                key={c.verb}
                type="button"
                onClick={() => onPick(c.syntax)}
                title="Copy into the input, without sending"
                className="block w-full rounded-[3px] px-1 py-1 text-left hover:bg-raise"
              >
                <span className="font-mono text-[11px] text-fg">{c.syntax}</span>
                {c.arms === true && (
                  <span className="ml-1 font-mono text-[10px] text-warn">power</span>
                )}
                <span className="mt-0.5 block text-[11px] leading-snug text-fg-3">
                  {c.summary}
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * Bouton de filtre. Actif = la catégorie est affichée ; éteint = elle est masquée.
 *
 * Le libellé ne change jamais et la couleur porte l'état : un bouton dont le texte bascule
 * entre « masquer » et « afficher » oblige à relire pour savoir ce qui se passe.
 */
function FilterChip({
  label,
  on,
  onClick,
  title,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  title: string;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`rounded-[3px] border px-2 py-0.5 font-mono text-[11px] tracking-wide transition-colors ${
        on
          ? 'border-line bg-raise text-fg'
          : 'border-line-soft bg-transparent text-fg-3 line-through decoration-fg-3/60'
      }`}
    >
      {label}
    </button>
  );
}

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  debug: 'text-fg-3',
  info: 'text-fg',
  warn: 'text-accent',
  error: 'text-fault',
};

const SOURCE_COLOR: Record<LogEntry['source'], string> = {
  device: 'text-info',
  gui: 'text-fg-3',
  mcp: 'text-accent',
};

export function Console({
  state,
  entries,
  onClear,
}: {
  state: DeviceSnapshot;
  entries: LogEntry[];
  onClear: () => void;
}): ReactNode {
  const [line, setLine] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const { busy, run } = useAction();
  const endRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState<ConsoleFilter>(load);
  const [help, setHelp] = useState(false);

  const update = (next: ConsoleFilter): void => {
    setFilter(next);
    save(next);
  };

  const visible = applyFilter(entries, filter);
  const hidden = entries.length - visible.length;

  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: 'end' });
  }, [visible.length, follow]);

  const connected = state.connection === 'connected';

  const send = (text: string): void => {
    const cmd = text.trim();
    if (cmd === '' || !connected) return;
    setHistory((h) => [...h.filter((x) => x !== cmd), cmd].slice(-50));
    setCursor(-1);
    setLine('');
    void run(() => api().console(cmd));
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex min-h-0 flex-1 gap-2">
      <div
        className="min-h-0 flex-1 overflow-auto rounded-[4px] border border-line-soft bg-panel p-2 font-mono text-[12px]"
        onScroll={(e) => {
          const el = e.currentTarget;
          // On ne suit la fin que si l'utilisateur y est déjà : sinon il ne pourrait pas
          // relire une trace pendant que le device parle.
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
      >
        {visible.length === 0 ? (
          <Empty
            title={entries.length === 0 ? 'Log is empty' : 'Everything is filtered out'}
            hint={
              entries.length === 0
                ? 'Exchanges with the device appear here.'
                : `${entries.length} lines are hidden by the filters above.`
            }
          />
        ) : (
          visible.map((e) => (
            <div key={e.id} className="selectable flex gap-2 leading-relaxed">
              <span className="shrink-0 text-fg-3">
                {new Date(e.at).toISOString().slice(11, 23)}
              </span>
              <span className={`w-12 shrink-0 ${SOURCE_COLOR[e.source]}`}>{e.source}</span>
              <span className={`min-w-0 break-words ${LEVEL_COLOR[e.level]}`}>{e.text}</span>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      {/* Le rappel se glisse a cote du journal plutot que par-dessus : on lit une reponse
          et la syntaxe de la commande suivante en meme temps. */}
      {help && <CommandHelp onPick={(syntax) => setLine(syntax)} />}
      </div>

      {/* Les filtres au-dessus des raccourcis : on règle ce qu'on voit avant de parler. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-fg-3">show</span>
        {LEVELS.map((l) => (
          <FilterChip
            key={l}
            label={l}
            on={filter.levels.includes(l)}
            title={
              l === 'debug'
                ? 'Traffic the interface generates for itself: the safety heartbeat and the monitoring poll. Hidden by default.'
                : `Show ${l} lines`
            }
            onClick={() => update({ ...filter, levels: toggle(filter.levels, l) })}
          />
        ))}
        <span className="mx-1 h-3 w-px bg-line" />
        {SOURCES.map((src) => (
          <FilterChip
            key={src}
            label={src}
            on={filter.sources.includes(src)}
            title={`Show lines from ${src}`}
            onClick={() => update({ ...filter, sources: toggle(filter.sources, src) })}
          />
        ))}
        <input
          className="w-40 rounded-[3px] border border-line bg-raise px-2 py-0.5 font-mono text-[11px] text-fg outline-none focus:border-fg-3"
          placeholder="contains…"
          value={filter.match}
          onChange={(e) => update({ ...filter, match: e.target.value })}
        />
        <div className="flex-1" />
        {/* Un filtre qui masque doit le dire, toujours : un journal amputé en silence est
            un mensonge par omission, et c'est précisément ce qu'on vient chercher ici. */}
        {!showsEverything(filter) && (
          <button
            type="button"
            onClick={() => update(DEFAULT_FILTER)}
            title="Reset the filters to their defaults"
            className="font-mono text-[11px] text-accent hover:underline"
          >
            {hidden} hidden
          </button>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {QUICK_COMMANDS.map((s) => (
          <Button key={s} onClick={() => send(s)} disabled={!connected || busy}>
            {s}
          </Button>
        ))}
        <div className="flex-1" />
        <Button onClick={() => setHelp((v) => !v)} {...(help ? { tone: 'accent' as const } : {})}>
          {help ? 'Hide commands' : 'Commands'}
        </Button>
        {!follow && (
          <Button onClick={() => setFollow(true)} tone="accent">
            Follow tail
          </Button>
        )}
        <Button onClick={onClear}>Clear</Button>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <span className="font-mono text-[12px] text-fg-3">&gt;</span>
        <input
          className="flex-1 rounded-[3px] border border-line bg-raise px-2 py-1 font-mono text-[12px] text-fg outline-none focus:border-fg-3 disabled:opacity-40"
          placeholder={connected ? 'command…' : 'no device connected'}
          value={line}
          disabled={!connected || busy}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send(line);
            // Historique : indispensable dès qu'on répète une mesure.
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              const next = cursor < 0 ? history.length - 1 : Math.max(0, cursor - 1);
              if (history[next] !== undefined) {
                setCursor(next);
                setLine(history[next]);
              }
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (cursor < 0) return;
              const next = cursor + 1;
              if (next >= history.length) {
                setCursor(-1);
                setLine('');
              } else {
                setCursor(next);
                setLine(history[next]!);
              }
            }
          }}
        />
      </div>
    </div>
  );
}
