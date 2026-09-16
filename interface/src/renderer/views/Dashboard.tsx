/**
 * Dashboard — ce que le device est, et ce qu'il sait faire.
 *
 * Le tableau des capacités n'est pas décoratif : il vient du bitfield du handshake, que le
 * firmware ne lève que pour ce qui est réellement implémenté. C'est ce qui permet à l'UI de
 * griser ce qui n'existe pas encore au lieu de proposer un bouton qui échouera.
 *
 * Libellés en anglais (AGENTS.md §5) ; commentaires en français.
 */

import type { ReactNode } from 'react';

import type { DeviceSnapshot } from '../../main/device/DeviceCore.js';
import { PROTO_CAP } from '../../shared/protocol.js';
import { LiveTelemetry } from '../components/LiveTelemetry.js';
import { Dot, Empty, Field, Panel, fmt } from '../components/ui.js';

const CAPABILITIES: Array<{ bit: number; label: string; since: string }> = [
  { bit: PROTO_CAP.TELEMETRY, label: 'Subscribed telemetry', since: 'M1c' },
  { bit: PROTO_CAP.SCOPE, label: 'Scope capture', since: 'M1c' },
  { bit: PROTO_CAP.NVM, label: 'NVM persistence', since: 'M2' },
  { bit: PROTO_CAP.CAN, label: 'CAN bus', since: 'later' },
  { bit: PROTO_CAP.BOOTLOADER, label: 'A/B bootloader', since: 'later' },
  { bit: PROTO_CAP.ENCODER_INC, label: 'Incremental encoder', since: 'M2' },
];

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(8, '0');
}

export function Dashboard({ state }: { state: DeviceSnapshot }): ReactNode {
  const { info } = state;

  if (info === null) {
    return (
      <Empty
        title="No device connected"
        hint="Pick a port in the top bar, or “Simulator” to work without hardware."
      />
    );
  }

  const byGroup = new Map<string, number>();
  for (const p of state.params) byGroup.set(p.group, (byGroup.get(p.group) ?? 0) + 1);

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-auto p-3 lg:grid-cols-2 xl:grid-cols-3">
      <Panel title="Identity">
        <Field label="Product">{info.product}</Field>
        <Field label="Firmware">{info.fwVersion}</Field>
        <Field label="Protocol">
          {info.protocolMajor}.{info.protocolMinor}
        </Field>
        <Field label="UID">{info.uid.map((u) => u.toString(16).padStart(8, '0')).join('-')}</Field>
        <Field label="Link">{state.portDescription ?? '—'}</Field>
      </Panel>

      <Panel title="Parameter dictionary">
        <Field label="Entries">{info.paramCount}</Field>
        <Field label="Shape hash">{hex(info.paramDictHash)}</Field>
        <Field label="Transfer integrity">
          {state.dictIntegrity === null ? (
            '—'
          ) : state.dictIntegrity ? (
            <span className="text-ok">
              <Dot tone="ok" /> recomputed hash matches
            </span>
          ) : (
            <span className="text-fault">
              <Dot tone="fault" /> hash mismatch
            </span>
          )}
        </Field>
        {[...byGroup].map(([group, n]) => (
          <Field key={group} label={`Group “${group}”`}>
            {n}
          </Field>
        ))}
      </Panel>

      <Panel title="Announced capabilities">
        <div className="p-1">
          {CAPABILITIES.map((c) => {
            const on = (info.capabilities & c.bit) !== 0;
            return (
              <div
                key={c.label}
                className="flex items-center justify-between gap-3 px-2 py-1.5 odd:bg-panel-2/40"
              >
                <span className={`text-[12px] ${on ? 'text-fg' : 'text-fg-3'}`}>
                  <Dot tone={on ? 'ok' : 'idle'} /> {c.label}
                </span>
                <span className="font-mono text-[11px] text-fg-3">{on ? 'available' : c.since}</span>
              </div>
            );
          })}
        </div>
        <p className="border-t border-line-soft px-3 py-2 text-[11px] leading-relaxed text-fg-3">
          The firmware only raises a bit once the feature actually exists. A missing capability
          is not a failure — it is a milestone not yet reached.
        </p>
      </Panel>

      {/* Le trace occupe toute la largeur : c'est ce qu'on regarde pendant un reglage, le
          reste du tableau de bord est de l'identification qu'on lit une fois. */}
      <div className="lg:col-span-2 xl:col-span-3">
        <LiveTelemetry state={state} />
      </div>

      <Panel title="Real-time constants" className="lg:col-span-2 xl:col-span-1">
        {state.params
          .filter((p) => p.group === 'Board' || p.group === 'PWM')
          .map((p) => (
            <Field key={p.id} label={p.name}>
              {fmt(p.value)} {p.unit}
            </Field>
          ))}
        <p className="border-t border-line-soft px-3 py-2 text-[11px] leading-relaxed text-fg-3">
          Read from the board, not typed here: they reflect what was actually compiled.
        </p>
      </Panel>
    </div>
  );
}
