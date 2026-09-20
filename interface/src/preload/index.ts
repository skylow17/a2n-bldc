/**
 * Pont entre le renderer et le processus principal.
 *
 * Surface volontairement étroite : le renderer ne peut faire que ce qui est listé ici. Il n'a
 * accès ni à Node, ni au port série, ni au système de fichiers.
 */

import { contextBridge, ipcRenderer } from 'electron';

import type { ScopeCapture } from '../shared/client.js';
import type { TelemFrame } from '../shared/messages.js';
import type { SignalDesc } from '../shared/protocol.js';
import type {
  ConnectTarget,
  DeviceSnapshot,
  FirmwareProgress,
  LogEntry,
  ScopeRequest,
  TelemetryState,
} from '../main/device/DeviceCore.js';
import type { SerialPortInfo } from '../node/serial.js';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Déballe la réponse du main : une erreur côté device devient une exception ici. */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

const api = {
  snapshot: () => call<DeviceSnapshot>('device:snapshot'),
  listPorts: () => call<SerialPortInfo[]>('device:listPorts'),
  connect: (target: ConnectTarget) => call<void>('device:connect', target),
  disconnect: () => call<void>('device:disconnect'),
  refresh: () => call<void>('device:refresh'),
  writeParam: (idOrName: number | string, value: number) =>
    call<number>('device:writeParam', idOrName, value),
  resetDefaults: () => call<void>('device:resetDefaults'),
  console: (line: string) => call<string>('device:console', line),
  readSignals: () => call<SignalDesc[]>('device:readSignals'),
  captureScope: (req: ScopeRequest) =>
    call<{ signals: SignalDesc[]; capture: ScopeCapture }>('device:captureScope', req),
  startTelemetry: (signalNames?: string[], rateHz?: number) =>
    call<TelemetryState>('device:startTelemetry', signalNames, rateHz),
  stopTelemetry: () => call<void>('device:stopTelemetry'),
  /** Rend le chemin retenu, ou `null` si l'utilisateur a annule. */
  saveText: (suggestedName: string, contents: string) =>
    call<string | null>('device:saveText', suggestedName, contents),
  setAiControl: (enabled: boolean) => call<void>('device:setAiControl', enabled),
  /** Acquitte la faute verrouillee. Faux si le firmware refuse : la cause tient encore. */
  clearFault: () => call<boolean>('device:clearFault'),

  /** Boîte de dialogue native. `null` si l'utilisateur annule. */
  pickFirmware: () => call<{ path: string; size: number } | null>('device:pickFirmware'),
  updateFirmware: (path: string, version: string) =>
    call<{ slot: number; committed: boolean }>('device:updateFirmware', path, version),

  onState: (listener: (s: DeviceSnapshot) => void): (() => void) => {
    const h = (_e: unknown, s: DeviceSnapshot): void => listener(s);
    ipcRenderer.on('device:state', h);
    return () => ipcRenderer.removeListener('device:state', h);
  },

  onLog: (listener: (e: LogEntry) => void): (() => void) => {
    const h = (_e: unknown, entry: LogEntry): void => listener(entry);
    ipcRenderer.on('device:log', h);
    return () => ipcRenderer.removeListener('device:log', h);
  },

  onFirmware: (listener: (p: FirmwareProgress) => void): (() => void) => {
    const h = (_e: unknown, p: FirmwareProgress): void => listener(p);
    ipcRenderer.on('device:firmware', h);
    return () => ipcRenderer.removeListener('device:firmware', h);
  },

  /** Trames de télémétrie, **par lots** : le main regroupe à ~30 Hz. */
  onTelemetry: (listener: (frames: TelemFrame[]) => void): (() => void) => {
    const h = (_e: unknown, frames: TelemFrame[]): void => listener(frames);
    ipcRenderer.on('device:telem', h);
    return () => ipcRenderer.removeListener('device:telem', h);
  },
};

export type DeviceApi = typeof api;

contextBridge.exposeInMainWorld('device', api);
