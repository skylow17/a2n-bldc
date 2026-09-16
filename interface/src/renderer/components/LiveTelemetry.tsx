/**
 * Télémétrie temps réel — le flux souscrit, tracé.
 *
 * Un graphe **par unité**, et non un graphe par signal ni un graphe pour tout. Deux
 * raisons, et la seconde est la vraie :
 *
 * - un graphe à deux échelles verticales laisse croire qu'on peut comparer des courbes qui
 *   n'ont pas la même unité ; c'est l'erreur de lecture la plus courante sur un graphe ;
 * - superposer `current.raw_ia_count` (~2 000) et `loop.load_pct` (~0,6) sur une seule
 *   échelle écrase la seconde sur l'axe. On ne verrait rien, et on croirait voir zéro.
 *
 * Les signaux qui partagent une unité se comparent ; les autres se juxtaposent.
 *
 * Libellés en anglais (AGENTS.md §5) ; commentaires en français.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import type { DeviceSnapshot } from '../../main/device/DeviceCore.js';
import type { SignalDesc } from '../../shared/protocol.js';
import { TimeSeriesChart, seriesColor } from './Chart.js';
import { Button, Dot, Empty, Panel } from './ui.js';
import { api, useAction, useTelemetry } from '../useDevice.js';

/** Cadences proposées. Le firmware impose 100 à 500 Hz — docs/protocol.md §6. */
const RATES = [100, 200, 500] as const;

/** Le protocole plafonne une souscription à 16 signaux. */
const MAX_SIGNALS = 16;

export function LiveTelemetry({ state }: { state: DeviceSnapshot }): ReactNode {
  const [signals, setSignals] = useState<SignalDesc[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [rateHz, setRateHz] = useState<number>(200);
  const { busy, error, run } = useAction();

  const connected = state.connection === 'connected';
  const streaming = state.telemetry !== null;
  const buffer = useTelemetry(state.telemetry);

  // Le dictionnaire de signaux vient du device, comme celui des paramètres : rien n'est
  // codé en dur ici, et un signal ajouté au firmware apparaît sans toucher à l'interface.
  useEffect(() => {
    if (!connected) {
      setSignals([]);
      setPicked([]);
      return;
    }
    let alive = true;
    void api()
      .readSignals()
      .then((list) => {
        if (!alive) return;
        setSignals(list);
        setPicked(list.slice(0, MAX_SIGNALS).map((s) => s.name));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [connected]);

  /* Regroupement par unité — une échelle verticale par graphe. L'indice porté ici est
   * celui de la série dans le tampon, pas celui du dictionnaire. */
  const groups = useMemo(() => {
    const byUnit = new Map<string, number[]>();
    buffer.signalNames.forEach((_name, i) => {
      const unit = buffer.units[i] ?? '';
      const bucket = byUnit.get(unit);
      if (bucket === undefined) byUnit.set(unit, [i]);
      else bucket.push(i);
    });
    return [...byUnit.entries()];
  }, [buffer.signalNames, buffer.units]);

  /* La couleur suit le signal, pas son rang dans un graphe : elle est tirée de la position
   * au dictionnaire. Décocher un signal ne doit pas repeindre les autres. */
  const colorOf = (name: string): string =>
    seriesColor(signals.findIndex((s) => s.name === name));

  const toggle = (name: string): void => {
    setPicked((prev) =>
      prev.includes(name)
        ? prev.filter((n) => n !== name)
        : prev.length >= MAX_SIGNALS
          ? prev
          : [...prev, name],
    );
  };

  const header = (
    <div className="flex items-center gap-2">
      {streaming && (
        <span className="font-mono text-[11px] text-fg-3">
          <Dot tone="ok" /> {state.telemetry?.rateHz} Hz
          {buffer.dropped > 0 && (
            <span className="ml-2 text-fault">{buffer.dropped} dropped</span>
          )}
        </span>
      )}
      {!streaming && (
        <select
          value={rateHz}
          disabled={!connected || busy}
          onChange={(e) => setRateHz(Number(e.target.value))}
          className="rounded-[3px] border border-line bg-raise px-1.5 py-1 font-mono text-[11px] text-fg disabled:opacity-40"
        >
          {RATES.map((r) => (
            <option key={r} value={r}>
              {r} Hz
            </option>
          ))}
        </select>
      )}
      <Button
        tone={streaming ? 'default' : 'accent'}
        disabled={!connected || busy || (!streaming && picked.length === 0)}
        onClick={() => {
          void run(async () => {
            if (streaming) await api().stopTelemetry();
            else await api().startTelemetry(picked, rateHz);
          });
        }}
      >
        {streaming ? 'Stop' : 'Start'}
      </Button>
    </div>
  );

  if (!connected) {
    return (
      <Panel title="Live telemetry">
        <Empty title="No device connected" />
      </Panel>
    );
  }

  return (
    <Panel title="Live telemetry" right={header}>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-line-soft px-3 py-2">
        {signals.map((s) => {
          const on = picked.includes(s.name);
          return (
            <label
              key={s.id}
              className={`flex cursor-pointer items-center gap-1.5 text-[11px] ${
                on ? 'text-fg-2' : 'text-fg-3'
              } ${streaming ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={streaming}
                onChange={() => toggle(s.name)}
                className="h-3 w-3 accent-current"
              />
              {/* La pastille redouble le nom : l'identité d'une courbe n'est jamais portée
                  par la seule couleur. */}
              <span
                className="inline-block h-[3px] w-2.5 rounded-[2px]"
                style={{ background: on ? colorOf(s.name) : 'transparent' }}
                aria-hidden="true"
              />
              <span className="font-mono">{s.name}</span>
            </label>
          );
        })}
      </div>

      {error !== null && (
        <p className="border-b border-line-soft px-3 py-2 text-[11px] text-fault">{error}</p>
      )}

      {!streaming ? (
        <Empty
          title="Telemetry is off"
          hint={
            picked.length === 0
              ? 'Pick at least one signal, then press Start.'
              : `Press Start to subscribe to ${picked.length} signal(s).`
          }
        />
      ) : buffer.t.length === 0 ? (
        <Empty title="Waiting for the first frames…" />
      ) : (
        <div className="flex flex-col p-2">
          {groups.map(([unit, indices], g) => (
            <TimeSeriesChart
              key={unit}
              t={buffer.t}
              series={indices.map((i) => buffer.series[i] ?? [])}
              labels={indices.map((i) => buffer.signalNames[i] ?? '')}
              colors={indices.map((i) => colorOf(buffer.signalNames[i] ?? ''))}
              unit={unit === '' ? '(no unit)' : unit}
              // Axe des temps commun : une seule étiquette, sous le dernier graphe.
              showXLabel={g === groups.length - 1}
              height={groups.length > 2 ? 120 : groups.length > 1 ? 170 : 240}
            />
          ))}
          <p className="px-1 pb-1 text-[11px] leading-relaxed text-fg-3">
            One vertical scale per unit: signals sharing a unit are comparable, the others
            are only juxtaposed. The window keeps the last {buffer.t.length} points.
          </p>
        </div>
      )}
    </Panel>
  );
}
