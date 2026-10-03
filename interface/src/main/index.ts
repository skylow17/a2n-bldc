/**
 * Processus principal Electron.
 *
 * Il ne fait que deux choses : ouvrir les fenêtres, et exposer le `DeviceCore` au renderer par
 * IPC. Toute la logique est dans le DeviceCore, pour que la CLI et le serveur MCP puissent
 * s'en servir sans Electron.
 *
 * Deux fenêtres au plus : la principale, et la vue Control **détachée**, pour piloter d'une
 * main pendant que le Scope ou le Dashboard enregistrent dans l'autre. Elles chargent le même
 * renderer et reflètent le même `DeviceCore` : il n'y a qu'un état, qu'une connexion et
 * qu'une file de console, donc rien à synchroniser entre elles.
 */

import { join } from 'node:path';

import { readFile, writeFile } from 'node:fs/promises';

import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';

import type { ConfigPatch } from '../shared/config.js';
import { ConfigStore } from './config/store.js';

import type { TelemFrame } from '../shared/messages.js';
import {
  DeviceCore,
  type ConnectTarget,
  type FirmwareProgress,
  type LogSource,
  type ScopeRequest,
} from './device/DeviceCore.js';
import { McpController } from './mcp/controller.js';
import { isIpcChannel, validateIpc } from './ipcSchema.js';

const core = new DeviceCore();

/** Dossier de données et `config.json` — voir `config/store.ts`. Chargé avant la fenêtre. */
const config = new ConfigStore(
  join(app.getPath('userData'), 'location.json'),
  join(app.getPath('documents'), 'A2N BLDC'),
  (level, text) => core.log(level, 'gui', text),
);
let mainWindow: BrowserWindow | null = null;
let controlWindow: BrowserWindow | null = null;

/** Tout événement du device va à **toutes** les fenêtres ouvertes. */
function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

const controlDetached = (): boolean => controlWindow !== null && !controlWindow.isDestroyed();

core.onChange.on((s) => broadcast('device:state', s));
config.onChange((c) => broadcast('config:changed', c));

/**
 * Serveur MCP. Il vit ici, dans le processus de la fenêtre, et sert le même `DeviceCore` :
 * c'est la fenêtre qui porte le seul chemin vers « Enable AI control », donc un agent ne
 * peut être autorisé à écrire que si un humain a l'interface sous les yeux. Local
 * seulement. Marche, arrêt et port viennent de la config (`mcp`) ; `A2N_MCP_PORT`, s'il est
 * posé, impose le port.
 */
const envPort = process.env['A2N_MCP_PORT'] === undefined ? null : Number(process.env['A2N_MCP_PORT']);
const mcp = new McpController(core, envPort !== null && Number.isFinite(envPort) ? envPort : null);
mcp.onChange((s) => broadcast('mcp:status', s));
config.onChange((c) => {
  const s = mcp.current;
  if (s.enabled !== c.mcp.enabled || (!s.portFromEnv && s.port !== c.mcp.port)) {
    void mcp.apply(c.mcp.enabled, c.mcp.port);
  }
});
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

function newWindow(size: { width: number; height: number; minWidth: number; minHeight: number }, title?: string): BrowserWindow {
  return new BrowserWindow({
    ...size,
    ...(title !== undefined ? { title } : {}),
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
}

/** Charge le renderer ; `hash` choisit ce qu'il affiche (`control` : la vue détachée). */
function loadRenderer(win: BrowserWindow, hash?: string): void {
  win.on('ready-to-show', () => win.show());

  // Un lien externe s'ouvre dans le navigateur, jamais dans une fenêtre de l'application.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const dev = process.env['ELECTRON_RENDERER_URL'];
  if (dev !== undefined) {
    void win.loadURL(hash === undefined ? dev : `${dev}#${hash}`);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), hash === undefined ? {} : { hash });
  }
}

function createWindow(): void {
  mainWindow = newWindow({ width: 1440, height: 900, minWidth: 960, minHeight: 600 });
  loadRenderer(mainWindow);

  // La fenêtre principale porte l'application : la fermer ferme aussi la vue détachée,
  // plutôt que de laisser une fenêtre de pilotage orpheline — et le serveur MCP avec elle.
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (controlDetached()) controlWindow!.close();
  });
}

/**
 * Ouvre la vue Control dans sa propre fenêtre, ou lui rend le focus si elle l'est déjà.
 *
 * Elle porte son propre STOP et son propre interrupteur de pilotage par agent : la règle
 * « visibles en permanence » (`AGENTS.md` §4.6) vaut pour chaque fenêtre, pas pour
 * l'application prise en bloc.
 */
function openControlWindow(): void {
  if (controlDetached()) {
    if (controlWindow!.isMinimized()) controlWindow!.restore();
    controlWindow!.focus();
    return;
  }
  const win = newWindow({ width: 760, height: 940, minWidth: 520, minHeight: 480 }, 'A2N BLDC — Control');
  controlWindow = win;
  win.on('closed', () => {
    controlWindow = null;
    broadcast('window:controlDetached', false);
  });
  loadRenderer(win, 'control');
  broadcast('window:controlDetached', true);
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
handle('device:saveNvm', () => core.saveNvm());
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
  // La fenêtre qui a le focus : un enregistrement demandé depuis la vue détachée s'ouvre
  // devant elle, pas derrière.
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
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

handle('window:detachControl', () => openControlWindow());
handle('window:dockControl', () => {
  if (controlDetached()) controlWindow!.close();
});
handle('window:isControlDetached', () => controlDetached());

/**
 * Ouvre une recette. Comme pour une image de firmware, le fichier est désigné par
 * l'utilisateur dans une boîte de dialogue native, et lu ici : le renderer n'a pas accès au
 * disque. Rend le texte brut, que le renderer valide (`shared/recipe.ts`) — un fichier n'est
 * jamais cru sur sa forme. `null` si l'utilisateur annule.
 */
const RECIPE_MAX_BYTES = 1024 * 1024;
handle('device:openRecipe', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  const options = {
    title: 'Open a recipe',
    filters: [
      { name: 'A2N recipe', extensions: ['a2nrcp'] },
      { name: 'JSON', extensions: ['json'] },
    ],
    properties: ['openFile' as const],
  };
  const result = win === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options);
  const chosen = result.filePaths[0];
  if (result.canceled || chosen === undefined) return null;
  const bytes = await readFile(chosen);
  if (bytes.byteLength > RECIPE_MAX_BYTES) throw new Error(`${chosen}: too large for a recipe`);
  core.log('info', 'gui', `opened recipe ${chosen}`);
  return { path: chosen, text: bytes.toString('utf8') };
});

/* ------------------------------------------------------------------ configuration */

/** Fenêtre devant laquelle ouvrir une boîte de dialogue : celle qui a le focus. */
const dialogParent = (): BrowserWindow | null => BrowserWindow.getFocusedWindow() ?? mainWindow;

handle('config:get', () => config.current);
handle('config:dataDir', () => config.dataDir);
handle('config:set', (patch: ConfigPatch) => config.set(patch));
handle('config:reset', () => config.reset());

handle('config:export', async () => {
  const win = dialogParent();
  const options = {
    title: 'Export settings',
    defaultPath: 'a2n-bldc-settings.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const r = win === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(win, options);
  if (r.canceled || r.filePath === undefined) return null;
  await writeFile(r.filePath, config.exportText(), 'utf8');
  core.log('info', 'gui', `settings exported to ${r.filePath}`);
  return r.filePath;
});

handle('config:import', async () => {
  const win = dialogParent();
  const options = {
    title: 'Import settings',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile' as const],
  };
  const r = win === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options);
  const chosen = r.filePaths[0];
  if (r.canceled || chosen === undefined) return null;
  const text = await readFile(chosen, 'utf8');
  const { warnings } = await config.importText(text);
  core.log(warnings.length === 0 ? 'info' : 'warn', 'gui',
    `settings imported from ${chosen}${warnings.length === 0 ? '' : ` (${warnings.length} warning(s))`}`);
  for (const w of warnings) core.log('warn', 'gui', `settings: ${w}`);
  return { path: chosen, warnings };
});

handle('config:chooseDataDir', async () => {
  const win = dialogParent();
  const options = {
    title: 'Choose the data folder',
    defaultPath: config.dataDir,
    properties: ['openDirectory' as const, 'createDirectory' as const],
  };
  const r = win === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options);
  const chosen = r.filePaths[0];
  if (r.canceled || chosen === undefined) return null;
  await config.moveTo(chosen);
  core.log('info', 'gui', `data folder is now ${chosen}`);
  return chosen;
});

handle('config:openDataDir', async () => {
  const err = await shell.openPath(config.dataDir);
  if (err !== '') throw new Error(err);
});

/* ------------------------------------------------------------------ application */

handle('app:info', () => ({
  appVersion: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: `${process.platform} ${process.arch}`,
  dataDir: config.dataDir,
}));

/** Liens d'aide : une table fermée, pour que le renderer ne puisse pas ouvrir n'importe quoi. */
const HELP_LINKS = {
  repo: 'https://github.com/skylow17/a2n-bldc',
  protocol: 'https://github.com/skylow17/a2n-bldc/blob/main/docs/protocol.md',
  status: 'https://github.com/skylow17/a2n-bldc/blob/main/STATUS.md',
  interface: 'https://github.com/skylow17/a2n-bldc/blob/main/interface/AGENTS.md',
} as const;
handle('app:openLink', (key: keyof typeof HELP_LINKS) => shell.openExternal(HELP_LINKS[key]));
handle('app:quit', () => app.quit());

/* ------------------------------------------------------------------ MCP */

handle('mcp:status', () => mcp.current);
handle('mcp:tools', () => mcp.tools());
/** Passe par la config : le choix survit au redémarrage, et la diffusion fait le reste. */
handle('mcp:apply', async (enabled: boolean, port: number) => {
  await config.set({ mcp: { enabled, port } });
  // La config n'a peut-être pas changé (relance après un échec) : on applique quand même.
  return mcp.apply(enabled, port);
});

/* ------------------------------------------------------------------ cycle de vie */

void app.whenReady().then(async () => {
  try {
    await config.load();
  } catch (e) {
    core.log('error', 'gui', `data folder unusable, defaults in memory: ${e instanceof Error ? e.message : String(e)}`);
  }
  createWindow();

  await mcp.apply(config.current.mcp.enabled, config.current.mcp.port);

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
  void mcp.stop();
});
