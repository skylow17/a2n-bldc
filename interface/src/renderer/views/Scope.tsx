/**
 * Scope — capture à la cadence de la boucle de contrôle.
 *
 * C'est la capacité qui manquait entièrement au firmware v1, et la raison pour laquelle
 * aucun régulateur n'y était réglable autrement qu'à l'aveugle : le streaming souscrit
 * plafonne à 500 Hz, ce qui suffit à surveiller une machine mais pas à voir une réponse
 * indicielle de boucle de courant. Le firmware enregistre en RAM **à 20 kHz** sur condition
 * de déclenchement, puis dumpe le tampon.
 *
 * Deux choix de lecture méritent d'être dits :
 *
 * - **L'axe des temps est relatif au déclenchement**, en millisecondes, négatif avant et
 *   positif après. C'est ainsi qu'on lit un oscilloscope, et c'est ce qui donne un sens au
 *   pré-trigger : sans origine au déclenchement, les points d'avant ne se distinguent pas
 *   de ceux d'après.
 * - **Un graphe par unité**, comme pour la télémétrie. Une échelle verticale unique
 *   écraserait tout signal petit sous un signal grand.
 *
 * Libellés en anglais (AGENTS.md §5) ; commentaires en français.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import type { DeviceSnapshot } from '../../main/device/DeviceCore.js';
import { ScopeTrigger, type ScopeTriggerValue, type SignalDesc } from '../../shared/protocol.js';
import { TraceSwatch, useTraceStyles } from '../components/TraceSwatch.js';
import { useConfig } from '../config.js';
import { Button, Empty, Panel } from '../components/ui.js';
import type { Measurement } from '../../shared/measurement.js';
import { MeasurementsPanel } from '../components/MeasurementsPanel.js';
import { buildMeasurement, useMeasurementList } from '../measurements.js';
import { MeasurementViewer } from './MeasurementViewer.js';
import { scopeTimeBase } from '../scopeTime.js';
import { api, useAction } from '../useDevice.js';

/** Bornes du protocole — docs/protocol.md §6. */
const DEPTHS = [256, 512, 1024, 2048] as const;
const DECIMATIONS = [1, 2, 4, 8, 16, 32, 64] as const;
const MAX_SIGNALS = 4;

/** Le pré-trigger se règle en proportion : « garder un quart d'avant » se pense mieux
 *  que « garder 512 points d'avant ». La conversion en échantillons est affichée. */
const PRETRIGGER_PCT = [0, 10, 25, 50] as const;

const TRIGGER_MODES: Array<{ value: ScopeTriggerValue; label: string }> = [
  { value: ScopeTrigger.IMMEDIATE, label: 'Immediate' },
  { value: ScopeTrigger.RISING, label: 'Rising edge' },
  { value: ScopeTrigger.FALLING, label: 'Falling edge' },
  { value: ScopeTrigger.EITHER, label: 'Either edge' },
];

const selectClass =
  'rounded-[3px] border border-line bg-raise px-1.5 py-1 font-mono text-[11px] text-fg ' +
  'outline-none disabled:opacity-40';

function Control({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-fg-2">
      <span className="whitespace-nowrap">{label}</span>
      {children}
    </label>
  );
}

/* La mesure affichée et le dossier choisi survivent à un changement de vue : on va voir le
 * Dashboard, on revient, la mesure est toujours là. Module et non config : c'est l'état de
 * la session, pas un réglage. */
let lastShown: { m: Measurement; saved: boolean } | null = null;
let lastFolder: string | null = null;

export function Scope({ state }: { state: DeviceSnapshot }): ReactNode {
  const [dict, setDict] = useState<SignalDesc[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const { config, update } = useConfig();
  const scopeDefaults = config.scope;
  const [depth, setDepth] = useState<number>(scopeDefaults.depth);
  const [decimation, setDecimation] = useState<number>(scopeDefaults.decimation);
  const [mode, setMode] = useState<ScopeTriggerValue>(ScopeTrigger.IMMEDIATE);
  const [triggerSignal, setTriggerSignal] = useState<string>('');
  const [threshold, setThreshold] = useState<string>('0');
  const [pretriggerPct, setPretriggerPct] = useState<number>(scopeDefaults.pretriggerPct);
  /* La mesure affichée : la dernière capture, ou une mesure rouverte de l'historique.
   * `saved` dit si elle est dans l'historique — une capture ne l'est pas quand
   * l'enregistrement automatique est coupé, tant qu'on n'a pas cliqué « Keep ». */
  const [shown, setShown] = useState<{ m: Measurement; saved: boolean } | null>(lastShown);
  lastShown = shown;
  /* Dossier sélectionné dans l'arborescence : les nouvelles captures y sont rangées. */
  const [folder, setFolder] = useState<string | null>(lastFolder);
  lastFolder = folder;
  const list = useMeasurementList();
  const { busy, error, run } = useAction();
  const open = useAction();

  const connected = state.connection === 'connected';

  // Le dictionnaire vient du device. Rien n'est codé en dur ici : un signal ajouté au
  // firmware devient capturable sans toucher à l'interface.
  useEffect(() => {
    if (!connected) {
      setDict([]);
      setPicked([]);
      return;
    }
    let alive = true;
    void api()
      .readSignals()
      .then((l) => {
        if (!alive) return;
        setDict(l);
        const first = l.slice(0, MAX_SIGNALS).map((s) => s.name);
        setPicked(first);
        setTriggerSignal(first[0] ?? '');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [connected]);

  // Une mesure affichée puis supprimée de l'historique disparaît aussi d'ici.
  useEffect(() => {
    if (shown?.saved === true && !list.metas.some((x) => x.id === shown.m.id)) setShown(null);
  }, [list.metas, shown]);

  const pretriggerSamples = Math.min(depth - 1, Math.round((depth * pretriggerPct) / 100));
  const immediate = mode === ScopeTrigger.IMMEDIATE;

  // Hors mode immédiat, le signal de déclenchement doit faire partie de la capture : sinon
  // le point de déclenchement n'apparaîtrait sur aucune courbe tracée, et le firmware
  // refuserait la configuration.
  const triggerValid = immediate || picked.includes(triggerSignal);

  const toggle = (name: string): void => {
    setPicked((prev) => {
      const next = prev.includes(name)
        ? prev.filter((n) => n !== name)
        : prev.length >= MAX_SIGNALS
          ? prev
          : [...prev, name];
      return next;
    });
  };

  const capture = (): void => {
    void run(async () => {
      const request = {
        depth,
        decimation,
        pretriggerSamples,
        triggerMode: mode,
        ...(immediate ? {} : { triggerSignalName: triggerSignal }),
        threshold: Number(threshold) || 0,
        signalNames: picked,
      };
      const at = new Date();
      const r = await api().captureScope(request);
      // L'axe des temps est relatif au déclenchement, en ms — voir `scopeTime.ts`.
      const base = scopeTimeBase(r.capture.samples.length, r.capture.status);
      const m = buildMeasurement({
        kind: 'scope',
        state,
        at,
        signals: r.signals.map((x) => ({ name: x.name, unit: x.unit })),
        t: base.t,
        series: r.signals.map((_x, col) => r.capture.samples.map((row) => row[col] ?? Number.NaN)),
        markerX: base.triggerIndex === null ? null : 0,
        config: {
          ...request,
          triggerMode: TRIGGER_MODES.find((x) => x.value === mode)?.label ?? mode,
          samplePeriodMs: base.periodMs,
          triggered: base.triggerIndex !== null,
        },
      });
      if (config.measurements.autoSaveScope) {
        await api().measSave(m, folder);
        setShown({ m, saved: true });
      } else {
        setShown({ m, saved: false });
      }
    });
  };

  const openMeasurement = useCallback(
    (id: string) =>
      void open.run(async () => {
        const m = await api().measGet(id);
        setShown({ m, saved: true });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const pickStyles = useTraceStyles(picked, picked.map((n) => dict.find((s) => s.name === n)?.unit ?? ''));

  /* Hauteur du tile des mesures : retenue dans la config (`layout.measurementsH`), écrite au
   * lâcher de la poignée seulement. La poignée est **au-dessus** du tile : il est en bas. */
  const [dragH, setDragH] = useState<number | null>(null);
  const tileH = dragH ?? config.layout.measurementsH;
  const startResize = (down: React.MouseEvent): void => {
    down.preventDefault();
    const y0 = down.clientY;
    const h0 = tileH;
    let last = h0;
    const clamp = (h: number): number => Math.round(Math.max(80, Math.min(window.innerHeight * 0.7, h)));
    const move = (e: MouseEvent): void => {
      last = clamp(h0 - (e.clientY - y0));
      setDragH(last);
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      update({ layout: { measurementsH: last } });
      setDragH(null);
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-3">
      {connected ? (
      <Panel
        title="Capture"
        right={
          <Button
            tone="accent"
            disabled={busy || picked.length === 0 || !triggerValid}
            onClick={capture}
          >
            {busy ? 'Capturing…' : 'Capture'}
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-2">
          <Control label="Depth">
            <select
              className={selectClass}
              value={depth}
              disabled={busy}
              onChange={(e) => setDepth(Number(e.target.value))}
            >
              {DEPTHS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Control>

          <Control label="Decimation">
            <select
              className={selectClass}
              value={decimation}
              disabled={busy}
              onChange={(e) => setDecimation(Number(e.target.value))}
            >
              {DECIMATIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Control>

          <Control label="Trigger">
            <select
              className={selectClass}
              value={mode}
              disabled={busy}
              onChange={(e) => setMode(Number(e.target.value) as ScopeTriggerValue)}
            >
              {TRIGGER_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Control>

          {!immediate && (
            <>
              <Control label="on">
                <select
                  className={selectClass}
                  value={triggerSignal}
                  disabled={busy}
                  onChange={(e) => setTriggerSignal(e.target.value)}
                >
                  {picked.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Control>
              <Control label="at">
                <input
                  type="number"
                  className={`${selectClass} w-24`}
                  value={threshold}
                  disabled={busy}
                  onChange={(e) => setThreshold(e.target.value)}
                />
              </Control>
            </>
          )}

          <Control label="Pre-trigger">
            <select
              className={selectClass}
              value={pretriggerPct}
              disabled={busy}
              onChange={(e) => setPretriggerPct(Number(e.target.value))}
            >
              {PRETRIGGER_PCT.map((p) => (
                <option key={p} value={p}>
                  {p} %
                </option>
              ))}
            </select>
            <span className="font-mono text-fg-3">{pretriggerSamples} pts</span>
          </Control>

          <span className="font-mono text-[11px] text-fg-3">
            {/* Ce que la configuration donne réellement, calculé et non promis. */}
            {((depth * decimation) / 20).toFixed(1)} ms window @{' '}
            {(20000 / decimation).toFixed(0)} Hz
          </span>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line-soft px-3 py-2">
          {dict.map((s) => {
            const on = picked.includes(s.name);
            const full = !on && picked.length >= MAX_SIGNALS;
            return (
              <label
                key={s.id}
                className={`flex items-center gap-1.5 text-[11px] ${
                  on ? 'cursor-pointer text-fg-2' : full ? 'text-fg-3 opacity-40' : 'cursor-pointer text-fg-3'
                }`}
                title={full ? `The scope captures at most ${MAX_SIGNALS} signals` : undefined}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={busy || full}
                  onChange={() => toggle(s.name)}
                  className="h-3 w-3"
                />
                {on ? <TraceSwatch name={s.name} style={pickStyles.get(s.name)} /> : <span className="w-4" />}
                <span className="font-mono">{s.name}</span>
              </label>
            );
          })}
          <span className="text-[11px] text-fg-3">
            {picked.length}/{MAX_SIGNALS} signals
          </span>
        </div>

        {!triggerValid && (
          <p className="border-t border-line-soft px-3 py-2 text-[11px] text-accent">
            The trigger signal must be one of the captured signals — otherwise the trigger
            point would not appear on any plotted curve.
          </p>
        )}
        {error !== null && (
          <p className="border-t border-line-soft px-3 py-2 text-[11px] text-fault">{error}</p>
        )}
      </Panel>
      ) : (
        <Panel title="Capture">
          <p className="px-3 py-2 text-[12px] text-fg-3">
            No device connected — pick a port in the top bar, or “Simulator”. The measurement
            history below stays available.
          </p>
        </Panel>
      )}

      {shown === null ? (
        <Panel title="Capture result" className="min-h-0 flex-1">
          <Empty
            title={open.busy ? 'Opening…' : 'No measurement open'}
            hint={
              open.error ??
              'Press Capture, or click a measurement in the history below. The firmware records in RAM at the control-loop rate, then the buffer is read back.'
            }
          />
        </Panel>
      ) : (
        <MeasurementViewer
          className="min-h-[200px] flex-1"
          m={shown.m}
          saved={shown.saved}
          onEdited={(m) => setShown((s) => (s === null ? s : { ...s, m }))}
          onKeep={() =>
            void run(async () => {
              await api().measSave(shown.m, folder);
              setShown({ m: shown.m, saved: true });
            })
          }
        />
      )}

      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the measurement list"
        tabIndex={0}
        onMouseDown={startResize}
        onDoubleClick={() => update({ layout: { measurementsH: 220 } })}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 64 : 16;
          if (e.key === 'ArrowUp') update({ layout: { measurementsH: tileH + step } });
          if (e.key === 'ArrowDown') update({ layout: { measurementsH: Math.max(80, tileH - step) } });
        }}
        title="Drag to resize, double-click to reset"
        className="-my-1 h-1.5 shrink-0 cursor-row-resize rounded-full transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
      />
      <div className="shrink-0" style={{ height: tileH }}>
        <MeasurementsPanel
          metas={list.metas}
          tree={list.tree}
          openId={shown?.saved === true ? shown.m.id : null}
          onOpen={openMeasurement}
          folder={folder}
          onFolder={setFolder}
        />
      </div>
    </div>
  );
}
