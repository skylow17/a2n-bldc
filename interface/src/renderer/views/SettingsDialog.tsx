/**
 * Réglages de l'interface — tout ce que contient `config.json`.
 *
 * Chaque changement s'écrit immédiatement dans le fichier (pas de bouton « Apply » à
 * oublier) et passe par le même juge que l'import (`shared/config.ts`). Import, export et
 * retour aux défauts sont en pied de fenêtre.
 *
 * Aucune limite du banc ne se règle ici : elles vivent dans le firmware et se changent dans
 * la vue Tuning, journalisées.
 */

import { useEffect, useState, type ReactNode } from 'react';

import {
  SCOPE_DECIMATIONS,
  SCOPE_DEPTHS,
  SCOPE_PRETRIGGER_PCT,
  TELEMETRY_RATES,
  TELEMETRY_WINDOWS,
} from '../../shared/config.js';
import type { SignalDesc } from '../../shared/protocol.js';
import { Dialog } from '../components/Dialog.js';
import { TraceSwatch, useTraceStyles } from '../components/TraceSwatch.js';
import { Button } from '../components/ui.js';
import { useConfig } from '../config.js';
import { api, useAction } from '../useDevice.js';

type Tab = 'general' | 'plots' | 'scope' | 'telemetry' | 'measurements';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'plots', label: 'Plots' },
  { id: 'scope', label: 'Scope' },
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'measurements', label: 'Measurements' },
];

const sel =
  'rounded-[3px] border border-line bg-raise px-1.5 py-1 font-mono text-[12px] text-fg outline-none disabled:opacity-40';

function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line-soft px-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[12px] text-fg">{label}</div>
        {help !== undefined && <div className="text-[11px] text-fg-3">{help}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Choice<T extends string | number>({
  value,
  options,
  onChange,
  format = (v) => String(v),
}: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  format?: (v: T) => string;
}): ReactNode {
  return (
    <select
      className={sel}
      value={String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        const hit = options.find((o) => String(o) === raw);
        if (hit !== undefined) onChange(hit);
      }}
    >
      {options.map((o) => (
        <option key={String(o)} value={String(o)}>
          {format(o)}
        </option>
      ))}
    </select>
  );
}

function Check({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): ReactNode {
  return <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />;
}

function PlotColors({ signals }: { signals: SignalDesc[] }): ReactNode {
  const { config, update } = useConfig();
  const overrides = config.plots.traceColors;
  // Les signaux du device, plus ceux qui ont une couleur imposée sans être connus de lui.
  const names = [...new Set([...signals.map((s) => s.name), ...Object.keys(overrides)])];
  const units = names.map((n) => signals.find((s) => s.name === n)?.unit ?? `?${n}`);
  // Un graphe par signal ici : chaque ligne montre la couleur que prend le signal seul.
  const styles = useTraceStyles(names, units.map((u, i) => `${u}#${i}`));
  return (
    <div>
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-[11px] text-fg-3">
          Automatic colours follow the physical quantity; a setpoint takes its measurement’s
          colour, dashed. Click a swatch to set one by hand.
        </span>
        <Button disabled={Object.keys(overrides).length === 0} onClick={() => update({ plots: { traceColors: {} } })}>
          Reset all
        </Button>
      </div>
      {names.length === 0 && (
        <p className="px-4 py-3 text-[12px] text-fg-3">Connect a device to list its signals.</p>
      )}
      {names.map((n) => (
        <div key={n} className="flex items-center gap-3 px-4 py-1 odd:bg-panel-2/40">
          <TraceSwatch name={n} style={styles.get(n)} />
          <span className="flex-1 font-mono text-[12px] text-fg-2">{n}</span>
          <span className="font-mono text-[11px] text-fg-3">{overrides[n] ?? 'auto'}</span>
        </div>
      ))}
    </div>
  );
}

export function SettingsDialog({ onClose, onOpenMcp }: { onClose: () => void; onOpenMcp: () => void }): ReactNode {
  const { config, update } = useConfig();
  const [tab, setTab] = useState<Tab>('general');
  const [dataDir, setDataDir] = useState('');
  const [signals, setSignals] = useState<SignalDesc[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const act = useAction();

  useEffect(() => {
    void api().dataDir().then(setDataDir).catch(() => undefined);
    void api().readSignals().then(setSignals).catch(() => setSignals([]));
  }, [config]);

  return (
    <Dialog
      title="Settings"
      onClose={onClose}
      footer={
        <>
          <Button
            onClick={() =>
              void act.run(async () => {
                const r = await api().importConfig();
                if (r !== null) {
                  setReport(
                    r.warnings.length === 0
                      ? `Imported ${r.path}.`
                      : `Imported ${r.path} with ${r.warnings.length} warning(s): ${r.warnings.join('; ')}`,
                  );
                }
              })
            }
          >
            Import…
          </Button>
          <Button
            onClick={() =>
              void act.run(async () => {
                const p = await api().exportConfig();
                if (p !== null) setReport(`Exported to ${p}.`);
              })
            }
          >
            Export…
          </Button>
          <Button
            onClick={() =>
              void act.run(async () => {
                await api().resetConfig();
                setReport('Every setting is back to its default.');
              })
            }
          >
            Reset defaults
          </Button>
          <span className="min-w-0 flex-1 truncate text-[11px] text-fg-3" title={report ?? act.error ?? ''}>
            {act.error ?? report ?? 'Changes are saved as you make them.'}
          </span>
          <Button tone="accent" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="flex min-h-[420px]">
        <nav className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-line-soft p-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-[3px] px-2 py-1.5 text-left text-[12px] ${
                tab === t.id ? 'bg-accent/15 text-accent' : 'text-fg-2 hover:bg-panel-2 hover:text-fg'
              }`}
            >
              {t.label}
            </button>
          ))}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onOpenMcp}
            className="rounded-[3px] px-2 py-1.5 text-left text-[12px] text-fg-2 hover:bg-panel-2 hover:text-fg"
          >
            AI / MCP server…
          </button>
        </nav>

        <div className="min-w-0 flex-1">
          {tab === 'general' && (
            <>
              <Row label="Theme">
                <Choice
                  value={config.ui.theme}
                  options={['dark', 'light'] as const}
                  onChange={(v) => update({ ui: { theme: v } })}
                  format={(v) => (v === 'dark' ? 'Dark' : 'Light')}
                />
              </Row>
              <Row label="Explanations" help="Behind an icon (hover or click), or written out in each panel">
                <Choice
                  value={config.ui.helpMode}
                  options={['icons', 'inline'] as const}
                  onChange={(v) => update({ ui: { helpMode: v } })}
                  format={(v) => (v === 'icons' ? 'Icons' : 'Inline')}
                />
              </Row>
              <Row label="Interface zoom" help="Ctrl + and Ctrl − change it too">
                <Choice
                  value={config.ui.zoom}
                  options={[0.8, 0.9, 1, 1.1, 1.25, 1.5] as const}
                  onChange={(v) => update({ ui: { zoom: v } })}
                  format={(v) => `${Math.round(v * 100)} %`}
                />
              </Row>
              <Row label="Data folder" help={dataDir}>
                <Button onClick={() => void act.run(() => api().openDataDir())}>Open</Button>
                <Button
                  onClick={() =>
                    void act.run(async () => {
                      const d = await api().chooseDataDir();
                      if (d !== null) setReport(`Data folder is now ${d}.`);
                    })
                  }
                >
                  Change…
                </Button>
              </Row>
            </>
          )}

          {tab === 'plots' && (
            <>
              <Row label="Line width">
                <Choice
                  value={config.plots.lineWidth}
                  options={[1, 1.5, 2, 2.5, 3] as const}
                  onChange={(v) => update({ plots: { lineWidth: v } })}
                  format={(v) => `${v} px`}
                />
              </Row>
              <Row label="Zoom selection" help="How strongly the dragged span is filled">
                <Choice
                  value={config.plots.selectionOpacity}
                  options={[0.1, 0.2, 0.3, 0.45] as const}
                  onChange={(v) => update({ plots: { selectionOpacity: v } })}
                  format={(v) => `${Math.round(v * 100)} %`}
                />
              </Row>
              <PlotColors signals={signals} />
            </>
          )}

          {tab === 'scope' && (
            <>
              <Row label="Default depth" help="Samples per capture">
                <Choice value={config.scope.depth} options={SCOPE_DEPTHS} onChange={(v) => update({ scope: { depth: v } })} />
              </Row>
              <Row label="Default decimation" help="1 keeps every 20 kHz sample">
                <Choice
                  value={config.scope.decimation}
                  options={SCOPE_DECIMATIONS}
                  onChange={(v) => update({ scope: { decimation: v } })}
                />
              </Row>
              <Row label="Default pre-trigger">
                <Choice
                  value={config.scope.pretriggerPct}
                  options={SCOPE_PRETRIGGER_PCT}
                  onChange={(v) => update({ scope: { pretriggerPct: v } })}
                  format={(v) => `${v} %`}
                />
              </Row>
            </>
          )}

          {tab === 'telemetry' && (
            <>
              <Row label="Default rate">
                <Choice
                  value={config.telemetry.rateHz}
                  options={TELEMETRY_RATES}
                  onChange={(v) => update({ telemetry: { rateHz: v } })}
                  format={(v) => `${v} Hz`}
                />
              </Row>
              <Row label="Default window" help="How much stays on screen before the trace scrolls">
                <Choice
                  value={config.telemetry.windowS}
                  options={TELEMETRY_WINDOWS}
                  onChange={(v) => update({ telemetry: { windowS: v } })}
                  format={(v) => `${v} s`}
                />
              </Row>
            </>
          )}

          {tab === 'measurements' && (
            <>
              <Row label="Keep every scope capture" help="Each capture enters the measurement history, timestamped">
                <Check
                  checked={config.measurements.autoSaveScope}
                  onChange={(v) => update({ measurements: { autoSaveScope: v } })}
                />
              </Row>
              <Row label="Longest telemetry recording" help="Record stops by itself after this">
                <Choice
                  value={config.measurements.recordMaxS}
                  options={[30, 60, 120, 300, 600, 1800, 3600] as const}
                  onChange={(v) => update({ measurements: { recordMaxS: v } })}
                  format={(v) => (v < 60 ? `${v} s` : `${v / 60} min`)}
                />
              </Row>
              <Row label="Where they are stored" help={`${dataDir}\\measurements`}>
                <Button onClick={() => void act.run(() => api().openDataDir())}>Open folder</Button>
              </Row>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
