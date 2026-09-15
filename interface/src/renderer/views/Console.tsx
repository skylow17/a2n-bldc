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
import { api, useAction } from '../useDevice.js';

const SUGGESTIONS = ['PING', 'INFO?', 'STATS?', 'LINK?', 'PWM?', 'PROTO?', 'SELFTEST'];

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

  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: 'end' });
  }, [entries, follow]);

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
      <div
        className="min-h-0 flex-1 overflow-auto rounded-[4px] border border-line-soft bg-panel p-2 font-mono text-[12px]"
        onScroll={(e) => {
          const el = e.currentTarget;
          // On ne suit la fin que si l'utilisateur y est déjà : sinon il ne pourrait pas
          // relire une trace pendant que le device parle.
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
      >
        {entries.length === 0 ? (
          <Empty title="Log is empty" hint="Exchanges with the device appear here." />
        ) : (
          entries.map((e) => (
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

      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {SUGGESTIONS.map((s) => (
          <Button key={s} onClick={() => send(s)} disabled={!connected || busy}>
            {s}
          </Button>
        ))}
        <div className="flex-1" />
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
