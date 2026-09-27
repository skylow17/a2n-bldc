/**
 * Ce que toute fenêtre de l'application montre en haut, sans exception : l'état de la
 * liaison, l'état de la barrière de sécurité, l'interrupteur de pilotage par agent et le
 * bouton STOP (`AGENTS.md` §4.6).
 *
 * Sortis de `App.tsx` quand la vue Control a pu vivre dans sa propre fenêtre : la règle
 * « visibles en permanence » vaut pour chaque fenêtre, et une copie de ces composants dans
 * la seconde aurait fini par diverger de la première.
 */

import type { ReactNode } from 'react';

import type { DeviceSnapshot } from '../../main/device/DeviceCore.js';
import { api, useAction } from '../useDevice.js';
import { Button, Dot, Toggle } from './ui.js';

export function StatusBadge({ state }: { state: DeviceSnapshot }): ReactNode {
  const map = {
    disconnected: { tone: 'idle', text: 'DISCONNECTED' },
    connecting: { tone: 'warn', text: 'CONNECTING' },
    connected: { tone: 'ok', text: 'CONNECTED' },
    error: { tone: 'fault', text: 'ERROR' },
  } as const;
  const s = map[state.connection];

  return (
    <span className="flex items-center gap-2 rounded-[3px] border border-line bg-raise px-2.5 py-1 font-mono text-[11px] tracking-wider">
      <Dot tone={s.tone} />
      {s.text}
      {state.info !== null && <span className="text-fg-3">{state.info.fwVersion}</span>}
    </span>
  );
}

/**
 * État de la barrière de sécurité du firmware.
 *
 * Quatre états, et un seul demande une action. Au repos, rien n'est affiché : une pastille
 * verte permanente n'apprend rien et finit par ne plus être lue. Sorties actives, un point
 * suffit — c'est une information de danger, elle doit se voir sans se lire ; carte armée
 * sans sorties actives, de même, puisqu'une seule commande sépare alors du mouvement. Faute
 * verrouillée, la cause est nommée et l'acquittement est là, parce qu'à ce moment précis
 * c'est la seule chose que l'opérateur veut faire.
 */
export function SafetyBadge({ state }: { state: DeviceSnapshot }): ReactNode {
  const clear = useAction();
  const sf = state.safety;
  if (sf === null || state.connection !== 'connected') return null;

  if (sf.latched) {
    return (
      <span className="flex items-center gap-2 rounded-[3px] border border-fault bg-raise px-2.5 py-1 font-mono text-[11px] tracking-wider text-fault">
        <Dot tone="fault" />
        TORQUE CUT — {sf.reason.toUpperCase().replace(/_/g, ' ')}
        <Button
          disabled={clear.busy}
          title="Acknowledges the latched fault. The firmware refuses while the cause is still present."
          onClick={() => void clear.run(async () => { await api().clearFault(); })}
        >
          CLEAR
        </Button>
      </span>
    );
  }

  if (sf.outputsLive) {
    return (
      <span className="flex items-center gap-2 rounded-[3px] border border-line bg-raise px-2.5 py-1 font-mono text-[11px] tracking-wider text-accent">
        <Dot tone="warn" />
        OUTPUTS LIVE
      </span>
    );
  }

  // Armée sans sorties actives : rien ne tourne, mais la commande suivante le peut. C'est
  // le moment où l'on doit savoir, sans chercher, que la carte n'est plus au repos.
  if (sf.armed === true) {
    return (
      <span className="flex items-center gap-2 rounded-[3px] border border-line bg-raise px-2.5 py-1 font-mono text-[11px] tracking-wider text-accent">
        <Dot tone="warn" />
        ARMED
      </span>
    );
  }

  return null;
}

/** Interrupteur de pilotage par agent, puis STOP — toujours dans cet ordre, toujours à droite. */
export function CriticalControls({ state }: { state: DeviceSnapshot }): ReactNode {
  const stop = useAction();
  return (
    <>
      <Toggle
        label="AI CONTROL"
        checked={state.aiControl}
        onChange={(v) => void api().setAiControl(v)}
        title="Allows an agent to drive the bench. Firmware limits remain the only safety guarantee."
      />

      {/* STOP : toujours présent, jamais désactivé tant qu'un device est connecté. */}
      <Button
        tone="danger"
        className="px-4 py-1.5 font-bold tracking-wider"
        disabled={state.connection !== 'connected' || stop.busy}
        title="Cuts torque immediately"
        onClick={() =>
          void stop.run(async () => {
            await api().console('STOP');
            await api().setAiControl(false);
          })
        }
      >
        STOP
      </Button>
    </>
  );
}
