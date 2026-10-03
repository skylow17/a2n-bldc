/** Fenêtres du menu Help : à propos, et liste des raccourcis clavier. */

import { useEffect, useState, type ReactNode } from 'react';

import type { DeviceSnapshot } from '../../main/device/DeviceCore.js';
import { formatDictHash } from '../../shared/recipe.js';
import { Dialog } from '../components/Dialog.js';
import type { Menu } from '../components/MenuBar.js';
import { listShortcuts } from '../components/MenuBar.js';
import { Button, Field } from '../components/ui.js';
import { api } from '../useDevice.js';

type AppInfo = Awaited<ReturnType<ReturnType<typeof api>['appInfo']>>;

export function AboutDialog({ state, onClose }: { state: DeviceSnapshot; onClose: () => void }): ReactNode {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void api().appInfo().then(setInfo).catch(() => undefined);
  }, []);
  const dev = state.info;
  return (
    <Dialog
      title="About A2N BLDC"
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          <Button onClick={() => void api().openLink('repo')}>Repository</Button>
          <div className="flex-1" />
          <Button tone="accent" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="selectable py-2">
        <p className="px-3 pb-2 text-[12px] text-fg-2">
          Tuning and instrumentation bench for the A2N BLDC controller.
        </p>
        <Field label="Interface">{info?.appVersion ?? '—'}</Field>
        <Field label="Electron / Chrome / Node">
          {info === null ? '—' : `${info.electron} / ${info.chrome} / ${info.node}`}
        </Field>
        <Field label="Platform">{info?.platform ?? '—'}</Field>
        <Field label="Data folder">{info?.dataDir ?? '—'}</Field>
        <Field label="Device">{dev === null ? 'not connected' : `${dev.product} on ${state.portDescription ?? '?'}`}</Field>
        <Field label="Firmware">{dev?.fwVersion ?? '—'}</Field>
        <Field label="Protocol">{dev === null ? '—' : `${dev.protocolMajor}.${dev.protocolMinor}`}</Field>
        <Field label="Parameter dictionary">
          {dev === null ? '—' : `${dev.paramCount} entries · ${formatDictHash(dev.paramDictHash)}`}
        </Field>
      </div>
    </Dialog>
  );
}

export function ShortcutsDialog({ menus, onClose }: { menus: Menu[]; onClose: () => void }): ReactNode {
  const all = listShortcuts(menus);
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width="max-w-lg">
      <div className="py-2">
        {all.map((s) => (
          <div key={`${s.menu}${s.label}`} className="flex items-center justify-between px-4 py-1 odd:bg-panel-2/40">
            <span className="text-[12px] text-fg-2">
              <span className="text-fg-3">{s.menu} › </span>
              {s.label}
            </span>
            <span className="font-mono text-[11px] text-fg">{s.shortcut}</span>
          </div>
        ))}
        <div className="flex items-center justify-between px-4 py-1">
          <span className="text-[12px] text-fg-2">Focus the menu bar</span>
          <span className="font-mono text-[11px] text-fg">Alt</span>
        </div>
        <div className="flex items-center justify-between px-4 py-1 odd:bg-panel-2/40">
          <span className="text-[12px] text-fg-2">Close a menu or a dialog</span>
          <span className="font-mono text-[11px] text-fg">Esc</span>
        </div>
      </div>
    </Dialog>
  );
}
