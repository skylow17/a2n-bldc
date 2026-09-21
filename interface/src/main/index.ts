/**
 * Processus principal Electron.
 *
 * Il ne fait que deux choses : ouvrir la fenêtre, et exposer le `DeviceCore` au renderer par
 * IPC. Toute la logique est dans le DeviceCore, pour que la CLI et le serveur MCP puissent
 * s'en servir sans Electron.
 */

import { join } from 'node:path';

import { readFile, writeFile } from 'node:fs/promises';

import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';

import type { TelemFrame } from '../shared/messages.js';
import {
  DeviceCore,
  type ConnectTarget,
  type FirmwareProgress,
  type LogSource,
  type ScopeRequest,
} from './device/DeviceCore.js';
import { A2N_MCP_DEFAULT_PORT, startA2nMcpHttpServer } from './mcp/http.js';
import { isIpcChannel, validateIpc } from './ipcSchema.js';

const core = new DeviceCore();
let mainWindow: BrowserWindow | null = null;

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

core.onChange.on((s) => broadcast('device:state', s));
core.onLog.on((e) => broadcast('device:log', e));
core.onFirmware.on((p: FirmwareProgress) => broadcast('device:firmware', p));

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

/**
 * Emballe un handler : arguments validés, erreur exploitable plutôt qu'un rejet nu.
 *
 * Le canal doit figurer dans `IPC_SCHEMA`, et l'absence est une erreur **au démarrage**, pas
 * une permissivité silencieuse. C'est ce qui fait de la validation une barrière plutôt
 * qu'une convention : ajouter un canal sans décider de ce qu'il accepte casse l'application
 * tout de suite, au lieu de laisser passer n'importe quoi jusqu'à la carte.
 */
function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  if (!isIpcChannel(channel)) {
    throw new Error(`IPC channel ${channel} has no argument schema — add one in ipcSchema.ts`);
  }
  const ch = channel;
  ipcMain.handle(channel, async (_event, ...args) => {
    const checked = validateIpc(ch, args);
    if (!checked.ok) {
      // Journalisé : une commande refusée à la frontière doit se voir, sinon on cherche
      // le défaut du côté de la carte.
      core.log('error', 'gui', checked.error);
      return { ok: false as const, error: checked.error };
    }
    try {
      return { ok: true as const, value: await fn(...(checked.value as never[])) };
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
/** Dernière image désignée par l'utilisateur, et la seule que `updateFirmware` accepte. */
let pickedFirmware: string | null = null;

/**
 * Choisit une image de firmware, puis la programme.
 *
 * Le fichier est lu **ici** et jamais dans le renderer, qui n'a accès ni à Node ni au
 * système de fichiers. L'utilisateur le désigne dans une boîte de dialogue native : rien ne
 * peut être programmé sans qu'il ait vu et nommé le fichier concerné.
 *
 * Rend `null` s'il annule.
 */
handle('device:pickFirmware', async () => {
  const win = mainWindow;
  const options = {
    title: 'Choose a firmware image',
    filters: [{ name: 'Firmware image', extensions: ['bin'] }],
    properties: ['openFile' as const],
  };
  const result =
    win === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(win, options);
  const chosen = result.filePaths[0];
  if (result.canceled || chosen === undefined) return null;
  const bytes = await readFile(chosen);
  pickedFirmware = chosen;
  return { path: chosen, size: bytes.byteLength };
});

handle('device:updateFirmware', async (path: string, version: string) => {
  // Le schéma dit que c'est une chaîne ; il ne peut pas dire que c'est *le bon fichier*.
  // Seul un chemin sorti de la boîte de dialogue native est accepté, parce que c'est le
  // seul dont l'utilisateur ait vu le nom. Sans ce verrou, le renderer désignerait
  // n'importe quel fichier du disque et le processus principal le programmerait.
  if (path !== pickedFirmware) {
    throw new Error('firmware image must be the one chosen in the dialog');
  }
  // Relu au moment de programmer plutôt que gardé en mémoire depuis la sélection : entre
  // les deux, l'utilisateur a pu recompiler. Programmer une image périmée en affichant le
  // nom de la nouvelle est le genre de confusion qui coûte une demi-journée.
  const bytes = await readFile(path);
  return core.updateFirmware(new Uint8Array(bytes), version, 'gui');
});

handle('device:setAiControl', (enabled: boolean) => {
  core.setAiControl(enabled);
});

handle('device:clearFault', () => core.clearFault('gui'));

/* ------------------------------------------------------------------ cycle de vie */

void app.whenReady().then(async () => {
  createWindow();

  // Le serveur MCP vit ici, dans le processus de la fenêtre, et sert le même `DeviceCore` :
  // c'est la fenêtre qui porte le seul chemin vers « Enable AI control », donc un agent ne
  // peut être autorisé à écrire que si un humain a l'interface sous les yeux. Local
  // seulement ; le port se lit dans la console commune, source `mcp`.
  const port = Number(process.env['A2N_MCP_PORT'] ?? A2N_MCP_DEFAULT_PORT);
  try {
    await startA2nMcpHttpServer(core, { port });
  } catch (error: unknown) {
    core.log('error', 'mcp', `MCP server not started: ${error instanceof Error ? error.message : String(error)}`);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
