/**
 * Dashboard — ce que le device est, et ce qu'il sait faire.
 *
 * Le tableau des capacités n'est pas décoratif : il vient du bitfield du handshake, que le
 * firmware ne lève que pour ce qui est réellement implémenté. C'est ce qui permet à l'UI de
 * griser ce qui n'existe pas encore au lieu de proposer un bouton qui échouera.
 */

import type { ReactNode } from 'react';

import type { DeviceSnapshot } from '../../main/device/DeviceCore.js';
import { PROTO_CAP } from '../../shared/protocol.js';
import { Dot, Empty, Field, Panel, fmt } from '../components/ui.js';

const CAPABILITIES: Array<{ bit: number; label: string; since: string }> = [
  { bit: PROTO_CAP.TELEMETRY, label: 'Télémétrie souscrite', since: 'M1c' },
  { bit: PROTO_CAP.SCOPE, label: 'Capture scope', since: 'M1c' },
  { bit: PROTO_CAP.NVM, label: 'Persistance NVM', since: 'M2' },
  { bit: PROTO_CAP.CAN, label: 'Bus CAN', since: 'plus tard' },
  { bit: PROTO_CAP.BOOTLOADER, label: 'Bootloader A/B', since: 'plus tard' },
  { bit: PROTO_CAP.ENCODER_INC, label: 'Encodeur incrémental', since: 'M2' },
];

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(8, '0');
}

export function Dashboard({ state }: { state: DeviceSnapshot }): ReactNode {
  const { info } = state;

  if (info === null) {
    return (
      <Empty
        title="Aucun device connecté"
        hint="Choisir un port dans la barre haute, ou « Simulator » pour travailler sans carte."
      />
    );
  }

  const byGroup = new Map<string, number>();
  for (const p of state.params) byGroup.set(p.group, (byGroup.get(p.group) ?? 0) + 1);

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-auto p-3 lg:grid-cols-2 xl:grid-cols-3">
      <Panel title="Identité">
        <Field label="Produit">{info.product}</Field>
        <Field label="Firmware">{info.fwVersion}</Field>
        <Field label="Protocole">
          {info.protocolMajor}.{info.protocolMinor}
        </Field>
        <Field label="UID">{info.uid.map((u) => u.toString(16).padStart(8, '0')).join('-')}</Field>
        <Field label="Lien">{state.portDescription ?? '—'}</Field>
      </Panel>

      <Panel title="Dictionnaire de paramètres">
        <Field label="Entrées">{info.paramCount}</Field>
        <Field label="Hash de forme">{hex(info.paramDictHash)}</Field>
        <Field label="Intégrité du transfert">
          {state.dictIntegrity === null ? (
            '—'
          ) : state.dictIntegrity ? (
            <span className="text-ok">
              <Dot tone="ok" /> hash recalculé identique
            </span>
          ) : (
            <span className="text-fault">
              <Dot tone="fault" /> hash divergent
            </span>
          )}
        </Field>
        {[...byGroup].map(([group, n]) => (
          <Field key={group} label={`Groupe « ${group} »`}>
            {n}
          </Field>
        ))}
      </Panel>

      <Panel title="Capacités annoncées">
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
                <span className="font-mono text-[11px] text-fg-3">
                  {on ? 'disponible' : c.since}
                </span>
              </div>
            );
          })}
        </div>
        <p className="border-t border-line-soft px-3 py-2 text-[11px] leading-relaxed text-fg-3">
          Le firmware ne lève un bit que lorsque la fonction existe vraiment. Une capacité
          absente n'est pas une panne : c'est un jalon qui n'est pas encore atteint.
        </p>
      </Panel>

      <Panel title="Constantes temps réel" className="lg:col-span-2 xl:col-span-1">
        {state.params
          .filter((p) => p.group === 'Board' || p.group === 'PWM')
          .map((p) => (
            <Field key={p.id} label={p.name}>
              {fmt(p.value)} {p.unit}
            </Field>
          ))}
        <p className="border-t border-line-soft px-3 py-2 text-[11px] leading-relaxed text-fg-3">
          Lues sur la carte, pas saisies ici : elles reflètent ce qui a réellement été compilé.
        </p>
      </Panel>
    </div>
  );
}
