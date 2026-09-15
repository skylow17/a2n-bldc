/**
 * Chrome de l'application : barre haute, rail de navigation, console repliable.
 *
 * Deux éléments sont visibles depuis n'importe quelle vue et ne disparaissent jamais : le
 * bouton STOP et l'interrupteur de pilotage par agent. C'est une règle du projet, pas une
 * préférence esthétique — on doit pouvoir couper sans chercher où cliquer.
 */

import { useEffect, useState, type ReactNode } from 'react';

import type { DeviceSnapshot } from '../main/device/DeviceCore.js';
import type { SerialPortInfo } from '../node/serial.js';
import { Button, Dot, Empty, Toggle } from './components/ui.js';
import { api, useAction, useDeviceLog, useDeviceState } from './useDevice.js';
import { Console } from './views/Console.js';
import { Dashboard } from './views/Dashboard.js';
import { Tuning } from './views/Tuning.js';

type ViewId = 'dashboard' | 'control' | 'tuning' | 'recipes' | 'scope' | 'firmware';

interface ViewDef {
  id: ViewId;
  label: string;
  /** Jalon qui rendra la vue disponible ; `null` si elle l'est deja. */
  pending: string | null;
  why?: string;
}

const VIEWS: ViewDef[] = [
  { id: 'dashboard', label: 'Dashboard', pending: null },
  { id: 'tuning', label: 'Tuning', pending: null },
  {
    id: 'control',
    label: 'Control',
    pending: 'M3',
    why: 'The firmware has no control loop yet: no motion command exists at this milestone.',
  },
  {
    id: 'scope',
    label: 'Scope',
    pending: 'M1c',
    why: 'Capture and subscribed telemetry arrive in the next milestone.',
  },
  {
    id: 'recipes',
    label: 'Recipes',
    pending: 'M2',
    why: 'NVM persistence does not exist yet: an applied recipe would not survive a reset.',
  },
  {
    id: 'firmware',
    label: 'Firmware',
    pending: 'later',
    why: 'The A/B bootloader is not written; the board is programmed over SWD.',
  },
];

/* ------------------------------------------------------------------ barre haute */

function ConnectionBar({ state }: { state: DeviceSnapshot }): ReactNode {
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [target, setTarget] = useState('simulator');
  const { busy, error, run } = useAction();

  const refreshPorts = (): void => {
    void api()
      .listPorts()
      .then(setPorts)
      .catch(() => setPorts([]));
  };

  useEffect(refreshPorts, []);

  const connected = state.connection === 'connected';

  return (
    <div className="flex items-center gap-2">
      <select
        className="rounded-[3px] border border-line bg-raise px-2 py-1 font-mono text-[12px] text-fg outline-none disabled:opacity-40"
        value={target}
        disabled={connected || busy}
        onChange={(e) => setTarget(e.target.value)}
        onClick={refreshPorts}
      >
        <option value="simulator">Simulator</option>
        {ports.map((p) => (
          <option key={p.path} value={p.path}>
            {p.path}
            {p.vendorId === '0483' && p.productId === '5740' ? ' — A2N BLDC' : ''}
          </option>
        ))}
      </select>

      {connected ? (
        <Button onClick={() => void run(() => api().disconnect())} disabled={busy}>
          Disconnect
        </Button>
      ) : (
        <Button
          tone="accent"
          disabled={busy}
          onClick={() =>
            void run(() =>
              api().connect(
                target === 'simulator' ? { kind: 'simulator' } : { kind: 'serial', path: target },
              ),
            )
          }
        >
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      )}

      {error !== null && (
        <span className="max-w-md truncate text-[11px] text-fault" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

function StatusBadge({ state }: { state: DeviceSnapshot }): ReactNode {
  const map = {
    disconnected: { tone: 'idle', text: 'DISCONNECTED' },
    connecting: { tone: 'warn', text: 'CONNECTING' },
    connected: { tone: 'ok', text: 'CONNECTED' },
    error: { tone: 'fault', text: 'ERROR' },
  } as const;
  const s = map[state.connection];

  return (
    <span className="flex items-center gap-2 rounded-[3px] border border-line bg-raise px-2.5 py-1 font-mono text-[11px] tracking-wider">
      <Dot tone={s.tone} />
      {s.text}
      {state.info !== null && <span className="text-fg-3">{state.info.fwVersion}</span>}
    </span>
  );
}

/* ------------------------------------------------------------------ application */

export function App(): ReactNode {
  const state = useDeviceState();
  const { entries, clear } = useDeviceLog();
  const [view, setView] = useState<ViewId>('dashboard');
  const [consoleOpen, setConsoleOpen] = useState(true);
  const stop = useAction();

  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0]!;

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      {/* Barre haute */}
      <header className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-3 py-2">
        <span className="font-mono text-[13px] font-semibold tracking-wide text-accent">
          A2N BLDC
        </span>
        <ConnectionBar state={state} />
        <div className="flex-1" />
        <StatusBadge state={state} />

        <Toggle
          label="AI CONTROL"
          checked={state.aiControl}
          onChange={(v) => void api().setAiControl(v)}
          title="Allows an agent to drive the bench. Firmware limits remain the only safety guarantee."
        />

        {/* STOP : toujours présent, jamais désactivé tant qu'un device est connecté. */}
        <Button
          tone="danger"
          className="px-4 py-1.5 font-bold tracking-wider"
          disabled={state.connection !== 'connected' || stop.busy}
          title="Cuts torque immediately"
          onClick={() =>
            void stop.run(async () => {
              await api().console('STOP');
              await api().setAiControl(false);
            })
          }
        >
          STOP
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Rail de navigation */}
        <nav className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-line bg-panel p-2">
          {VIEWS.map((v) => {
            const disabled = v.pending !== null;
            return (
              <button
                key={v.id}
                type="button"
                title={v.why}
                disabled={disabled}
                onClick={() => setView(v.id)}
                className={`flex items-center justify-between rounded-[3px] px-2 py-1.5 text-left text-[12px] transition-colors ${
                  view === v.id
                    ? 'bg-accent/15 text-accent'
                    : disabled
                      ? 'cursor-not-allowed text-fg-3'
                      : 'text-fg-2 hover:bg-panel-2 hover:text-fg'
                }`}
              >
                {v.label}
                {v.pending !== null && (
                  <span className="rounded-[2px] bg-panel-2 px-1 font-mono text-[10px] text-fg-3">
                    {v.pending}
                  </span>
                )}
              </button>
            );
          })}

          <div className="flex-1" />
          <p className="px-2 py-1 text-[10px] leading-relaxed text-fg-3">
            A greyed view is waiting for the milestone shown. Nothing is hidden: what is
            missing is what the firmware cannot do yet.
          </p>
        </nav>

        {/* Vue courante */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden">
            {view === 'dashboard' && <Dashboard state={state} />}
            {view === 'tuning' && <Tuning state={state} />}
            {current.pending !== null && (
              <Empty title={`${current.label} — milestone ${current.pending}`} hint={current.why} />
            )}
          </div>

          {/* Console repliable */}
          <div
            className="shrink-0 border-t border-line bg-panel"
            style={{ height: consoleOpen ? '18rem' : 'auto' }}
          >
            <div className="flex items-center gap-2 border-b border-line-soft px-3 py-1">
              <button
                type="button"
                className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-2 hover:text-fg"
                onClick={() => setConsoleOpen((o) => !o)}
              >
                {consoleOpen ? '▾' : '▸'} Console
              </button>
              <span className="font-mono text-[11px] text-fg-3">{entries.length} lines</span>
            </div>
            {consoleOpen && (
              <div className="h-[calc(18rem-2rem)]">
                <Console state={state} entries={entries} onClear={clear} />
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
