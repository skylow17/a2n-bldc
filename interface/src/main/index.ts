/**
 * Processus principal Electron.
 *
 * Il ne fait que deux choses : ouvrir la fenêtre, et exposer le `DeviceCore` au renderer par
 * IPC. Toute la logique est dans le DeviceCore, pour que la CLI et le serveur MCP puissent
 * s'en servir sans Electron.
 */

import { join } from 'node:path';

import { writeFile } from 'node:fs/promises';

import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { TelemFrame } from '../shared/messages.js';
import {
  DeviceCore,
  type ConnectTarget,
  type LogSource,
  type ScopeRequest,
} from './device/DeviceCore.js';
import { startA2nMcpServer } from './mcp/server.js';

const core = new DeviceCore();
const mcpMode = process.argv.includes('--mcp');
let mainWindow: BrowserWindow | null = null;

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

core.onChange.on((s) => broadcast('device:state', s));
core.onLog.on((e) => broadcast('device:log', e));

/**
 * La télémétrie arrive jusqu'à 500 fois par seconde. Une trame par message IPC ferait
 * autant de traversées de processus et autant de rendus React, pour un tracé qui n'a
 * besoin que de suivre l'œil. On regroupe donc à ~30 Hz.
 *
 * Le regroupement vit ici et non dans le `DeviceCore` : c'est une contrainte de transport
 * vers le renderer, pas une propriété du device. La CLI et le serveur MCP, qui sont dans
 * le même processus, reçoivent les trames une par une.
 */
const TELEM_BATCH_MS = 33;
let telemBatch: TelemFrame[] = [];
let telemTimer: ReturnType<typeof setTimeout> | null = null;

core.onTelemetry.on((frame) => {
  telemBatch.push(frame);
  if (telemTimer !== null) return;
  telemTimer = setTimeout(() => {
    telemTimer = null;
    const batch = telemBatch;
    telemBatch = [];
    if (batch.length > 0) broadcast('device:telem', batch);
  }, TELEM_BATCH_MS);
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      // Le renderer n'a accès ni à Node ni au port série : tout passe par le pont typé
      // du preload. C'est la même règle que côté DeviceCore, appliquée au périmètre
      // du navigateur.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());

  // Un lien externe s'ouvre dans le navigateur, jamais dans la fenêtre de l'application.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env['ELECTRON_RENDERER_URL'] !== undefined) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

/* ------------------------------------------------------------------ IPC */

/** Emballe un handler pour que le renderer reçoive une erreur exploitable, jamais un rejet nu. */
function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true as const, value: await fn(...(args as never[])) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

handle('device:snapshot', () => core.snapshot());
handle('device:listPorts', () => core.listPorts());
handle('device:connect', (target: ConnectTarget) => core.connect(target));
handle('device:disconnect', () => core.disconnect());
handle('device:refresh', () => core.refreshValues());
handle('device:writeParam', (idOrName: number | string, value: number, source?: LogSource) =>
  core.writeParam(idOrName, value, source ?? 'gui'),
);
handle('device:resetDefaults', () => core.resetDefaults());
handle('device:console', (line: string) => core.sendConsole(line));

// Signaux et scope : le renderer y avait droit depuis le debut, mais aucun canal ne les
// portait — seuls la CLI et le serveur MCP pouvaient les atteindre. Un outil MCP capable
// de faire ce que l'UI ne peut pas est un trou dans l'UI, pas une fonctionnalite du MCP.
handle('device:readSignals', () => core.readSignals());
handle('device:captureScope', (req: ScopeRequest) => core.captureScope(req));
handle('device:startTelemetry', (signalNames: string[] | undefined, rateHz: number | undefined) =>
  core.startTelemetry(signalNames, rateHz),
);
handle('device:stopTelemetry', () => core.stopTelemetry());

/**
 * Enregistre un texte sur disque, apres confirmation de l'utilisateur.
 *
 * Le renderer n'a acces ni a Node ni au systeme de fichiers : il fournit un contenu et un
 * nom suggere, l'utilisateur choisit l'emplacement. Rien ne s'ecrit sans cette boite de
 * dialogue, donc rien ne s'ecrit sans qu'il l'ait vu.
 */
handle('device:saveText', async (suggestedName: string, contents: string) => {
  const win = mainWindow;
  const result =
    win === null
      ? await dialog.showSaveDialog({ defaultPath: suggestedName })
      : await dialog.showSaveDialog(win, { defaultPath: suggestedName });
  if (result.canceled || result.filePath === undefined) return null;
  await writeFile(result.filePath, contents, 'utf8');
  core.log('info', 'gui', `saved ${result.filePath}`);
  return result.filePath;
});
handle('device:setAiControl', (enabled: boolean) => {
  core.setAiControl(enabled);
});

/* ------------------------------------------------------------------ cycle de vie */

void app.whenReady().then(() => {
  if (mcpMode) {
    void startA2nMcpServer(core, new StdioServerTransport()).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      app.exit(1);
    });
  } else {
    createWindow();
  }

  app.on('activate', () => {
    if (!mcpMode && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Fermer le port proprement : un port laissé ouvert reste verrouillé sous Windows et
  // empêche la prochaine connexion.
  void core.disconnect(true);
});
