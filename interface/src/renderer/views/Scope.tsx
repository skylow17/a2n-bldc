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

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import type { DeviceSnapshot } from '../../main/device/DeviceCore.js';
import type { ScopeCapture } from '../../shared/client.js';
import { ScopeTrigger, type ScopeTriggerValue, type SignalDesc } from '../../shared/protocol.js';
import { TimeSeriesChart, groupByUnit, seriesColor } from '../components/Chart.js';
import { ChartStack } from '../components/ChartStack.js';
import { Button, Empty, Panel } from '../components/ui.js';
import { captureFileName, captureToCsv } from '../scopeExport.js';
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

export function Scope({ state }: { state: DeviceSnapshot }): ReactNode {
  const [dict, setDict] = useState<SignalDesc[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [depth, setDepth] = useState<number>(2048);
  const [decimation, setDecimation] = useState<number>(1);
  const [mode, setMode] = useState<ScopeTriggerValue>(ScopeTrigger.IMMEDIATE);
  const [triggerSignal, setTriggerSignal] = useState<string>('');
  const [threshold, setThreshold] = useState<string>('0');
  const [pretriggerPct, setPretriggerPct] = useState<number>(0);
  const [result, setResult] = useState<{ signals: SignalDesc[]; capture: ScopeCapture } | null>(null);
  const { busy, error, run } = useAction();

  const connected = state.connection === 'connected';

  // Le dictionnaire vient du device. Rien n'est codé en dur ici : un signal ajouté au
  // firmware devient capturable sans toucher à l'interface.
  useEffect(() => {
    if (!connected) {
      setDict([]);
      setPicked([]);
      setResult(null);
      return;
    }
    let alive = true;
    void api()
      .readSignals()
      .then((list) => {
        if (!alive) return;
        setDict(list);
        const first = list.slice(0, MAX_SIGNALS).map((s) => s.name);
        setPicked(first);
        setTriggerSignal(first[0] ?? '');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [connected]);

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
      const r = await api().captureScope({
        depth,
        decimation,
        pretriggerSamples,
        triggerMode: mode,
        ...(immediate ? {} : { triggerSignalName: triggerSignal }),
        threshold: Number(threshold) || 0,
        signalNames: picked,
      });
      setResult(r);
    });
  };

  /* --- mise en forme de la capture ------------------------------------------- */

  const plotted = useMemo(() => {
    if (result === null) return null;
    const { signals, capture: c } = result;
    const base = scopeTimeBase(c.samples.length, c.status);
    return {
      ...base,
      series: signals.map((_s, col) => c.samples.map((p) => p[col] ?? NaN)),
      names: signals.map((s) => s.name),
      units: signals.map((s) => s.unit),
      groups: groupByUnit(signals.map((s) => s.name), signals.map((s) => s.unit)),
      status: c.status,
    };
  }, [result]);

  const exportCsv = (): void => {
    if (plotted === null) return;
    void run(async () => {
      await api().saveText(
        captureFileName(plotted.t.length),
        captureToCsv({
          t: plotted.t,
          series: plotted.series,
          names: plotted.names,
          units: plotted.units,
        }),
      );
    });
  };

  const colorOf = (name: string): string => seriesColor(dict.findIndex((s) => s.name === name));

  if (!connected) {
    return (
      <Empty
        title="No device connected"
        hint="Pick a port in the top bar, or “Simulator” to work without hardware."
      />
    );
  }

  return (
        /* Meme regle que le Dashboard : la capture prend ce qui reste, et non une hauteur
       relative a la fenetre choisie au juge. En dessous de `xl` la page defile et la
       capture reprend une hauteur en `vh`, faute de place pour faire autrement. */
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3 xl:overflow-hidden">
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
                <span
                  className="inline-block h-[3px] w-2.5 rounded-[2px]"
                  style={{ background: on ? colorOf(s.name) : 'transparent' }}
                  aria-hidden="true"
                />
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

      {plotted === null ? (
        <Panel title="Capture result">
          <Empty
            title="No capture yet"
            hint="Press Capture. The firmware records in RAM at the control-loop rate, then the buffer is read back."
          />
        </Panel>
      ) : (
        <Panel
          /* Même raison que pour le tracé du Dashboard : une hauteur définie, sans quoi
             les graphes n'ont rien à se partager. `shrink-0` parce que la vue défile. */
          className="h-[min(62vh,760px)] min-h-0 shrink-0 xl:h-auto xl:flex-1"
          title="Capture result"
          right={
            <div className="flex items-center gap-3">
              <span className="font-mono text-[11px] text-fg-3">
                {plotted.status.captured} pts · {plotted.periodMs.toFixed(3)} ms/pt ·{' '}
                {plotted.durationMs.toFixed(2)} ms
              </span>
              <Button onClick={exportCsv} disabled={busy} title="Save this capture as CSV">
                Export CSV
              </Button>
            </div>
          }
        >
          <ChartStack count={plotted.groups.length} className="flex flex-col p-2">
            {(chartH) => (
              <>
            {plotted.groups.map(([unit, indices], g) => (
              <TimeSeriesChart
                key={unit}
                t={plotted.t}
                series={indices.map((i) => plotted.series[i] ?? [])}
                labels={indices.map((i) => plotted.names[i] ?? '')}
                colors={indices.map((i) => colorOf(plotted.names[i] ?? ''))}
                unit={unit === '' ? '(no unit)' : unit}
                showXLabel={g === plotted.groups.length - 1}
                xLabel="time from trigger (ms)"
                // Le repère marque l'instant de déclenchement, origine de l'axe. Pas de
                // repère si le déclenchement n'a pas eu lieu : une ligne à zéro laisserait
                // croire qu'il a eu lieu au premier point.
                markerX={plotted.triggerIndex === null ? null : 0}
                height={chartH}
                /* Une capture ne bouge plus : la navigation y a tout son sens, et c'est
                   meme la seule facon de regarder deux mille points sur huit cents pixels.
                   La clef de synchronisation aligne curseur et axe des temps entre les
                   graphes empiles — sans elle, zoomer sur l'un ferait comparer des
                   abscisses differentes sans qu'on s'en apercoive. */
                interactive
                syncKey="scope"
              />
            ))}
            <p className="px-1 pb-1 text-[11px] leading-relaxed text-fg-3">
              Time is relative to the trigger, marked by the dashed line: negative before,
              positive after. One vertical scale per unit. Scroll to zoom around the
              pointer, drag to pan, double-click to fit; the stacked charts follow each
              other.
            </p>
              </>
            )}
          </ChartStack>
        </Panel>
      )}
    </div>
  );
}
