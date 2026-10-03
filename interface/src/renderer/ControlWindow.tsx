/**
 * La vue Control seule, dans sa propre fenêtre (`#control`).
 *
 * Même renderer, même `DeviceCore` que la fenêtre principale : l'état arrive par les mêmes
 * événements, les commandes partent par la même file de console. Seule la mise en page
 * change — pas de rail de navigation, pas de console, mais la barre haute garde ce que
 * toute fenêtre doit montrer : l'état de la liaison, la barrière de sécurité, AI CONTROL
 * et STOP.
 */

import type { ReactNode } from 'react';

import { Button } from './components/ui.js';
import { CriticalControls, SafetyBadge, StatusBadge } from './components/SafetyControls.js';
import { api, useDeviceState } from './useDevice.js';
import { Control } from './views/Control.js';

export function ControlWindow(): ReactNode {
  const state = useDeviceState();

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <span className="font-mono text-[13px] font-semibold tracking-wide text-accent">CONTROL</span>
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
      <main className="min-h-0 flex-1 overflow-hidden">
        <Control state={state} />
      </main>
    </div>
  );
}
