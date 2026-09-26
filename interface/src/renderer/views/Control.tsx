/**
 * Vue Control — armement, boucle ouverte, boucle de courant (M3, étapes 10 et 11).
 *
 * Tout passe par la console du firmware, les mêmes lignes qu'on taperait à la main : `ARM`,
 * `OL`, `CL`, et leurs lectures d'état. Aucun chemin dédié, et donc aucune limite recopiée
 * ici — amplitude, fréquence, consignes, durées sont bornées par le firmware (`AGENTS.md`
 * §3), qui répond `ERR LIMIT` au-delà. La vue affiche ce refus tel quel plutôt que de le
 * devancer : une limite recopiée côté PC finit toujours par diverger de la vraie.
 *
 * Le watchdog de flux du firmware coupe au-delà de 250 ms de silence ; le battement du
 * `DeviceCore`, toutes les 80 ms, le tient en vie pendant une rotation lancée d'ici.
 */

import { useEffect, useState, type ReactNode } from 'react';

import type { DeviceSnapshot } from '../../main/device/DeviceCore.js';
import { parseCl, parseFoc, parseOl, type ClStatus, type FocStatus, type OlStatus } from '../controlStatus.js';
import { Pill } from '../components/Metric.js';
import { Button, Empty, Field, Panel, fmt } from '../components/ui.js';
import { api, useAction } from '../useDevice.js';

/** Cadence de relecture des états. Assez vive pour suivre une rampe, assez lente pour ne
 *  pas noyer la console commune : trois lignes toutes les 250 ms. */
const POLL_MS = 250;

function NumberInput({
  label,
  unit,
  value,
  onChange,
  disabled,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}): ReactNode {
  return (
    <label className="flex items-center justify-between gap-3 px-3 py-1.5">
      <span className="text-[12px] text-fg-2">{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          className="w-24 rounded-[3px] border border-line bg-raise px-2 py-0.5 text-right font-mono text-[12px] text-fg outline-none focus:border-fg-3 disabled:opacity-40"
          value={value}
          disabled={disabled}
          inputMode="decimal"
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="w-8 font-mono text-[11px] text-fg-3">{unit}</span>
      </span>
    </label>
  );
}

/** Dernière réponse d'une commande, lisible : un refus du firmware est une information. */
function Reply({ text }: { text: string | null }): ReactNode {
  if (text === null) return null;
  const ok = text.startsWith('OK');
  return (
    <p className={`px-3 py-1.5 font-mono text-[11px] ${ok ? 'text-fg-3' : 'text-fault'}`}>
      {text}
    </p>
  );
}

const ma = (v: number | null): string => (v === null ? '—' : `${v} mA`);
const volts = (mv: number | null): string => (mv === null ? '—' : `${(mv / 1000).toFixed(3)} V`);

export function Control({ state }: { state: DeviceSnapshot }): ReactNode {
  const connected = state.connection === 'connected';
  const sf = state.safety;
  const act = useAction();

  const [ol, setOl] = useState<OlStatus | null>(null);
  const [cl, setCl] = useState<ClStatus | null>(null);
  const [foc, setFoc] = useState<FocStatus | null>(null);
  const [reply, setReply] = useState<string | null>(null);

  const [olAmp, setOlAmp] = useState('40');
  const [olHz, setOlHz] = useState('5');
  const [olMs, setOlMs] = useState('3000');
  const [clId, setClId] = useState('100');
  const [clIq, setClIq] = useState('0');
  const [clMs, setClMs] = useState('1000');

  /* Relecture périodique, séquentielle : la console n'a qu'une file, et trois requêtes
   * lancées en parallèle se serialiseraient de toute façon. */
  useEffect(() => {
    if (!connected) return undefined;
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const o = parseOl(await api().console('OL?'));
        const c = parseCl(await api().console('CL?'));
        const f = parseFoc(await api().console('FOC?'));
        if (!alive) return;
        setOl(o);
        setCl(c);
        setFoc(f);
      } catch {
        /* une lecture manquée n'est pas une faute : la suivante suffit */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [connected]);

  const send = (line: string): void =>
    void act.run(async () => {
      setReply(`${line} → ${await api().console(line)}`);
    });

  if (!connected) {
    return <Empty title="No device connected" hint="Connect a board to arm it and drive the motor." />;
  }

  const armed = sf?.armed === true;
  const latched = sf?.latched === true;
  const live = sf?.outputsLive === true;
  const noLoop = cl === null && foc === null;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-auto p-3 xl:grid-cols-2">
      <Panel
        title="Arming"
        right={
          <Pill tone={latched ? 'fault' : live ? 'warn' : armed ? 'warn' : 'ok'}>
            {latched ? `fault: ${sf!.reason}` : live ? 'outputs live' : armed ? 'armed' : 'disarmed'}
          </Pill>
        }
      >
        <p className="px-3 py-2 text-[12px] leading-relaxed text-fg-2">
          Nothing energises the motor without ARM. A reset, any fault, a lost host, STOP and
          DISARM take it back. A latched fault is acknowledged with CLEAR in the header, and
          the board stays disarmed after it.
        </p>
        <div className="flex gap-2 px-3 pb-3">
          <Button tone="accent" disabled={act.busy || armed || latched} onClick={() => send('ARM')}>
            ARM
          </Button>
          <Button disabled={act.busy || !armed} onClick={() => send('DISARM')}>
            DISARM
          </Button>
        </div>
        <Reply text={reply} />
        {act.error !== null && <Reply text={act.error} />}
      </Panel>

      <Panel
        title="Rotor frame"
        right={
          <Pill tone={foc === null ? 'idle' : foc.valid ? 'ok' : 'fault'}>
            {foc === null ? 'n/a' : foc.valid ? 'measuring' : foc.cfg ? 'no angle' : 'not configured'}
          </Pill>
        }
      >
        {foc === null ? (
          <p className="px-3 py-2 text-[12px] text-fg-3">This firmware does not measure Id and Iq.</p>
        ) : (
          <>
            <Field label="Electrical angle">{foc.thetaDeg === null ? '—' : `${fmt(foc.thetaDeg, 4)}°`}</Field>
            <Field label="Id">{ma(foc.idMa)}</Field>
            <Field label="Iq">{ma(foc.iqMa)}</Field>
            <p className="px-3 py-2 text-[11px] leading-relaxed text-fg-3">
              Instantaneous, amperes at ±15 %. The Scope and the “Current loop” preset of the
              Dashboard show them over time.
            </p>
          </>
        )}
      </Panel>

      <Panel
        title="Open loop"
        right={
          <Pill tone={ol?.active === true ? 'warn' : 'idle'}>
            {ol?.active === true ? `turning ${fmt(ol.hz, 3)} Hz` : 'idle'}
          </Pill>
        }
      >
        <p className="px-3 py-2 text-[12px] leading-relaxed text-fg-2">
          A voltage vector turns at a fixed amplitude and the shaft follows. No measurement
          is used: this is the test before any closed loop.
        </p>
        <NumberInput label="Amplitude" unit="‰" value={olAmp} onChange={setOlAmp} disabled={act.busy} />
        <NumberInput label="Electrical frequency" unit="Hz" value={olHz} onChange={setOlHz} disabled={act.busy} />
        <NumberInput label="Duration" unit="ms" value={olMs} onChange={setOlMs} disabled={act.busy} />
        <div className="flex gap-2 px-3 py-2">
          <Button
            tone="accent"
            disabled={act.busy || !armed || live}
            title={armed ? 'Refused by the firmware beyond its limits' : 'ARM first'}
            onClick={() => send(`OL ${olAmp.trim()} ${olHz.trim()} ${olMs.trim()}`)}
          >
            Start
          </Button>
          <Button disabled={act.busy || ol?.active !== true} onClick={() => send('OL STOP')}>
            Stop
          </Button>
        </div>
        {ol?.active === true && (
          <Field label="Time left">{ol.leftMs === null ? '—' : `${ol.leftMs} ms`}</Field>
        )}
      </Panel>

      <Panel
        title="Current loop"
        right={
          <Pill tone={noLoop ? 'idle' : cl?.active === true ? 'warn' : 'idle'}>
            {cl === null ? 'n/a' : cl.active ? 'regulating' : 'idle'}
          </Pill>
        }
      >
        {cl === null ? (
          <p className="px-3 py-2 text-[12px] text-fg-3">This firmware has no current loop.</p>
        ) : (
          <>
            <p className="px-3 py-2 text-[12px] leading-relaxed text-fg-2">
              Two PI regulators hold Id and Iq, tuned in the firmware from R and L. Id alone
              leaves the rotor still. <strong className="text-fg">Iq makes torque: the rotor
              turns</strong>, and until the speed loop exists only the voltage cap bounds its
              speed.
            </p>
            <NumberInput label="Id" unit="mA" value={clId} onChange={setClId} disabled={act.busy} />
            <NumberInput label="Iq" unit="mA" value={clIq} onChange={setClIq} disabled={act.busy} />
            <NumberInput label="Duration" unit="ms" value={clMs} onChange={setClMs} disabled={act.busy} />
            <div className="flex gap-2 px-3 py-2">
              <Button
                tone="accent"
                disabled={act.busy || !armed || live}
                title={armed ? 'Refused by the firmware beyond its limits' : 'ARM first'}
                onClick={() => send(`CL ${clId.trim()} ${clIq.trim()} ${clMs.trim()}`)}
              >
                Start
              </Button>
              <Button disabled={act.busy || !cl.active} onClick={() => send('CL STOP')}>
                Stop
              </Button>
            </div>
            <Field label="Setpoint Id / Iq">{`${ma(cl.idRefMa)} / ${ma(cl.iqRefMa)}`}</Field>
            <Field label="Mean Id / Iq since start">{`${ma(cl.idAvgMa)} / ${ma(cl.iqAvgMa)}`}</Field>
            <Field label="Voltage Vd / Vq">{`${volts(cl.vdMv)} / ${volts(cl.vqMv)}`}</Field>
            <Field label="Voltage cap reached">
              {cl.satRatio === null ? '—' : `${(cl.satRatio * 100).toFixed(1)} % of passes`}
            </Field>
            {cl.active && <Field label="Time left">{cl.leftMs === null ? '—' : `${cl.leftMs} ms`}</Field>}
            <Field label="Gains Kp / Ki">
              {cl.kpMvA === null ? '—' : `${(cl.kpMvA / 1000).toFixed(3)} V/A / ${cl.kiVAs} V/(A·s)`}
            </Field>
          </>
        )}
      </Panel>
    </div>
  );
}
