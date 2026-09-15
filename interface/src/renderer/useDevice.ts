/**
 * Accès au device depuis le renderer.
 *
 * L'état vit dans le processus principal ; ce module ne fait que le refléter. Il n'y a donc
 * aucune copie à resynchroniser, et rien ici ne peut diverger de ce que la carte a réellement
 * répondu — c'est le même principe que le dictionnaire de paramètres appliqué à l'UI.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { DeviceSnapshot, LogEntry } from '../main/device/DeviceCore.js';
import type { SerialPortInfo } from '../node/serial.js';

interface DeviceApi {
  snapshot(): Promise<DeviceSnapshot>;
  listPorts(): Promise<SerialPortInfo[]>;
  connect(target: { kind: 'serial' | 'simulator'; path?: string }): Promise<void>;
  disconnect(): Promise<void>;
  refresh(): Promise<void>;
  writeParam(idOrName: number | string, value: number): Promise<number>;
  resetDefaults(): Promise<void>;
  console(line: string): Promise<string>;
  setAiControl(enabled: boolean): Promise<void>;
  onState(listener: (s: DeviceSnapshot) => void): () => void;
  onLog(listener: (e: LogEntry) => void): () => void;
}

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
