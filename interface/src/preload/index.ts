/**
 * Pont entre le renderer et le processus principal.
 *
 * Surface volontairement étroite : le renderer ne peut faire que ce qui est listé ici. Il n'a
 * accès ni à Node, ni au port série, ni au système de fichiers.
 */

import { contextBridge, ipcRenderer } from 'electron';

import type { ConnectTarget, DeviceSnapshot, LogEntry } from '../main/device/DeviceCore.js';
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
  setAiControl: (enabled: boolean) => call<void>('device:setAiControl', enabled),

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
};

export type DeviceApi = typeof api;

contextBridge.exposeInMainWorld('device', api);
