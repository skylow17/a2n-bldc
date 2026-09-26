/**
 * Vue Control — armement, boucle ouverte, boucles de courant, de vitesse et de position (M3,
 * étapes 10 à 13).
 *
 * Tout passe par la console du firmware, les mêmes lignes qu'on taperait à la main : `ARM`,
 * `OL`, `CL`, `SL`, `PL`, et leurs lectures d'état. Aucun chemin dédié, et donc aucune limite recopiée
 * ici — amplitude, fréquence, consignes, durées sont bornées par le firmware (`AGENTS.md`
 * §3), qui répond `ERR LIMIT` au-delà. La vue affiche ce refus tel quel plutôt que de le
 * devancer : une limite recopiée côté PC finit toujours par diverger de la vraie.
 *
 * Le watchdog de flux du firmware coupe au-delà de 250 ms de silence ; le battement du
 * `DeviceCore`, toutes les 80 ms, le tient en vie pendant une rotation lancée d'ici.
 */

import { useEffect, useState, type ReactNode } from 'react';

import type { DeviceSnapshot } from '../../main/device/DeviceCore.js';
import {
  parseCl,
  parseFoc,
  parseOl,
  parsePl,
  parseSl,
  type ClStatus,
  type FocStatus,
  type OlStatus,
  type PlStatus,
  type SlStatus,
} from '../controlStatus.js';
import { Pill } from '../components/Metric.js';
import { Button, Empty, Field, Panel, fmt } from '../components/ui.js';
import { api, useAction } from '../useDevice.js';

/** Cadence de relecture des états. Assez vive pour suivre une rampe, assez lente pour ne
 *  pas noyer la console commune : cinq lignes toutes les 250 ms. */
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
  const [sl, setSl] = useState<SlStatus | null>(null);
  const [pl, setPl] = useState<PlStatus | null>(null);
  const [reply, setReply] = useState<string | null>(null);

  const [olAmp, setOlAmp] = useState('40');
  const [olHz, setOlHz] = useState('5');
  const [olMs, setOlMs] = useState('3000');
  const [clId, setClId] = useState('100');
  const [clIq, setClIq] = useState('0');
  const [clMs, setClMs] = useState('1000');
  const [slW, setSlW] = useState('2');
  const [slMs, setSlMs] = useState('3000');
  const [plMove, setPlMove] = useState('1');
  const [plMs, setPlMs] = useState('2000');

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
        const w = parseSl(await api().console('SL?'));
        const q = parsePl(await api().console('PL?'));
        if (!alive) return;
        setSl(w);
        setPl(q);
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
      <Panel
        title="Speed loop"
        right={
          <Pill tone={sl?.active === true ? 'warn' : 'idle'}>
            {sl === null ? 'n/a' : sl.active ? `turning ${fmt(sl.velRadS, 3)} rad/s` : 'idle'}
          </Pill>
        }
      >
        {sl === null ? (
          <p className="px-3 py-2 text-[12px] text-fg-3">This firmware has no speed loop.</p>
        ) : (
          <>
            <p className="px-3 py-2 text-[12px] leading-relaxed text-fg-2">
              A PI regulator sets Iq so that the shaft holds a mechanical speed, with Id at
              zero. Tuned in the firmware from the measured rotor inertia; the overspeed cut
              stays armed above the speed limit.
            </p>
            <NumberInput label="Speed" unit="rad/s" value={slW} onChange={setSlW} disabled={act.busy} />
            <NumberInput label="Duration" unit="ms" value={slMs} onChange={setSlMs} disabled={act.busy} />
            <div className="flex gap-2 px-3 py-2">
              <Button
                tone="accent"
                disabled={act.busy || !armed || live}
                title={armed ? 'Refused by the firmware beyond its limits' : 'ARM first'}
                onClick={() => {
                  // La console attend des milliradians par seconde, entiers : la saisie en
                  // rad/s est plus naturelle, la conversion se fait ici, sans borne.
                  const w = Number(slW.trim());
                  send(`SL ${Number.isFinite(w) ? Math.round(w * 1000) : slW.trim()} ${slMs.trim()}`);
                }}
              >
                Start
              </Button>
              <Button disabled={act.busy || !sl.active} onClick={() => send('SL STOP')}>
                Stop
              </Button>
            </div>
            <Field label="Setpoint">{sl.refRadS === null ? '—' : `${fmt(sl.refRadS, 4)} rad/s`}</Field>
            <Field label="Mean speed since start">
              {sl.velAvgRadS === null ? '—' : `${fmt(sl.velAvgRadS, 4)} rad/s`}
            </Field>
            <Field label="Iq setpoint">{ma(sl.iqRefMa)}</Field>
            <Field label="Iq cap reached">
              {sl.iqSatRatio === null ? '—' : `${(sl.iqSatRatio * 100).toFixed(1)} % of passes`}
            </Field>
            {sl.active && <Field label="Time left">{sl.leftMs === null ? '—' : `${sl.leftMs} ms`}</Field>}
            <Field label="Gain Kp">{sl.kpMaRadS === null ? '—' : `${fmt(sl.kpMaRadS, 4)} mA per rad/s`}</Field>
          </>
        )}
      </Panel>
      <Panel
        title="Position loop"
        right={
          <Pill tone={pl?.active === true ? 'warn' : 'idle'}>
            {pl === null ? 'n/a' : pl.active ? 'holding' : 'idle'}
          </Pill>
        }
      >
        {pl === null ? (
          <p className="px-3 py-2 text-[12px] text-fg-3">This firmware has no position loop.</p>
        ) : (
          <>
            <p className="px-3 py-2 text-[12px] leading-relaxed text-fg-2">
              Moves the shaft by the given angle from where it stands, then holds it there
              until the duration ends; the shaft is free again after that. Position sets the
              speed, speed sets Iq: every cap and cut of the loops below still applies.
            </p>
            <NumberInput label="Move" unit="rad" value={plMove} onChange={setPlMove} disabled={act.busy} />
            <NumberInput label="Duration" unit="ms" value={plMs} onChange={setPlMs} disabled={act.busy} />
            <div className="flex gap-2 px-3 py-2">
              <Button
                tone="accent"
                disabled={act.busy || !armed || live || pl.posRad === null}
                title={armed ? 'Refused by the firmware beyond its limits' : 'ARM first'}
                onClick={() => {
                  // La console attend une cible absolue en milliradians. Le déplacement saisi
                  // s'ajoute à la dernière position lue ; le firmware juge seul de la distance.
                  const d = Number(plMove.trim());
                  const target = Number.isFinite(d) ? Math.round((pl.posRad! + d) * 1000) : NaN;
                  send(`PL ${Number.isFinite(target) ? target : plMove.trim()} ${plMs.trim()}`);
                }}
              >
                Move
              </Button>
              <Button disabled={act.busy || !pl.active} onClick={() => send('PL STOP')}>
                Stop
              </Button>
            </div>
            <Field label="Position">{pl.posRad === null ? '—' : `${fmt(pl.posRad, 5)} rad`}</Field>
            <Field label="Target">{pl.targetRad === null ? '—' : `${fmt(pl.targetRad, 5)} rad`}</Field>
            <Field label="Error">{pl.errMrad === null ? '—' : `${pl.errMrad} mrad`}</Field>
            <Field label="Speed setpoint">{pl.wRefRadS === null ? '—' : `${fmt(pl.wRefRadS, 3)} rad/s`}</Field>
            {pl.active && <Field label="Time left">{pl.leftMs === null ? '—' : `${pl.leftMs} ms`}</Field>}
          </>
        )}
      </Panel>
    </div>
  );
}
