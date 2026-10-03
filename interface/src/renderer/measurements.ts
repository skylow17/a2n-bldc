/**
 * Mesures côté renderer : liste partagée, construction d'une mesure à partir d'une capture,
 * enregistrement de la télémétrie.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { DeviceSnapshot } from '../main/device/DeviceCore.js';
import { EMPTY_TREE, defaultTitle, type MeasTree, type Measurement, type MeasurementMeta } from '../shared/measurement.js';
import { formatDictHash } from '../shared/recipe.js';
import { api } from './useDevice.js';

/** Liste des mesures et arbre, tenus à jour par la diffusion du processus principal. */
export function useMeasurementList(): { metas: MeasurementMeta[]; tree: MeasTree } {
  const [list, setList] = useState<{ metas: MeasurementMeta[]; tree: MeasTree }>({ metas: [], tree: EMPTY_TREE });
  useEffect(() => {
    let alive = true;
    void api()
      .measList()
      .then((l) => {
        if (alive) setList(l);
      })
      .catch(() => undefined);
    const off = api().onMeasurements(setList);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return list;
}

/**
 * Fige une mesure avec son contexte : firmware, dictionnaire, port, et la valeur de chaque
 * paramètre au moment de la mesure — de quoi savoir plus tard avec quels réglages elle a
 * été prise.
 */
export function buildMeasurement(args: {
  kind: Measurement['kind'];
  state: DeviceSnapshot;
  signals: Array<{ name: string; unit: string }>;
  t: readonly number[];
  series: ReadonlyArray<readonly number[]>;
  markerX: number | null;
  config: Record<string, unknown>;
  at?: Date;
}): Measurement {
  const at = args.at ?? new Date();
  const info = args.state.info;
  const params: Record<string, number> = {};
  for (const p of args.state.params) if (p.value !== null && Number.isFinite(p.value)) params[p.name] = p.value;
  return {
    schema: 1,
    id: crypto.randomUUID(),
    kind: args.kind,
    createdAt: at.toISOString(),
    title: defaultTitle(args.kind, args.signals.map((s) => s.name), at),
    comment: '',
    tags: [],
    device:
      info === null
        ? null
        : {
            product: info.product,
            fwVersion: info.fwVersion,
            protocol: `${info.protocolMajor}.${info.protocolMinor}`,
            dictHash: formatDictHash(info.paramDictHash),
            ...(args.state.portDescription !== null ? { port: args.state.portDescription } : {}),
          },
    params,
    config: args.config,
    signals: args.signals,
    t: [...args.t],
    series: args.series.map((s) => [...s]),
    markerX: args.markerX,
  };
}

export interface Recording {
  t: number[];
  series: number[][];
}

/**
 * Enregistre le flux de télémétrie, de Record à Stop, **sans fenêtre glissante** : le tampon
 * d'affichage ne garde que ce qui tient à l'écran, l'enregistrement garde tout, jusqu'au
 * plafond `maxS` où il s'arrête de lui-même.
 *
 * Même règle que le tampon d'affichage : aucun rendu React par trame. Seule la durée
 * affichée change, une fois par seconde.
 */
export function useTelemetryRecorder(
  signalCount: number,
  maxS: number,
  onDone: (rec: Recording) => void,
): { recording: boolean; elapsedS: number; start: () => void; stop: () => void } {
  const [recording, setRecording] = useState(false);
  const [elapsedS, setElapsedS] = useState(0);
  const rec = useRef<Recording | null>(null);
  const elapsedUs = useRef(0);
  const lastTs = useRef<number | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  const stop = useCallback(() => {
    const r = rec.current;
    rec.current = null;
    setRecording(false);
    if (r !== null && r.t.length > 0) done.current(r);
  }, []);

  const start = useCallback(() => {
    rec.current = { t: [], series: Array.from({ length: signalCount }, () => []) };
    elapsedUs.current = 0;
    lastTs.current = null;
    setElapsedS(0);
    setRecording(true);
  }, [signalCount]);

  useEffect(() => {
    if (!recording) return undefined;
    const off = api().onTelemetry((frames) => {
      const r = rec.current;
      if (r === null) return;
      for (const f of frames) {
        // Même accumulation que le tampon d'affichage : écarts non signés, le compteur
        // matériel repasse par zéro toutes les 71 minutes.
        if (lastTs.current !== null) elapsedUs.current += (f.timestampUs - lastTs.current) >>> 0;
        lastTs.current = f.timestampUs;
        r.t.push(elapsedUs.current / 1000);
        for (let i = 0; i < r.series.length; i++) r.series[i]!.push(f.values[i] ?? Number.NaN);
      }
      if (elapsedUs.current / 1e6 >= maxS) stop();
    });
    const tick = setInterval(() => setElapsedS(elapsedUs.current / 1e6), 500);
    return () => {
      off();
      clearInterval(tick);
    };
  }, [recording, maxS, stop]);

  return { recording, elapsedS, start, stop };
}
