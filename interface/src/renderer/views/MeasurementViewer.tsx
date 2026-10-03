/**
 * Zone de résultat du Scope : une mesure, la dernière capture ou une mesure rouverte de
 * l'historique.
 *
 * On y relit la mesure comme une capture fraîche — zoom, curseurs synchronisés entre
 * graphes — et on y ajoute ce qui la rendra compréhensible plus tard : un titre et un
 * commentaire, enregistrés dans son fichier dès qu'on quitte le champ. Les exports CSV, JSON
 * et PNG partent d'ici, et du menu File.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { measurementFileStem, measurementToCsv, serializeMeasurement, type Measurement } from '../../shared/measurement.js';
import { TimeSeriesChart, groupByUnit } from '../components/Chart.js';
import { ChartStack } from '../components/ChartStack.js';
import { TraceSwatch, useTraceStyles } from '../components/TraceSwatch.js';
import { Button, Panel } from '../components/ui.js';
import { composeChartsPng } from '../chartImage.js';
import { useCommand } from '../commands.js';
import { useConfig } from '../config.js';
import { api, useAction } from '../useDevice.js';

function fmtStamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function MeasurementViewer({
  m,
  saved,
  onKeep,
  onEdited,
  className = '',
}: {
  m: Measurement;
  /** Faux : la capture n'est pas (encore) dans l'historique. */
  saved: boolean;
  onKeep: () => void;
  onEdited: (m: Measurement) => void;
  className?: string;
}): ReactNode {
  const [fit, setFit] = useState(0);
  const [title, setTitle] = useState(m.title);
  const [comment, setComment] = useState(m.comment);
  const [editComment, setEditComment] = useState(false);
  const stack = useRef<HTMLDivElement | null>(null);
  const lineWidth = useConfig().config.plots.lineWidth;
  const act = useAction();

  useEffect(() => {
    setTitle(m.title);
    setComment(m.comment);
    setEditComment(false);
  }, [m.id, m.title, m.comment]);

  const names = m.signals.map((s) => s.name);
  const units = m.signals.map((s) => s.unit);
  const groups = useMemo(() => groupByUnit(names, units), [m.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const styles = useTraceStyles(names, units);

  const commit = (patch: { title?: string; comment?: string }): void => {
    const next = { ...m, ...patch };
    onEdited(next);
    if (saved) void act.run(() => api().measUpdate(m.id, patch));
  };

  const period = m.t.length > 1 ? (m.t[m.t.length - 1]! - m.t[0]!) / (m.t.length - 1) : 0;
  const duration = m.t.length > 0 ? m.t[m.t.length - 1]! - m.t[0]! : 0;

  const exportText = (format: 'csv' | 'json'): void =>
    void act.run(() =>
      api().saveText(
        `${measurementFileStem(m)}.${format}`,
        format === 'csv' ? measurementToCsv(m) : `${serializeMeasurement(m)}\n`,
      ),
    );
  const exportPng = (): void =>
    void act.run(async () => {
      if (stack.current === null) return;
      const legend = names.map((n) => ({ name: n, color: styles.get(n)?.color ?? 'slot:1', dash: styles.get(n)?.dash === true }));
      const png = composeChartsPng(stack.current, m.title, `${fmtStamp(m.createdAt)} · ${m.t.length} pts · ${m.kind}`, legend);
      await api().measSavePng(`${measurementFileStem(m)}.png`, png);
    });

  useCommand('measurement:export-csv', () => exportText('csv'));
  useCommand('measurement:export-json', () => exportText('json'));
  useCommand('measurement:export-png', exportPng);

  return (
    <Panel
      className={className}
      title={m.kind === 'scope' ? 'Capture result' : 'Telemetry recording'}
      hint={
        <>
          {m.kind === 'scope'
            ? 'Time is relative to the trigger, marked by the dashed line: negative before, positive after. '
            : 'Time runs from the start of the recording. '}
          One vertical scale per unit; a setpoint is dashed, in its measurement’s colour. Drag to zoom
          into a time span, scroll to zoom around the pointer, shift-drag or middle-drag to pan,
          double-click to fit; the stacked charts follow each other. Click a swatch to change a
          colour. Title and comment are saved with the measurement.
        </>
      }
      right={
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-fg-3">
            {m.t.length} pts · {period.toFixed(3)} ms/pt · {duration.toFixed(2)} ms
          </span>
          {!saved && (
            <Button tone="accent" onClick={onKeep} title="Add this capture to the measurement history">
              Keep
            </Button>
          )}
          <Button onClick={() => setFit((n) => n + 1)} title="Fit the whole measurement back in the frame">
            Reset zoom
          </Button>
          <Button onClick={() => exportText('csv')}>CSV…</Button>
          <Button onClick={() => exportText('json')}>JSON…</Button>
          <Button onClick={exportPng}>PNG…</Button>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft px-3 py-1.5">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              if (title.trim() !== m.title) commit({ title: title.trim() });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            maxLength={200}
            title="Title — click to edit"
            className="min-w-0 flex-1 rounded-[3px] border border-transparent bg-transparent px-1 py-0.5 text-[13px] font-medium text-fg outline-none hover:border-line focus:border-fg-3 focus:bg-raise"
          />
          <span className="font-mono text-[11px] text-fg-3" title={m.createdAt}>
            {fmtStamp(m.createdAt)}
          </span>
          {m.device?.fwVersion !== undefined && (
            <span className="font-mono text-[11px] text-fg-3">fw {m.device.fwVersion}</span>
          )}
          <span className="flex items-center gap-2">
            {names.map((n) => (
              <span key={n} className="flex items-center gap-1 font-mono text-[11px] text-fg-2">
                <TraceSwatch name={n} style={styles.get(n)} />
                {n}
              </span>
            ))}
          </span>
          <Button onClick={() => setEditComment((v) => !v)} title="Add or edit a comment">
            {comment === '' ? 'Comment' : editComment ? 'Hide comment' : 'Comment ✎'}
          </Button>
        </div>
        {(editComment || (comment !== '' && !editComment)) && (
          <div className="shrink-0 border-b border-line-soft px-3 py-1.5">
            {editComment ? (
              <textarea
                autoFocus
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onBlur={() => {
                  if (comment !== m.comment) commit({ comment });
                }}
                maxLength={20000}
                placeholder="What was tested, what was seen…"
                className="h-16 w-full resize-y rounded-[3px] border border-line bg-raise px-2 py-1 text-[12px] text-fg outline-none focus:border-fg-3"
              />
            ) : (
              <p
                className="selectable cursor-text truncate text-[12px] text-fg-2"
                title={comment}
                onClick={() => setEditComment(true)}
              >
                {comment}
              </p>
            )}
          </div>
        )}
        <div ref={stack} className="min-h-0 flex-1">
          <ChartStack count={groups.length} className="flex h-full flex-col p-2">
            {(chartH) => (
              <>
                {groups.map(([unit, indices], g) => (
                  <TimeSeriesChart
                    key={`${m.id}~${unit}`}
                    t={m.t}
                    series={indices.map((i) => m.series[i] ?? [])}
                    labels={indices.map((i) => names[i] ?? '')}
                    colors={indices.map((i) => styles.get(names[i] ?? '')?.color ?? '')}
                    dashes={indices.map((i) => styles.get(names[i] ?? '')?.dash === true)}
                    lineWidth={lineWidth}
                    unit={unit === '' ? '(no unit)' : unit}
                    showXLabel={g === groups.length - 1}
                    xLabel={m.kind === 'scope' ? 'time from trigger (ms)' : 'time (ms)'}
                    markerX={m.markerX}
                    height={chartH}
                    interactive
                    syncKey="scope"
                    resetZoom={fit}
                  />
                ))}
              </>
            )}
          </ChartStack>
        </div>
        {act.error !== null && <p className="shrink-0 px-3 py-1 text-[11px] text-fault">{act.error}</p>}
      </div>
    </Panel>
  );
}
