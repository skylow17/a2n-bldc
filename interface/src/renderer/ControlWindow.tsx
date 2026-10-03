/**
 * La vue Control seule, dans sa propre fenêtre (`#control`).
 *
 * Même renderer, même `DeviceCore` que la fenêtre principale : l'état arrive par les mêmes
 * événements, les commandes partent par la même file de console. Seule la mise en page
 * change — pas de rail de navigation, pas de console, mais la barre haute garde ce que
 * toute fenêtre doit montrer : l'état de la liaison, la barrière de sécurité, AI CONTROL
 * et STOP.
 */

import { useMemo, useState, type ReactNode } from 'react';

import { MenuBar, useShortcuts, type Menu } from './components/MenuBar.js';
import { Button } from './components/ui.js';
import { useConfig } from './config.js';
import { deviceMenu, helpMenu, toolsMenu, viewMenuTail, type DialogId, type MenuContext } from './menus.js';
import { AboutDialog, ShortcutsDialog } from './views/HelpDialogs.js';
import { McpDialog } from './views/McpDialog.js';
import { SettingsDialog } from './views/SettingsDialog.js';
import { CriticalControls, SafetyBadge, StatusBadge } from './components/SafetyControls.js';
import { api, useAction, useDeviceState } from './useDevice.js';
import { Control } from './views/Control.js';

export function ControlWindow(): ReactNode {
  const state = useDeviceState();
  const { config, update } = useConfig();
  const [dialog, setDialog] = useState<DialogId | null>(null);
  const act = useAction();

  /* Barre réduite : pas de navigation entre vues ici, mais le même menu Device (STOP
   * compris), les mêmes réglages et la même aide que la fenêtre principale. */
  const menus = useMemo((): Menu[] => {
    const ctx: MenuContext = { state, config, update, openDialog: setDialog, run: (fn) => void act.run(fn) };
    return [
      {
        label: 'View',
        items: [
          { label: 'Dock back into the main window', shortcut: 'Ctrl+D', onSelect: () => ctx.run(() => api().dockControl()) },
          'separator',
          ...viewMenuTail(ctx),
        ],
      },
      deviceMenu(
        ctx,
        state.connection === 'connected'
          ? [{ label: 'Disconnect', onSelect: () => ctx.run(() => api().disconnect()) }]
          : [],
      ),
      toolsMenu(ctx),
      helpMenu(ctx),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, config]);
  useShortcuts(menus);

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <span className="font-mono text-[13px] font-semibold tracking-wide text-accent">CONTROL</span>
        <MenuBar menus={menus} />
        <Button
          onClick={() => void api().dockControl()}
          title="Close this window and bring Control back into the main window"
        >
          Dock
        </Button>
        <div className="flex-1" />
        <StatusBadge state={state} />
        <SafetyBadge state={state} />
        <CriticalControls state={state} />
      </header>
      <main className="relative min-h-0 flex-1 overflow-hidden">
        {dialog === 'settings' && <SettingsDialog onClose={() => setDialog(null)} onOpenMcp={() => setDialog('mcp')} />}
        {dialog === 'mcp' && <McpDialog state={state} onClose={() => setDialog(null)} />}
        {dialog === 'about' && <AboutDialog state={state} onClose={() => setDialog(null)} />}
        {dialog === 'shortcuts' && <ShortcutsDialog menus={menus} onClose={() => setDialog(null)} />}
        <Control state={state} />
      </main>
    </div>
  );
}
