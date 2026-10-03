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
import { Button, Empty } from './components/ui.js';
import { Hint } from './components/Hint.js';
import { CriticalControls, SafetyBadge, StatusBadge } from './components/SafetyControls.js';
import { api, useAction, useControlDetached, useDeviceLog, useDeviceState } from './useDevice.js';
import { useTheme } from './useTheme.js';
import { useConfig } from './config.js';
import { PROTO_CAP } from '../shared/protocol.js';
import { Console } from './views/Console.js';
import { Dashboard } from './views/Dashboard.js';
import { Scope } from './views/Scope.js';
import { Firmware } from './views/Firmware.js';
import { Tuning } from './views/Tuning.js';
import { Control } from './views/Control.js';
import { Recipes } from './views/Recipes.js';

type ViewId = 'dashboard' | 'control' | 'tuning' | 'recipes' | 'scope' | 'firmware';

interface ViewDef {
  id: ViewId;
  label: string;
  /** Jalon qui rendra la vue disponible ; `null` si elle l'est deja. */
  pending: string | null;
  why?: string;
  /**
   * Bit de capacite exige du device connecte.
   *
   * Preferable a un jalon ecrit en dur : le firmware ne leve un bit que pour ce qui est
   * reellement implemente, donc l'interface dit la verite sur **le** firmware branche, et
   * pas sur celui qu'on croyait avoir compile. Une vue ainsi gardee se debloque toute
   * seule le jour ou la carte annonce la capacite.
   */
  requires?: number;
}

/* Hauteur de la console. Le plancher laisse voir deux lignes et l'en-tete ; le plafond
 * garde toujours un tiers de la fenetre a la vue courante, sinon on redimensionne jusqu'a
 * faire disparaitre ce qu'on etait venu regarder. */
const CONSOLE_DEFAULT_H = 288;   /* les 18 rem d'avant */
const CONSOLE_HEADER_H = 32;
const CONSOLE_MIN_H = 96;

function clampConsoleH(px: number): number {
  const max = Math.max(CONSOLE_MIN_H, Math.round(window.innerHeight * 0.66));
  return Math.round(Math.max(CONSOLE_MIN_H, Math.min(max, px)));
}

const VIEWS: ViewDef[] = [
  { id: 'dashboard', label: 'Dashboard', pending: null },
  { id: 'tuning', label: 'Tuning', pending: null },
  { id: 'control', label: 'Control', pending: null },
  {
    id: 'scope',
    label: 'Scope',
    pending: null,
    requires: PROTO_CAP.SCOPE,
    why: 'This firmware does not announce the scope capability.',
  },
  { id: 'recipes', label: 'Recipes', pending: null },
  {
    id: 'firmware',
    label: 'Firmware',
    pending: null,
    requires: PROTO_CAP.BOOTLOADER,
    why: 'This firmware does not announce a bootloader: the board is programmed over SWD.',
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

/* ------------------------------------------------------------------ application */

export function App(): ReactNode {
  const state = useDeviceState();
  const { entries, clear } = useDeviceLog();
  const [view, setView] = useState<ViewId>('dashboard');
  const { config, update } = useConfig();
  const consoleOpen = config.layout.consoleOpen;
  const setConsoleOpen = (open: boolean): void => update({ layout: { consoleOpen: open } });
  /* Hauteur de la console : retenue dans `config.json` (`layout.consoleH`). Pendant un
   * glissement elle vit dans l'etat local, et n'est ecrite qu'au lacher — sinon chaque
   * pixel de mouvement reecrirait le fichier. */
  const [dragH, setDragH] = useState<number | null>(null);
  const consoleH = dragH ?? clampConsoleH(config.layout.consoleH);
  const setConsoleH = (h: number | ((h: number) => number)): void => {
    const v = typeof h === 'function' ? h(consoleH) : h;
    update({ layout: { consoleH: clampConsoleH(v) } });
  };

  /* Glissement. On ecoute sur la fenetre et non sur la poignee : un mouvement rapide sort
   * d'une bande de six pixels bien avant que le navigateur ait le temps d'emettre
   * l'evenement suivant, et la poignee lacherait en plein geste. */
  const startResize = (down: React.MouseEvent): void => {
    down.preventDefault();
    const y0 = down.clientY;
    const h0 = consoleH;
    let last = h0;
    const move = (m: MouseEvent): void => {
      last = clampConsoleH(h0 - (m.clientY - y0));
      setDragH(last);
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      update({ layout: { consoleH: last } });
      setDragH(null);
    };
    // Sans ca, le glissement selectionne le texte de toute la fenetre au passage.
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const { theme, toggle: toggleTheme } = useTheme();
  const controlDetached = useControlDetached();
  const dock = useAction();

  /**
   * Une vue est indisponible soit parce que le jalon n'y est pas, soit parce que le device
   * connecte n'annonce pas la capacite. Hors connexion on ne bloque pas : la vue affiche
   * elle-meme qu'aucun device n'est branche, ce qui est plus utile qu'un onglet grise.
   */
  const unavailable = (v: ViewDef): string | null => {
    if (v.pending !== null) return v.pending;
    if (v.requires === undefined) return null;
    if (state.info === null) return null;
    return (state.info.capabilities & v.requires) !== 0 ? null : 'n/a';
  };

  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0]!;
  const currentBlocked = unavailable(current);

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
        <SafetyBadge state={state} />

        {/* La bascule de theme ne touche qu'a un attribut de la racine. Placee avant les
            deux commandes critiques pour ne pas s'intercaler entre elles et la main. */}
        <Button
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
        >
          {theme === 'dark' ? 'Light' : 'Dark'}
        </Button>

        <CriticalControls state={state} />
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Rail de navigation */}
        <nav className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-line bg-panel p-2">
          {VIEWS.map((v) => {
            const blocked = unavailable(v);
            const disabled = blocked !== null;
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
                {v.id === 'control' && controlDetached && blocked === null && (
                  <span className="rounded-[2px] bg-panel-2 px-1 font-mono text-[10px] text-fg-3" title="Open in its own window">
                    window
                  </span>
                )}
                {blocked !== null && (
                  <span className="rounded-[2px] bg-panel-2 px-1 font-mono text-[10px] text-fg-3">
                    {blocked}
                  </span>
                )}
              </button>
            );
          })}

          <div className="flex-1" />
          <div className="px-2 py-1">
            <Hint label="About greyed views">
              A greyed view is waiting for the milestone shown. Nothing is hidden: what is
              missing is what the firmware cannot do yet.
            </Hint>
          </div>
        </nav>

        {/* Vue courante */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden">
            {view === 'dashboard' && <Dashboard state={state} />}
            {view === 'tuning' && <Tuning state={state} />}
            {view === 'control' && !controlDetached && (
              <Control state={state} onDetach={() => void dock.run(() => api().detachControl())} />
            )}
            {view === 'control' && controlDetached && (
              <div className="flex h-full flex-col items-center justify-center gap-3">
                <p className="text-[13px] text-fg-2">Control is open in its own window</p>
                <p className="max-w-md text-center text-[12px] text-fg-3">
                  Keep it beside the Scope or the Dashboard to record while you drive. STOP and
                  AI CONTROL stay in both windows.
                </p>
                <div className="flex gap-2">
                  <Button tone="accent" onClick={() => void dock.run(() => api().detachControl())}>
                    Show window
                  </Button>
                  <Button onClick={() => void dock.run(() => api().dockControl())}>Dock back here</Button>
                </div>
              </div>
            )}
            {view === 'recipes' && <Recipes state={state} />}
            {view === 'scope' && currentBlocked === null && <Scope state={state} />}
            {view === 'firmware' && currentBlocked === null && <Firmware state={state} />}
            {currentBlocked !== null && (
              <Empty
                title={
                  currentBlocked === 'n/a'
                    ? `${current.label} — not announced by this firmware`
                    : `${current.label} — milestone ${currentBlocked}`
                }
                hint={current.why}
              />
            )}
          </div>

          {/* Console repliable et **redimensionnable**.

              Sa hauteur était figée à 18 rem : confortable sur un portable, ridicule en
              plein écran, et impossible à changer quand une réponse est longue. La poignée
              se saisit à la souris comme au clavier, un double-clic revient au défaut, et
              la hauteur survit à la session — on ne la règle pas vingt fois par jour. */}
          {consoleOpen && (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize the console"
              tabIndex={0}
              onMouseDown={startResize}
              onDoubleClick={() => setConsoleH(CONSOLE_DEFAULT_H)}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 64 : 16;
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setConsoleH((h) => clampConsoleH(h + step));
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setConsoleH((h) => clampConsoleH(h - step));
                }
              }}
              className="h-1.5 shrink-0 cursor-row-resize bg-line transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
              title="Drag to resize, double-click to reset"
            />
          )}
          <div
            className="shrink-0 border-t border-line bg-panel"
            style={{ height: consoleOpen ? `${consoleH}px` : 'auto' }}
          >
            <div className="flex items-center gap-2 border-b border-line-soft px-3 py-1">
              <button
                type="button"
                className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-2 hover:text-fg"
                onClick={() => setConsoleOpen(!consoleOpen)}
              >
                {consoleOpen ? '▾' : '▸'} Console
              </button>
              <span className="font-mono text-[11px] text-fg-3">{entries.length} lines</span>
            </div>
            {consoleOpen && (
              <div style={{ height: Math.max(0, consoleH - CONSOLE_HEADER_H) }}>
                <Console state={state} entries={entries} onClear={clear} />
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
