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
import { TimeSeriesChart, groupByUnit, seriesColor, type YMode } from './Chart.js';
import { ChartStack } from './ChartStack.js';
import { Button, Dot, Empty, Panel } from './ui.js';
import { api, useAction, useTelemetryBuffer } from '../useDevice.js';

/* Tableaux vides et stables : passés en props quand les données arrivent par `feed`.
 * Un littéral `[]` écrit sur place serait une identité neuve à chaque rendu. */
const EMPTY_NUMS: readonly number[] = [];
const EMPTY_SERIES: ReadonlyArray<readonly number[]> = [];

/** Fenêtres proposées. Cinq secondes est le réglage utile pour suivre un transitoire. */
const WINDOWS = [1, 2, 5, 15, 30] as const;

/** Cadences proposées. Le firmware impose 100 à 500 Hz — docs/protocol.md §6. */
const RATES = [100, 200, 500] as const;

/** Le protocole plafonne une souscription à 16 signaux. */
const MAX_SIGNALS = 16;

export function LiveTelemetry({ state }: { state: DeviceSnapshot }): ReactNode {
  const [signals, setSignals] = useState<SignalDesc[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [rateHz, setRateHz] = useState<number>(200);
  /* Presentation. Ces trois reglages ne changent que ce qu'on regarde, jamais ce qui est
   * mesure — ils ne touchent ni a la souscription ni au tampon. */
  const [windowS, setWindowS] = useState<number>(5);
  const [yMode, setYMode] = useState<YMode>('auto');
  const [split, setSplit] = useState(false);
  const { busy, error, run } = useAction();

  const connected = state.connection === 'connected';
  const streaming = state.telemetry !== null;
  const { buf, signalNames, units } = useTelemetryBuffer(state.telemetry);
  /* Le tampon est mute sur place et ne provoque aucun rendu : ce compteur lent existe
   * uniquement pour les quelques chiffres affiches en texte, a une cadence ou l'oeil suit. */
  const [, tickSlow] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tickSlow((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);

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
  const groups = useMemo(
    () => (split
      ? signalNames.map((n, i): [string, number[]] => [`${n}~${i}`, [i]])
      : groupByUnit(signalNames, units)),
    [signalNames, units, split],
  );

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

  const sel = 'rounded-[3px] border border-line bg-raise px-1.5 py-1 font-mono text-[11px] text-fg disabled:opacity-40';

  const header = (
    <div className="flex items-center gap-2">
      {/* Reglages de presentation. Ils ne changent que ce qu'on regarde : ni la
          souscription, ni la cadence, ni le contenu du tampon. */}
      {streaming && (
        <>
          <select
            value={windowS}
            onChange={(e) => setWindowS(Number(e.target.value))}
            title="Width of the time window shown"
            className={sel}
          >
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                {w} s
              </option>
            ))}
          </select>
          <select
            value={yMode}
            onChange={(e) => setYMode(e.target.value as YMode)}
            title="How the vertical scale behaves"
            className={sel}
          >
            <option value="auto">auto</option>
            <option value="zero">±0</option>
            <option value="locked">locked</option>
          </select>
          <label className="flex items-center gap-1 font-mono text-[11px] text-fg-3" title="One chart per signal instead of one per unit">
            <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
            split
          </label>
        </>
      )}
      {streaming && (
        <span className="font-mono text-[11px] text-fg-3">
          <Dot tone="ok" /> {state.telemetry?.rateHz} Hz
          {buf.current.dropped > 0 && (
            <span className="ml-2 text-fault">{buf.current.dropped} dropped</span>
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
    <Panel title="Live telemetry" right={header} className="h-full">
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
      ) : signalNames.length === 0 ? (
        <Empty title="Waiting for the first frames…" />
      ) : (
        <ChartStack count={groups.length} className="flex flex-col p-2">
          {(chartH) => (
            <>
          {groups.map(([groupKey, indices], g) => (
            <TimeSeriesChart
              key={groupKey}
              /* Les données n'arrivent pas par les props : le graphe lit le tampon
                 lui-même, une fois par trame d'affichage. Voir `feed` dans Chart.tsx. */
              t={EMPTY_NUMS}
              series={EMPTY_SERIES}
              feed={() => ({
                t: buf.current.t,
                series: indices.map((i) => buf.current.series[i] ?? EMPTY_NUMS),
              })}
              xWindow={windowS}
              yMode={yMode}
              labels={indices.map((i) => signalNames[i] ?? '')}
              colors={indices.map((i) => colorOf(signalNames[i] ?? ''))}
              unit={(split ? (units[indices[0] ?? 0] ?? '') : groupKey) === ''
                ? '(no unit)'
                : (split ? (units[indices[0] ?? 0] ?? '') : groupKey)}
              // Axe des temps commun : une seule étiquette, sous le dernier graphe.
              showXLabel={g === groups.length - 1}
              height={chartH}
            />
          ))}
          <p className="px-1 pb-1 text-[11px] leading-relaxed text-fg-3">
            {split
              ? 'One chart per signal: each has its own vertical scale, so shapes are comparable but levels are not.'
              : 'One vertical scale per unit: signals sharing a unit are comparable, the others are only juxtaposed.'}{' '}
            Showing the last {windowS} s of a {buf.current.t.length}-point buffer.
          </p>
            </>
          )}
        </ChartStack>
      )}
    </Panel>
  );
}
