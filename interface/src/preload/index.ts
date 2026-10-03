/**
 * Pont entre le renderer et le processus principal.
 *
 * Surface volontairement étroite : le renderer ne peut faire que ce qui est listé ici. Il n'a
 * accès ni à Node, ni au port série, ni au système de fichiers.
 */

import { contextBridge, ipcRenderer, webFrame } from 'electron';

import type { AppConfig, ConfigPatch } from '../shared/config.js';
import type { McpStatus, McpToolInfo } from '../main/mcp/controller.js';
import type { MeasurementPatch } from '../main/measurements/store.js';
import type { MeasTree, Measurement, MeasurementMeta } from '../shared/measurement.js';

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
  saveNvm: () => call<{ saved: number; seq: number }>('device:saveNvm'),
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

  /** Recette choisie dans une boîte de dialogue native, texte brut ; `null` si annulé. */
  openRecipe: () => call<{ path: string; text: string } | null>('device:openRecipe'),

  /** Vue Control dans sa propre fenêtre : l'ouvre, ou lui rend le focus. */
  detachControl: () => call<void>('window:detachControl'),
  /** Ferme la fenêtre détachée ; la vue revient dans la fenêtre principale. */
  dockControl: () => call<void>('window:dockControl'),
  isControlDetached: () => call<boolean>('window:isControlDetached'),
  onControlDetached: (listener: (detached: boolean) => void): (() => void) => {
    const h = (_e: unknown, d: boolean): void => listener(d);
    ipcRenderer.on('window:controlDetached', h);
    return () => ipcRenderer.removeListener('window:controlDetached', h);
  },

  /** Boîte de dialogue native. `null` si l'utilisateur annule. */
  pickFirmware: () => call<{ path: string; size: number } | null>('device:pickFirmware'),
  updateFirmware: (path: string, version: string) =>
    call<{ slot: number; committed: boolean }>('device:updateFirmware', path, version),

  /* --- configuration --------------------------------------------------- */
  getConfig: () => call<AppConfig>('config:get'),
  setConfig: (patch: ConfigPatch) => call<{ config: AppConfig; warnings: string[] }>('config:set', patch),
  resetConfig: () => call<AppConfig>('config:reset'),
  /** Rend le chemin écrit, ou `null` si annulé. */
  exportConfig: () => call<string | null>('config:export'),
  importConfig: () => call<{ path: string; warnings: string[] } | null>('config:import'),
  dataDir: () => call<string>('config:dataDir'),
  chooseDataDir: () => call<string | null>('config:chooseDataDir'),
  openDataDir: () => call<void>('config:openDataDir'),
  onConfig: (listener: (c: AppConfig) => void): (() => void) => {
    const h = (_e: unknown, c: AppConfig): void => listener(c);
    ipcRenderer.on('config:changed', h);
    return () => ipcRenderer.removeListener('config:changed', h);
  },

  /* --- mesures ------------------------------------------------------------ */
  measList: () => call<{ metas: MeasurementMeta[]; tree: MeasTree }>('meas:list'),
  measGet: (id: string) => call<Measurement>('meas:get', id),
  measSave: (m: Measurement, folder: string | null = null) => call<MeasurementMeta>('meas:save', m, folder),
  measUpdate: (id: string, patch: MeasurementPatch) => call<MeasurementMeta>('meas:update', id, patch),
  measDelete: (ids: string[]) => call<void>('meas:delete', ids),
  measSetTree: (tree: MeasTree) => call<MeasTree>('meas:setTree', tree),
  /** Rend les chemins écrits, ou `null` si annulé. */
  measExport: (ids: string[], format: 'csv' | 'json') => call<string[] | null>('meas:export', ids, format),
  measSavePng: (name: string, base64: string) => call<string | null>('meas:savePng', name, base64),
  measImport: (folder: string | null) =>
    call<{ imported: string[]; errors: string[] } | null>('meas:import', folder),
  onMeasurements: (listener: (l: { metas: MeasurementMeta[]; tree: MeasTree }) => void): (() => void) => {
    const h = (_e: unknown, l: { metas: MeasurementMeta[]; tree: MeasTree }): void => listener(l);
    ipcRenderer.on('meas:changed', h);
    return () => ipcRenderer.removeListener('meas:changed', h);
  },

  /* --- serveur MCP ------------------------------------------------------- */
  mcpStatus: () => call<McpStatus>('mcp:status'),
  mcpTools: () => call<McpToolInfo[]>('mcp:tools'),
  mcpApply: (enabled: boolean, port: number) => call<McpStatus>('mcp:apply', enabled, port),
  onMcpStatus: (listener: (s: McpStatus) => void): (() => void) => {
    const h = (_e: unknown, s: McpStatus): void => listener(s);
    ipcRenderer.on('mcp:status', h);
    return () => ipcRenderer.removeListener('mcp:status', h);
  },

  /* --- application ------------------------------------------------------ */
  appInfo: () =>
    call<{ appVersion: string; electron: string; chrome: string; node: string; platform: string; dataDir: string }>(
      'app:info',
    ),
  openLink: (key: 'repo' | 'protocol' | 'status' | 'interface') => call<void>('app:openLink', key),
  quit: () => call<void>('app:quit'),
  /** Zoom de la fenêtre courante. Local à la fenêtre : rien ne traverse l'IPC. */
  setZoom: (factor: number) => webFrame.setZoomFactor(factor),

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
