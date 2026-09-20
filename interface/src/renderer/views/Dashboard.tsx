/**
 * Dashboard — ce que la carte fait en ce moment.
 *
 * La version précédente répondait à « qu'est-ce que c'est » : identité, hash du dictionnaire,
 * bits de capacité, constantes compilées. Des choses qu'on lit une fois. Elle datait de M1,
 * quand le firmware ne savait rien dire d'autre ; le module `sensors` est arrivé en M2 et
 * personne n'était revenu ici. Cette version répond à « qu'est-ce qu'elle fait » — c'est
 * l'intention du mockup d'origine, et la seule utile quand on a les mains sur le banc.
 *
 * L'identification n'a pas disparu : elle est descendue en bas et tient en un panneau.
 *
 * Libellés en anglais (AGENTS.md §5) ; commentaires en français.
 */

import type { ReactNode } from 'react';

import type { DeviceSnapshot, MonitorState } from '../../main/device/DeviceCore.js';
import { PROTO_CAP } from '../../shared/protocol.js';
import { LiveTelemetry } from '../components/LiveTelemetry.js';
import { Metric, Pill, type Health } from '../components/Metric.js';
import { Dot, Empty, Field, Panel } from '../components/ui.js';

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

/**
 * Santé d'un rail : l'écart relatif à sa valeur nominale.
 *
 * Les seuils sont larges — 5 % puis 10 % — parce que ce tableau n'est pas une protection.
 * La protection vit dans le firmware ; ici on attire l'œil sur ce qui a bougé, on ne décide
 * pas d'une coupure.
 */
function railHealth(mv: number, nominalMv: number): Health {
  const err = Math.abs(mv - nominalMv) / nominalMv;
  if (err > 0.1) return 'fault';
  if (err > 0.05) return 'warn';
  return 'ok';
}

function Rail({
  label,
  mv,
  nominalMv,
}: {
  label: string;
  mv: number;
  nominalMv: number;
}): ReactNode {
  const tone = railHealth(mv, nominalMv);
  const word = tone === 'ok' ? 'ok' : tone === 'warn' ? 'off nominal' : 'out of range';
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5 odd:bg-panel-2/40">
      <span className="text-[12px] text-fg-2">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-mono text-[12px] text-fg">{(mv / 1000).toFixed(3)} V</span>
        <Pill tone={tone}>{word}</Pill>
      </span>
    </div>
  );
}

function Row({ label, right }: { label: string; right: ReactNode }): ReactNode {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5 odd:bg-panel-2/40">
      <span className="text-[12px] text-fg-2">{label}</span>
      <span className="flex items-center gap-2">{right}</span>
    </div>
  );
}

function tempTone(c: number | null): Health {
  if (c === null) return 'idle';
  if (c > 85) return 'fault';
  if (c > 70) return 'warn';
  return 'ok';
}

/** Au-delà de ce pour mille d'étendue, la référence rend toutes les tensions douteuses. */
const VREF_UNSTABLE_PERMILLE = 20;

/**
 * Bandeau d'avertissement quand la référence analogique bouge.
 *
 * Sans lui, le tableau de bord affiche des rails qui oscillent alors qu'ils sont parfaitement
 * stables, et l'utilisateur cherche un défaut d'alimentation qui n'existe pas — c'est
 * exactement ce qui vient d'arriver. Rien n'est lissé : amortir l'affichage rendrait la vue
 * agréable et masquerait un vrai défaut matériel. On mesure l'agitation, et on la dit.
 */
function ReferenceWarning({ spread }: { spread: number }): ReactNode {
  return (
    <section className="rounded-[4px] border border-fault/50 bg-panel px-3 py-2 lg:col-span-2 xl:col-span-4">
      <div className="flex items-baseline gap-2">
        <Dot tone="fault" />
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fault">
          Analog reference unstable
        </h3>
        <span className="font-mono text-[11px] text-fg-3">
          VREF+ spans {(spread / 10).toFixed(1)} % of its own mean
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-fg-3">
        Every voltage below is measured against VREF+, so every one of them carries that swing.
        The rails themselves are steady — this is the reference moving, not the supply. Until the
        hardware is fixed, <span className="font-mono text-fg-2">VREF.BUF ON</span> in the console
        hands VREF+ to the MCU&rsquo;s internal 2.048 V buffer and the readings become true.
      </p>
    </section>
  );
}

function Live({ state, mon }: { state: DeviceSnapshot; mon: MonitorState }): ReactNode {
  const sf = state.safety;
  const refUnstable =
    mon.vrefSpreadPermille !== null && mon.vrefSpreadPermille > VREF_UNSTABLE_PERMILLE;
  // Le tourniquet de mesure doit avancer. Figé, toutes les valeurs ci-dessous sont celles
  // du dernier tour publié, et les montrer comme vivantes serait un mensonge.
  const stalled = mon.rounds === 0;

  return (
    <>
      {refUnstable && <ReferenceWarning spread={mon.vrefSpreadPermille!} />}

      <Metric
        label="Input voltage"
        value={mon.vinMv / 1000}
        unit="V"
        tone={railHealth(mon.vinMv, 15000)}
        note="Vin"
      />
      <Metric
        label="Motor rail"
        value={mon.vmotMv / 1000}
        unit="V"
        tone={railHealth(mon.vmotMv, 15000)}
        note="Vmot"
      />
      <Metric
        label="MCU temperature"
        value={mon.mcuTempC}
        unit="°C"
        digits={0}
        tone={tempTone(mon.mcuTempC)}
        note="junction"
      />
      <Metric
        label="Loop load"
        value={mon.loadPermille / 10}
        unit="%"
        digits={1}
        tone={mon.loadPermille > 800 ? 'fault' : mon.loadPermille > 500 ? 'warn' : 'ok'}
        note={`peak ${(mon.isrMaxNs / 1000).toFixed(1)} µs`}
      />

      <Panel title="Rails and protection" className="lg:col-span-2">
        <Rail label="5 V rail" mv={mon.v5Mv} nominalMv={5000} />
        <Rail label="3V3 rail" mv={mon.v3v3Mv} nominalMv={3300} />
        <Row
          label="Analog reference VREF+"
          right={
            <>
              <span className="font-mono text-[12px] text-fg">
                {(mon.vrefMv / 1000).toFixed(3)} V
              </span>
              <Pill tone={refUnstable ? 'fault' : railHealth(mon.vrefMv, 2048)}>
                {refUnstable
                  ? `unstable ±${(mon.vrefSpreadPermille! / 20).toFixed(1)} %`
                  : railHealth(mon.vrefMv, 2048) === 'ok'
                    ? 'ok'
                    : 'off nominal'}
              </Pill>
            </>
          }
        />
        <Row
          label="DRV8304 nFAULT"
          right={
            <>
              <span className="font-mono text-[12px] text-fg-3">{mon.drvEvents} edges</span>
              <Pill tone={mon.drvFault ? 'fault' : 'ok'}>
                {mon.drvFault ? 'asserted' : 'clear'}
              </Pill>
            </>
          }
        />
        <Row
          label="Command-flow watchdog"
          right={
            <>
              <span className="font-mono text-[12px] text-fg-3">{sf?.trips ?? 0} trips</span>
              <Pill tone={sf === null ? 'idle' : sf.latched ? 'fault' : 'ok'}>
                {sf === null ? '—' : sf.latched ? sf.reason : 'armed'}
              </Pill>
            </>
          }
        />
        <Row
          label="Power outputs"
          right={
            <Pill tone={sf?.outputsLive === true ? 'warn' : 'idle'}>
              {sf?.outputsLive === true ? 'live' : 'high impedance'}
            </Pill>
          }
        />
      </Panel>

      <Panel title="Current sense inputs" className="lg:col-span-2">
        {(['A', 'B', 'C'] as const).map((phase, i) => (
          <Field key={phase} label={`Phase ${phase}`}>
            {((mon.csaMv[i] ?? 0) / 1000).toFixed(3)} V
          </Field>
        ))}
        <Field label="Control loop">
          {stalled ? 'measurement stalled' : `${mon.ticks.toLocaleString('en-US')} ticks`}
        </Field>
        <p className="border-t border-line-soft px-3 py-2 text-[11px] leading-relaxed text-fg-3">
          Slow read-back of the three amplifier outputs, biased at half the reference when the
          hardware works. These are volts at the pin, not amperes: the shunt scaling only means
          something once the inputs are actually driven.
        </p>
      </Panel>
    </>
  );
}

export function Dashboard({ state }: { state: DeviceSnapshot }): ReactNode {
  const { info, monitor } = state;

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
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-auto p-3 lg:grid-cols-2 xl:grid-cols-4">
      {monitor === null ? (
        <Panel title="Board monitoring" className="lg:col-span-2 xl:col-span-4">
          <p className="px-3 py-3 text-[12px] text-fg-3">
            Waiting for the first reading from the board.
          </p>
        </Panel>
      ) : (
        <Live state={state} mon={monitor} />
      )}

      {/* Le tracé occupe toute la largeur : c'est ce qu'on regarde pendant un réglage. */}
      <div className="lg:col-span-2 xl:col-span-4">
        <LiveTelemetry state={state} />
      </div>

      {/* Identification : on la lit une fois, elle tient en un panneau et passe en dessous. */}
      <Panel title="Device" className="lg:col-span-2">
        <Field label="Product">{info.product}</Field>
        <Field label="Firmware">{info.fwVersion}</Field>
        <Field label="Protocol">
          {info.protocolMajor}.{info.protocolMinor}
        </Field>
        <Field label="UID">{info.uid.map((u) => u.toString(16).padStart(8, '0')).join('-')}</Field>
        <Field label="Link">{state.portDescription ?? '—'}</Field>
        <Field label="Parameters">
          {info.paramCount} entries · {hex(info.paramDictHash)}
          {state.dictIntegrity === false && (
            <span className="ml-2 text-fault">
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

      <Panel title="Announced capabilities" className="lg:col-span-2">
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
          The firmware only raises a bit once the feature actually exists. A missing capability is
          not a failure — it is a milestone not yet reached.
        </p>
      </Panel>
    </div>
  );
}
