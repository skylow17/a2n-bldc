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

import type { DeviceSnapshot, EncoderState, MonitorState } from '../../main/device/DeviceCore.js';
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
/**
 * Cadran d'angle mecanique. Un chiffre en radians ne dit rien a l'oeil ; une aiguille dit
 * tout de suite si l'arbre tourne, dans quel sens, et si la lecture saute.
 *
 * Grisee quand l'aimant manque : la valeur existe, elle bouge meme beaucoup, mais c'est du
 * bruit. Afficher une aiguille franche sur du bruit serait le pire des deux mondes.
 */
function AngleDial({ rad, live }: { rad: number; live: boolean }): ReactNode {
  // Zero en haut, sens horaire — la convention d'un cadran, pas celle du cercle
  // trigonometrique : c'est l'arbre qu'on regarde, pas une equation.
  const a = rad - Math.PI / 2;
  const x = 22 + 16 * Math.cos(a);
  const y = 22 + 16 * Math.sin(a);
  return (
    <svg viewBox="0 0 44 44" className="h-11 w-11 shrink-0" aria-hidden="true">
      <circle cx="22" cy="22" r="18" fill="none" strokeWidth="1"
        className={live ? 'stroke-line' : 'stroke-line-soft'} />
      <line x1="22" y1="22" x2={x} y2={y} strokeWidth="2" strokeLinecap="round"
        className={live ? 'stroke-accent' : 'stroke-fg-3'} />
      <circle cx="22" cy="22" r="1.5" className={live ? 'fill-accent' : 'fill-fg-3'} />
    </svg>
  );
}

/**
 * L'absence d'aimant merite une banniere et pas une pastille.
 *
 * Sans aimant diametral en face du capteur, l'angle renvoye est du bruit — et rien d'autre
 * dans l'interface ne le dirait. C'est un prerequis de M3 : on ne veut pas le decouvrir en
 * lancant un asservissement de position.
 */
function MagnetWarning({ enc }: { enc: EncoderState }): ReactNode {
  // Bits du registre STATUS de l'AS5600 : MH bit3, ML bit4, MD bit5.
  const tooStrong = (enc.statusRaw & 0x08) !== 0;
  const tooWeak = (enc.statusRaw & 0x10) !== 0;
  return (
    <section className="rounded-[4px] border border-warn/50 bg-panel px-3 py-2">
      <div className="flex items-baseline gap-2">
        <Dot tone="warn" />
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-warn">
          No usable magnet on the position sensor
        </h3>
        <span className="font-mono text-[11px] text-fg-3">
          STATUS 0x{enc.statusRaw.toString(16).toUpperCase().padStart(2, '0')}
          {tooWeak ? ' — too weak or absent' : tooStrong ? ' — too strong' : ''}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-fg-3">
        The sensor answers and the I&sup2;C chain is healthy, but the angle it returns is noise.
        A diametrically magnetised magnet has to sit on the shaft, on axis, before any position
        or velocity loop means anything. The link itself is fine &mdash; this reading is the
        sensor telling the truth about what it can see.
      </p>
    </section>
  );
}

function PositionSensor({ enc }: { enc: EncoderState }): ReactNode {
  const live = enc.present && enc.magnetOk;
  const deg = ((enc.posRad * 180) / Math.PI) % 360;
  return (
    <Panel title="Position sensor">
      <div className="flex items-center gap-3 px-3 py-2">
        <AngleDial rad={enc.posRad} live={live} />
        <div className="min-w-0">
          <div className="font-mono text-[18px] leading-none text-fg">
            {live ? `${deg.toFixed(1)}°` : '—'}
          </div>
          <div className="mt-1 font-mono text-[11px] text-fg-3">
            {live ? `${enc.velRadS.toFixed(2)} rad/s · turn ${enc.turns}` : 'no angle to report'}
          </div>
        </div>
        <div className="ml-auto">
          <Pill tone={!enc.present ? 'fault' : enc.magnetOk ? 'ok' : 'warn'}>
            {!enc.present ? 'not answering' : enc.magnetOk ? 'magnet ok' : 'no magnet'}
          </Pill>
        </div>
      </div>
      <Row
        label="Sample age, worst seen"
        right={
          <>
            <span className="font-mono text-[12px] text-fg">{enc.ageMaxUs} µs</span>
            {/* Un tour de boucle vaut 50 µs. Au-dela de deux, l'extrapolation travaille sur
                du vieux et le plafond de vitesse exploitable descend. */}
            <Pill tone={enc.ageMaxUs > 500 ? 'warn' : 'ok'}>
              {enc.ageMaxUs > 500 ? 'stale' : 'fresh'}
            </Pill>
          </>
        }
      />
      <Row
        label="I²C chain"
        right={
          <>
            <span className="font-mono text-[12px] text-fg-3">
              {(enc.busHz / 1000).toFixed(0)} kHz · {enc.xferUs} µs per read · every{' '}
              {enc.periodUs} µs
            </span>
            <Pill tone={enc.readsErr > 0 ? 'warn' : 'ok'}>
              {enc.readsErr === 0 ? 'no errors' : `${enc.readsErr} errors`}
            </Pill>
          </>
        }
      />
      <p className="border-t border-line-soft px-3 py-2 text-[11px] leading-relaxed text-fg-3">
        The angle is extrapolated to the instant the control loop asks for it, from the last
        sample and its timestamp. What it cannot undo is the sensor&rsquo;s own 286 µs settling
        time &mdash; that one is the floor, and it is what caps usable speed.
      </p>
    </Panel>
  );
}

function ReferenceWarning({ spread }: { spread: number }): ReactNode {
  return (
    <section className="rounded-[4px] border border-fault/50 bg-panel px-3 py-2">
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
        The rails themselves may well be steady — this is the reference moving, not the supply.
        <span className="font-mono text-fg-2"> VREF.RATIO </span> in the console converts VREFINT
        and a rail back to back; their ratio cancels VREF+, so it tells you whether the rail is
        sound and the reference alone is at fault.
      </p>
    </section>
  );
}

/**
 * Decoupe le tableau de bord en trois regions, au lieu d'un seul flot.
 *
 * C'est le coeur de la mise en page. Ces trois familles n'ont ni la meme duree de vie ni le
 * meme besoin de surface, et les melanger dans une grille unique etait le probleme : un
 * panneau court se retrouvait etire a la hauteur de son voisin, et le trace — la seule
 * chose qu'on regarde vraiment en reglant — etait enterre au milieu d'un long defilement.
 */
function liveRegions(
  state: DeviceSnapshot,
  mon: MonitorState,
): { banners: ReactNode; metrics: ReactNode; details: ReactNode } {
  const sf = state.safety;
  const enc = state.encoder;
  // Le nominal vient du dictionnaire que le firmware publie, jamais d'une constante
  // recopiee ici (AGENTS.md §3). La carte a ete retouchee le 2026-09-21 et sa reference
  // est passee de 2,048 V a 3,3 V : une valeur en dur aurait affiche `VREF+` en faute
  // permanente, ce qui revient a eteindre l'alarme en la laissant sonner tout le temps.
  const vrefNominalMv = state.params.find((p) => p.name === 'board.vref_mv')?.value ?? null;
  const refUnstable =
    mon.vrefSpreadPermille !== null && mon.vrefSpreadPermille > VREF_UNSTABLE_PERMILLE;
  // Le tourniquet de mesure doit avancer. Figé, toutes les valeurs ci-dessous sont celles
  // du dernier tour publié, et les montrer comme vivantes serait un mensonge.
  const stalled = mon.rounds === 0;

  return {
    banners: (
      <>
        {refUnstable && <ReferenceWarning spread={mon.vrefSpreadPermille!} />}
        {enc !== null && enc.present && !enc.magnetOk && <MagnetWarning enc={enc} />}
      </>
    ),
    /* Bande d'etat : quatre chiffres qu'on lit d'un coup d'oeil, hauteur fixe. Ils ne
       doivent jamais disputer de la place au trace — c'est leur role d'etre petits. */
    metrics: (
      <>
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
      </>
    ),
    /* Detail : ce qu'on consulte quand un chiffre de la bande surprend. Ces panneaux ont
       des hauteurs tres differentes — c'est pour ca qu'ils vivent dans une colonne qui
       defile pour elle-meme, et non dans une grille ou le plus court herite du vide du
       plus haut. */
    details: (
      <>

      <Panel title="Rails and protection">
        <Rail label="5 V rail" mv={mon.v5Mv} nominalMv={5000} />
        <Rail label="3V3 rail" mv={mon.v3v3Mv} nominalMv={3300} />
        <Row
          label="Analog reference VREF+"
          right={
            <>
              <span className="font-mono text-[12px] text-fg">
                {(mon.vrefMv / 1000).toFixed(3)} V
              </span>
              <Pill
                tone={
                  refUnstable
                    ? 'fault'
                    : vrefNominalMv === null
                      ? 'idle'
                      : railHealth(mon.vrefMv, vrefNominalMv)
                }
              >
                {refUnstable
                  ? `unstable ±${(mon.vrefSpreadPermille! / 20).toFixed(1)} %`
                  : vrefNominalMv === null
                    ? 'measured'
                    : railHealth(mon.vrefMv, vrefNominalMv) === 'ok'
                      ? 'ok'
                      : `off nominal ${(vrefNominalMv / 1000).toFixed(3)} V`}
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

      <Panel title="Current sense inputs">
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

      {/* Absent d'un firmware anterieur a l'etape 6 : on ne montre pas un panneau vide, la
          difference entre « pas de capteur dans ce firmware » et « capteur muet » compte. */}
      {enc !== null && <PositionSensor enc={enc} />}
      </>
    ),
  };
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

  const regions =
    monitor === null ? null : liveRegions(state, monitor);

  return (
    /* Deux regions, deux regles de dimensionnement, deux defilements.
     *
     * La version precedente etait une seule grille de quatre colonnes ou tout cohabitait :
     * les lignes s'etirent sur le panneau le plus haut, donc un panneau court heritait
     * d'une grande zone morte, `Position sensor` occupait deux colonnes sur quatre et
     * restait seul sur sa ligne, et le trace etait enterre au milieu d'un long defilement.
     *
     * Desormais l'instrument est a gauche et prend **toute la hauteur restante** — plus de
     * hauteur magique en `vh` : ce qui reste, c'est ce qui reste. Le detail est a droite,
     * dans une colonne etroite qui defile pour elle-meme, ou des panneaux de hauteurs tres
     * differentes peuvent coexister sans se disputer la place.
     *
     * En dessous de `xl` il n'y a pas la largeur pour deux colonnes : on repasse en une
     * seule, la page defile, et le trace reprend une hauteur relative a la fenetre. */
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3 xl:overflow-hidden">
      {regions === null ? (
        <Panel title="Board monitoring">
          <p className="px-3 py-3 text-[12px] text-fg-3">
            Waiting for the first reading from the board.
          </p>
        </Panel>
      ) : (
        regions.banners
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 xl:flex-row">
        {/* Instrument */}
        <section className="flex min-h-0 flex-col gap-3 xl:flex-1">
          {regions !== null && (
            <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4">
              {regions.metrics}
            </div>
          )}
          <div className="h-[55vh] min-h-0 xl:h-auto xl:flex-1">
            <LiveTelemetry state={state} />
          </div>
        </section>

        {/* Detail et identification */}
        <aside className="flex flex-col gap-3 xl:w-[23rem] xl:shrink-0 xl:overflow-auto xl:pr-0.5">
          {regions !== null && regions.details}

      {/* Identification : on la lit une fois, elle tient en un panneau et passe en dessous. */}
      <Panel title="Device">
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
          The firmware only raises a bit once the feature actually exists. A missing capability is
          not a failure — it is a milestone not yet reached.
        </p>
      </Panel>
        </aside>
      </div>
    </div>
  );
}
