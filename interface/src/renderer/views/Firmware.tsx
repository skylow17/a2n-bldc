/**
 * Firmware — mise à jour A/B sans sonde.
 *
 * C'est la seule action de l'interface qui puisse rendre une carte muette. Trois choses en
 * découlent, et elles expliquent tout ce qui suit :
 *
 * - **On ne programme jamais le slot actif.** Le firmware qui tourne reste intact ; la
 *   nouvelle image va dans l'autre slot, et n'est essayée qu'au redémarrage suivant. Si elle
 *   ne confirme pas sa bonne santé en deux secondes, la carte repart sur l'ancienne toute
 *   seule. L'écran le dit avant, pas après.
 * - **La confirmation est explicite et cite le fichier.** Un bouton « Update » qui programme
 *   au premier clic est un bouton qu'on presse par erreur.
 * - **Les phases sont nommées.** Une mise à jour traverse trois redémarrages : la carte
 *   disparaît du bus, revient, redisparaît. Sans dire laquelle est en cours, une déconnexion
 *   parfaitement normale se lit comme une panne, et on débranche au pire moment.
 *
 * Libellés en anglais (AGENTS.md §5) ; commentaires en français.
 */

import { useEffect, useState, type ReactNode } from 'react';

import type { DeviceSnapshot, FirmwareProgress } from '../../main/device/DeviceCore.js';
import { Button, Empty, Panel } from '../components/ui.js';
import { api, useAction } from '../useDevice.js';

/** Ce que l'utilisateur a désigné, tant qu'il ne l'a pas programmé. */
interface Chosen {
  path: string;
  size: number;
}

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * Le nom du fichier suffit à repérer une erreur de slot.
 *
 * Une image bâtie pour le slot A écrite dans le slot B a un CRC parfaitement juste et saute
 * dans le vide : le bootloader la refuse sur ses vecteurs, mais mieux vaut le voir ici que
 * de le découvrir après avoir attendu la probation.
 */
function slotHint(path: string): string | null {
  const n = baseName(path).toLowerCase();
  if (n.includes('slot-a')) return 'A';
  if (n.includes('slot-b')) return 'B';
  return null;
}

const PHASE_LABEL: Record<FirmwareProgress['phase'], string> = {
  entering: 'Entering the bootloader',
  erasing: 'Erasing the inactive slot',
  writing: 'Writing',
  verifying: 'Verifying CRC',
  rebooting: 'Restarting on the candidate',
  confirming: 'Waiting for the candidate to confirm',
  done: 'Done',
  failed: 'Failed',
};

function SlotTable({ progress }: { progress: FirmwareProgress | null }): ReactNode {
  const target = progress?.slot ?? null;
  return (
    <table className="w-full font-mono text-[11px]">
      <thead>
        <tr className="text-left text-fg-3">
          <th className="py-1 font-medium">Slot</th>
          <th className="py-1 font-medium">Address</th>
          <th className="py-1 font-medium">Capacity</th>
          <th className="py-1 font-medium">Role</th>
        </tr>
      </thead>
      <tbody>
        {[
          { name: 'A', addr: '0x08008000' },
          { name: 'B', addr: '0x08040000' },
        ].map((s, i) => (
          <tr key={s.name} className="border-t border-line-soft">
            <td className="py-1">{s.name}</td>
            <td className="py-1 text-fg-2">{s.addr}</td>
            <td className="py-1 text-fg-2">224 KiB</td>
            <td className="py-1 text-fg-2">
              {target === i ? 'target of this update' : target === null ? '—' : 'left untouched'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProgressBar({ progress }: { progress: FirmwareProgress }): ReactNode {
  // La phase d'écriture a un pourcentage ; les autres n'en ont pas, et une barre qui
  // resterait figée à 0 % pendant l'attente de probation ferait croire à un blocage.
  const pct =
    progress.total > 0 ? Math.round((progress.written * 100) / progress.total) : null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-fg-2">{PHASE_LABEL[progress.phase]}</span>
        {pct !== null && <span className="font-mono text-fg-3">{pct} %</span>}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-raise">
        <div
          className={`h-full transition-[width] duration-150 ${
            progress.phase === 'failed' ? 'bg-fault' : 'bg-accent'
          }`}
          style={{
            width:
              pct !== null
                ? `${pct}%`
                : progress.phase === 'done' || progress.phase === 'failed'
                  ? '100%'
                  : '100%',
            opacity: pct === null && progress.phase !== 'done' && progress.phase !== 'failed' ? 0.35 : 1,
          }}
        />
      </div>
      <p className="font-mono text-[10px] text-fg-3">{progress.message}</p>
    </div>
  );
}

export function Firmware({ state }: { state: DeviceSnapshot }): ReactNode {
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [version, setVersion] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<FirmwareProgress | null>(null);
  const pick = useAction();
  const update = useAction();

  useEffect(() => api().onFirmware(setProgress), []);

  if (state.connection !== 'connected') {
    return (
      <Empty
        title="No device connected"
        hint="Connect a board or the simulator to update its firmware."
      />
    );
  }

  const running =
    progress !== null && progress.phase !== 'done' && progress.phase !== 'failed';
  const hint = chosen === null ? null : slotHint(chosen.path);

  const choose = (): void => {
    void pick.run(async () => {
      const file = await api().pickFirmware();
      if (file === null) return;
      setChosen(file);
      setConfirming(false);
      setProgress(null);
      // Le nom du fichier ne porte pas la version : la demander évite d'écrire « 0.0.0 »
      // dans les métadonnées et de ne plus savoir, six mois plus tard, ce qui tourne.
      if (version === '') setVersion('');
    });
  };

  const start = (): void => {
    if (chosen === null) return;
    void update.run(async () => {
      setConfirming(false);
      await api().updateFirmware(chosen.path, version.trim());
    });
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3">
      <Panel title="A/B update">
        <div className="flex flex-col gap-3">
          <p className="max-w-[70ch] text-[11px] leading-relaxed text-fg-2">
            The image is written to the <strong>inactive</strong> slot; the firmware running
            now is never touched. On the next restart the board tries the new image — if it
            does not prove itself healthy within two seconds, it rolls back on its own. A
            failed update costs a restart, not a board.
          </p>

          <SlotTable progress={progress} />
        </div>
      </Panel>

      <Panel title="Image">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={choose} disabled={running || pick.busy}>
              Choose a .bin file…
            </Button>
            {chosen !== null && (
              <span className="font-mono text-[11px] text-fg-2">
                {baseName(chosen.path)}{' '}
                <span className="text-fg-3">({chosen.size.toLocaleString()} bytes)</span>
              </span>
            )}
          </div>

          {chosen !== null && (
            <>
              <label className="flex items-center gap-2 text-[11px] text-fg-2">
                <span className="whitespace-nowrap">Version</span>
                <input
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="2.1.0"
                  maxLength={16}
                  disabled={running}
                  className="w-40 rounded-[3px] border border-line bg-raise px-1.5 py-1 font-mono text-[11px] text-fg outline-none disabled:opacity-40"
                />
                <span className="text-fg-3">
                  stored in the slot metadata, 16 characters max
                </span>
              </label>

              {hint !== null && (
                // Le bootloader refuserait de toute façon sur les vecteurs, mais après
                // l'effacement et l'écriture complète — autant le dire tout de suite.
                <p className="text-[11px] text-fg-3">
                  This file looks built for slot {hint}. It will only be accepted if slot{' '}
                  {hint} is the inactive one.
                </p>
              )}
            </>
          )}

          {pick.error !== null && <p className="text-[11px] text-fault">{pick.error}</p>}
        </div>
      </Panel>

      <Panel title="Program">
        <div className="flex flex-col gap-3">
          {!confirming && !running && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                tone="danger"
                disabled={chosen === null || version.trim() === '' || update.busy}
                onClick={() => setConfirming(true)}
              >
                Update firmware…
              </Button>
              {chosen !== null && version.trim() === '' && (
                <span className="text-[11px] text-fg-3">Give the image a version first.</span>
              )}
            </div>
          )}

          {confirming && chosen !== null && (
            // La confirmation cite le fichier et la version : c'est ce qui distingue un
            // accord éclairé d'un deuxième clic réflexe au même endroit.
            <div className="flex flex-col gap-2 rounded-[3px] border border-fault/40 bg-raise p-2.5">
              <p className="text-[11px] leading-relaxed text-fg">
                Write <strong className="font-mono">{baseName(chosen.path)}</strong> as version{' '}
                <strong className="font-mono">{version.trim()}</strong> to the inactive slot?
                The board will restart three times and be unreachable for a few seconds.
                <strong> Do not unplug it.</strong>
              </p>
              <div className="flex gap-2">
                <Button tone="danger" onClick={start}>
                  Yes, program it
                </Button>
                <Button onClick={() => setConfirming(false)}>Cancel</Button>
              </div>
            </div>
          )}

          {progress !== null && <ProgressBar progress={progress} />}

          {update.error !== null && !running && (
            <p className="text-[11px] text-fault">{update.error}</p>
          )}
        </div>
      </Panel>
    </div>
  );
}
