/**
 * Accès au device depuis le renderer.
 *
 * L'état vit dans le processus principal ; ce module ne fait que le refléter. Il n'y a donc
 * aucune copie à resynchroniser, et rien ici ne peut diverger de ce que la carte a réellement
 * répondu — c'est le même principe que le dictionnaire de paramètres appliqué à l'UI.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { DeviceSnapshot, LogEntry } from '../main/device/DeviceCore.js';

// Le type vient du preload, qui est la definition du pont. Il etait recopie ici a la main,
// donc destine a diverger : une methode ajoutee au preload restait invisible du renderer,
// ou pire, une signature changee d'un cote seulement compilait quand meme. L'import est
// efface a la compilation — le renderer ne charge rien d'Electron.
import type { DeviceApi } from '../preload/index.js';

declare global {
  interface Window {
    device: DeviceApi;
  }
}

export const api = (): DeviceApi => window.device;

const EMPTY: DeviceSnapshot = {
  connection: 'disconnected',
  portDescription: null,
  info: null,
  dictIntegrity: null,
  params: [],
  aiControl: false,
  telemetry: null,
  safety: null,
  monitor: null,
  encoder: null,
  lastError: null,
};

export function useDeviceState(): DeviceSnapshot {
  const [state, setState] = useState<DeviceSnapshot>(EMPTY);

  useEffect(() => {
    let alive = true;
    void api()
      .snapshot()
      .then((s) => {
        if (alive) setState(s);
      });
    const off = api().onState(setState);
    return () => {
      alive = false;
      off();
    };
  }, []);

  return state;
}

/** Nombre maximal de lignes conservées dans la console. */
const LOG_CAP = 2000;

export function useDeviceLog(): { entries: LogEntry[]; clear: () => void } {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  useEffect(
    () =>
      api().onLog((e) => {
        // Plafond glissant : une session de réglage peut durer des heures, et une console
        // qui grossit sans fin finit par figer le rendu.
        setEntries((prev) => (prev.length >= LOG_CAP ? [...prev.slice(-LOG_CAP + 1), e] : [...prev, e]));
      }),
    [],
  );

  return { entries, clear: useCallback(() => setEntries([]), []) };
}

/**
 * Tampon glissant de télémétrie, rangé en colonnes.
 *
 * Colonnes et non lignes parce que c'est la forme qu'attend un traceur : un tableau de
 * temps, puis un tableau de valeurs par signal. Convertir à chaque rendu une liste de
 * trames en colonnes reviendrait à refaire le même travail trente fois par seconde.
 */
export interface TelemetryBuffer {
  /** Temps écoulé depuis le début du flux, en secondes. */
  t: number[];
  /** Une série par signal, dans l'ordre de `signalNames`. */
  series: number[][];
  signalNames: string[];
  units: string[];
  /** Trames perdues depuis le début du flux, d'après `sampleSeq`. */
  dropped: number;
}

const EMPTY_BUFFER: TelemetryBuffer = {
  t: [],
  series: [],
  signalNames: [],
  units: [],
  dropped: 0,
};

/**
 * Accumule le flux souscrit dans une fenêtre glissante.
 *
 * `telemetry` vient du snapshot : c'est lui qui dit combien de séries existent et dans
 * quel ordre. Le tampon se vide quand l'abonnement change ou s'arrête — garder les points
 * d'un abonnement précédent tracerait deux signaux différents sur la même courbe.
 */
export function useTelemetry(
  telemetry: DeviceSnapshot['telemetry'],
  capacity = 3000,
): TelemetryBuffer {
  const buf = useRef<TelemetryBuffer>(EMPTY_BUFFER);
  const elapsedUs = useRef(0);
  const lastTs = useRef<number | null>(null);
  const lastSeq = useRef<number | null>(null);
  const [, bump] = useState(0);

  const key = telemetry === null ? '' : telemetry.signalNames.join(',');

  useEffect(() => {
    buf.current = telemetry === null
      ? EMPTY_BUFFER
      : {
          t: [],
          series: telemetry.signalNames.map(() => []),
          signalNames: telemetry.signalNames,
          units: telemetry.units,
          dropped: 0,
        };
    elapsedUs.current = 0;
    lastTs.current = null;
    lastSeq.current = null;
    bump((n) => n + 1);
  }, [key, telemetry]);

  useEffect(
    () =>
      api().onTelemetry((frames) => {
        const b = buf.current;
        if (b.series.length === 0) return;

        for (const f of frames) {
          // `timestamp_us` est monotone **modulo 2^32** : il repasse à zéro toutes les
          // 71 minutes environ. Accumuler les écarts non signés plutôt que de soustraire
          // un instant de référence évite de voir le temps reculer en pleine session.
          const prev = lastTs.current;
          if (prev !== null) elapsedUs.current += (f.timestampUs - prev) >>> 0;
          lastTs.current = f.timestampUs;

          const prevSeq = lastSeq.current;
          if (prevSeq !== null) {
            b.dropped += (((f.sampleSeq - prevSeq) & 0xffff) - 1 + 0x10000) % 0x10000;
          }
          lastSeq.current = f.sampleSeq;

          b.t.push(elapsedUs.current / 1e6);
          for (let i = 0; i < b.series.length; i++) {
            b.series[i]!.push(f.values[i] ?? NaN);
          }
        }

        // Fenêtre glissante : une session de réglage dure des heures, et un tableau qui
        // grossit sans fin finit par faire tomber le tracé.
        const excess = b.t.length - capacity;
        if (excess > 0) {
          b.t.splice(0, excess);
          for (const s of b.series) s.splice(0, excess);
        }
        bump((n) => n + 1);
      }),
    [capacity],
  );

  // Copie de surface a chaque rendu : les tableaux sont partages, seule l'identite de
  // l'objet change. C'est elle qui dit au traceur qu'il y a du neuf — le tampon lui-meme
  // est mute sur place, donc une comparaison par reference ne verrait jamais rien bouger.
  return { ...buf.current };
}

/**
 * Enveloppe une action asynchrone : état d'attente et dernière erreur, sans que chaque
 * composant réinvente le même `try/catch`.
 */
export function useAction(): {
  busy: boolean;
  error: string | null;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  clearError: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  return { busy, error, run, clearError: useCallback(() => setError(null), []) };
}
