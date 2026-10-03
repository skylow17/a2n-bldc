/**
 * Contenu des menus, partagé entre la fenêtre principale et la vue Control détachée.
 *
 * Les actions passent par les mêmes appels que les boutons des vues : un menu n'a pas de
 * chemin à lui. Les éléments qui dépendent d'une vue (exporter la mesure affichée…) passent
 * par `commands.ts` et se grisent quand aucune vue ne les écoute.
 */

import type { DeviceSnapshot } from '../main/device/DeviceCore.js';
import type { AppConfig, ConfigPatch } from '../shared/config.js';
import { emitCommand, hasHandler } from './commands.js';
import type { Menu, MenuItem } from './components/MenuBar.js';
import { api } from './useDevice.js';

export type DialogId = 'settings' | 'mcp' | 'about' | 'shortcuts';

const ZOOMS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export function zoomStep(current: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOMS.find((z) => z > current + 1e-6) ?? ZOOMS[ZOOMS.length - 1]!;
  return [...ZOOMS].reverse().find((z) => z < current - 1e-6) ?? ZOOMS[0]!;
}

/** Même action que le bouton STOP de la barre : couper, puis retirer la main à l'agent. */
export async function stopNow(): Promise<void> {
  await api().console('STOP');
  await api().setAiControl(false);
}

export interface MenuContext {
  state: DeviceSnapshot;
  config: AppConfig;
  update: (patch: ConfigPatch) => void;
  openDialog: (d: DialogId) => void;
  /** Exécute une action et en rapporte l'erreur éventuelle dans le journal de l'interface. */
  run: (fn: () => Promise<unknown>) => void;
}

export function viewMenuTail(ctx: MenuContext): MenuItem[] {
  const { config, update } = ctx;
  return [
    {
      label: config.ui.theme === 'dark' ? 'Light theme' : 'Dark theme',
      onSelect: () => update({ ui: { theme: config.ui.theme === 'dark' ? 'light' : 'dark' } }),
    },
    {
      label: 'Explanations written out',
      checked: config.ui.helpMode === 'inline',
      onSelect: () => update({ ui: { helpMode: config.ui.helpMode === 'inline' ? 'icons' : 'inline' } }),
    },
    'separator',
    { label: 'Zoom in', shortcut: 'Ctrl+Plus', onSelect: () => update({ ui: { zoom: zoomStep(config.ui.zoom, 1) } }) },
    { label: 'Zoom out', shortcut: 'Ctrl+Minus', onSelect: () => update({ ui: { zoom: zoomStep(config.ui.zoom, -1) } }) },
    { label: `Actual size (${Math.round(config.ui.zoom * 100)} %)`, shortcut: 'Ctrl+0', onSelect: () => update({ ui: { zoom: 1 } }) },
  ];
}

export function deviceMenu(ctx: MenuContext, connectItems: MenuItem[]): Menu {
  const { state, run } = ctx;
  const connected = state.connection === 'connected';
  return {
    label: 'Device',
    items: [
      ...connectItems,
      'separator',
      { label: 'Refresh values', shortcut: 'F5', disabled: !connected, onSelect: () => run(() => api().refresh()) },
      { label: 'Save parameters to flash', disabled: !connected, onSelect: () => run(() => api().saveNvm()) },
      {
        label: 'Clear latched fault',
        disabled: !connected || state.safety?.latched !== true,
        onSelect: () => run(() => api().clearFault()),
      },
      'separator',
      { label: 'STOP', danger: true, disabled: !connected, onSelect: () => run(stopNow) },
    ],
  };
}

export function toolsMenu(ctx: MenuContext, extra: MenuItem[] = []): Menu {
  return {
    label: 'Tools',
    items: [
      { label: 'AI / MCP server…', onSelect: () => ctx.openDialog('mcp') },
      ...extra,
      'separator',
      { label: 'Settings…', shortcut: 'Ctrl+,', onSelect: () => ctx.openDialog('settings') },
    ],
  };
}

export function helpMenu(ctx: MenuContext): Menu {
  return {
    label: 'Help',
    items: [
      { label: 'Keyboard shortcuts', shortcut: 'F1', onSelect: () => ctx.openDialog('shortcuts') },
      'separator',
      { label: 'Protocol specification', onSelect: () => ctx.run(() => api().openLink('protocol')) },
      { label: 'Project status', onSelect: () => ctx.run(() => api().openLink('status')) },
      { label: 'Interface guide', onSelect: () => ctx.run(() => api().openLink('interface')) },
      'separator',
      { label: 'About A2N BLDC', onSelect: () => ctx.openDialog('about') },
    ],
  };
}

export function measurementExportItems(): MenuItem[] {
  return [
    {
      label: 'Export measurement',
      disabled: !hasHandler('measurement:export-csv'),
      submenu: [
        { label: 'CSV…', onSelect: () => emitCommand('measurement:export-csv') },
        { label: 'JSON…', onSelect: () => emitCommand('measurement:export-json') },
        { label: 'PNG image…', onSelect: () => emitCommand('measurement:export-png') },
      ],
    },
  ];
}
