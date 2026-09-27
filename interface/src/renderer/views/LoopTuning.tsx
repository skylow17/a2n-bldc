/**
 * Réglage des boucles de vitesse et de position, dans la vue Control : la « rigidité » de
 * l'arbre selon ce qu'on veut en faire.
 *
 * Les réglages sont des paramètres du dictionnaire (`ctrl.*`, `docs/protocol.md` §5) : leurs
 * noms, unités et bornes viennent du firmware, rien n'est recopié ici. Les profils Soft /
 * Balanced / Stiff sont des recettes partielles (`shared/recipe.ts`) qui passent par le même
 * diff que la vue Recipes : on voit ce qui va changer avant d'écrire.
 *
 * Les valeurs sont lues au **lancement** de `SL` et de `PL` : écrites pendant une boucle en
 * cours, elles ne prennent effet qu'au lancement suivant — le panneau le dit.
 */

import { useState, type ReactNode } from 'react';

import type { DeviceSnapshot } from '../../main/device/DeviceCore.js';
import { PARAM_FLAG } from '../../shared/params.js';
import { BUILTIN_PROFILES, diffRecipe, type Recipe, type RecipeDiff } from '../../shared/recipe.js';
import { Pill } from '../components/Metric.js';
import { Button, Panel, fmt } from '../components/ui.js';
import { applyRows, deviceParams, type ApplyResult } from '../recipeApply.js';
import { api, useAction } from '../useDevice.js';

/** Préfixe des réglages de boucle dans le dictionnaire. Tout ce qui le porte est affiché. */
const LOOP_PREFIX = 'ctrl.';

function isActive(diff: RecipeDiff): boolean {
  return diff.rows.length > 0 && diff.rows.every((r) => r.status === 'same');
}

function ParamRow({
  p,
  busy,
  onWrite,
}: {
  p: DeviceSnapshot['params'][number];
  busy: boolean;
  onWrite: (v: number) => void;
}): ReactNode {
  const [draft, setDraft] = useState('');
  const calibrated = (p.flags & PARAM_FLAG.CALIBRATED) !== 0;
  const commit = (): void => {
    const v = Number(draft.trim().replace(',', '.'));
    if (draft.trim() !== '' && Number.isFinite(v)) {
      onWrite(v);
      setDraft('');
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5">
      <span className="min-w-0 truncate font-mono text-[11px] text-fg-2" title={p.name}>
        {p.name}
        {calibrated && <span className="ml-1.5 text-fg-3">measured</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="w-20 text-right font-mono text-[12px] text-fg">{fmt(p.value, 4)}</span>
        <input
          className="w-20 rounded-[3px] border border-line bg-raise px-2 py-0.5 text-right font-mono text-[12px] text-fg outline-none focus:border-fg-3 disabled:opacity-40"
          placeholder={`${fmt(p.min, 3)}…${fmt(p.max, 3)}`}
          value={draft}
          disabled={busy}
          inputMode="decimal"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
        <span className="w-14 font-mono text-[11px] text-fg-3">{p.unit}</span>
        <Button disabled={busy || draft.trim() === ''} onClick={commit}>
          Set
        </Button>
      </span>
    </div>
  );
}

export function LoopTuning({ state }: { state: DeviceSnapshot }): ReactNode {
  const act = useAction();
  const [preview, setPreview] = useState<{ profile: Recipe; diff: RecipeDiff } | null>(null);
  const [results, setResults] = useState<ApplyResult[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const loopParams = state.params.filter((p) => p.name.startsWith(LOOP_PREFIX));
  const params = deviceParams(state);
  const hash = state.info?.paramDictHash ?? null;
  const live = state.safety?.outputsLive === true;

  if (loopParams.length === 0) {
    return (
      <Panel title="Loop tuning" className="xl:col-span-2">
        <p className="px-3 py-2 text-[12px] text-fg-3">
          This firmware exposes no loop settings: speed and position loops run at their
          compiled defaults.
        </p>
      </Panel>
    );
  }

  const profiles = BUILTIN_PROFILES.map((profile) => ({ profile, diff: diffRecipe(profile, params, hash) }));

  const write = (name: string, v: number): void =>
    void act.run(async () => {
      setSaved(null);
      const after = await api().writeParam(name, v);
      setResults([{ name, ok: true, detail: String(after) }]);
    });

  return (
    <Panel
      title="Loop tuning"
      className="xl:col-span-2"
      {...(live ? { right: <Pill tone="warn">applies at next start</Pill> } : {})}
    >
      <p className="px-3 py-2 text-[12px] leading-relaxed text-fg-2">
        How stiff the shaft is held. A stiffer setting rejects a load torque faster and holds
        position tighter; a softer one is gentler on the mechanics and quieter. Settings are
        read when a speed or position loop starts. They never widen a limit: speed, current
        and duration caps stay in the firmware.
      </p>

      <div className="grid grid-cols-1 gap-2 px-3 pb-2 md:grid-cols-3">
        {profiles.map(({ profile, diff }) => {
          const active = isActive(diff);
          const usable = diff.rows.some((r) => r.status !== 'unknown');
          return (
            <button
              key={profile.name}
              type="button"
              disabled={act.busy || !usable}
              onClick={() => {
                setResults(null);
                setSaved(null);
                setPreview({ profile, diff });
              }}
              className={`rounded-[3px] border px-3 py-2 text-left transition-colors disabled:opacity-40 ${
                active ? 'border-accent bg-accent/10' : 'border-line bg-raise hover:border-fg-3'
              }`}
            >
              <span className="flex items-center justify-between">
                <span className="text-[12px] font-semibold text-fg">{profile.name}</span>
                {active && <span className="font-mono text-[10px] text-accent">current</span>}
              </span>
              <span className="mt-1 block text-[11px] leading-snug text-fg-3">{profile.description}</span>
            </button>
          );
        })}
      </div>

      {preview !== null && (
        <div className="mx-3 mb-2 rounded-[3px] border border-line bg-raise p-2">
          <p className="pb-1 text-[12px] text-fg-2">
            Profile <strong className="text-fg">{preview.profile.name}</strong>:
          </p>
          {preview.diff.rows.map((r) => (
            <p key={r.name} className="font-mono text-[11px] text-fg-2">
              {r.name}{' '}
              {r.status === 'change' && (
                <>
                  {fmt(r.device, 4)} → <span className="text-accent">{fmt(r.file, 4)}</span> {r.unit}
                </>
              )}
              {r.status === 'same' && <span className="text-fg-3">unchanged ({fmt(r.file, 4)})</span>}
              {r.status === 'unknown' && <span className="text-fault">not in this firmware — skipped</span>}
              {r.status === 'out_of_range' && <span className="text-fault">outside this firmware's bounds — skipped</span>}
              {r.status === 'read_only' && <span className="text-fault">read-only here — skipped</span>}
            </p>
          ))}
          <div className="flex gap-2 pt-2">
            <Button
              tone="accent"
              disabled={act.busy || !preview.diff.rows.some((r) => r.status === 'change')}
              onClick={() =>
                void act.run(async () => {
                  const names = new Set(preview.diff.rows.map((r) => r.name));
                  setResults(await applyRows(preview.profile, preview.diff.rows, names));
                  setPreview(null);
                })
              }
            >
              Apply
            </Button>
            <Button disabled={act.busy} onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {loopParams.map((p) => (
        <ParamRow key={p.id} p={p} busy={act.busy} onWrite={(v) => write(p.name, v)} />
      ))}

      <div className="flex items-center gap-2 px-3 py-2">
        <Button
          disabled={act.busy}
          title="Written values live in RAM until saved: a reset brings back the saved ones"
          onClick={() =>
            void act.run(async () => {
              const r = await api().saveNvm();
              setSaved(`Saved to flash: ${r.saved} entries, record ${r.seq}.`);
            })
          }
        >
          Save to flash
        </Button>
        <span className="text-[11px] text-fg-3">
          The inertia is a measurement of what is mounted: raise it when a load is added, or
          the loops will be slower than set.
        </span>
      </div>

      {results !== null &&
        results.map((r) => (
          <p key={r.name} className={`px-3 font-mono text-[11px] ${r.ok ? 'text-fg-3' : 'text-fault'}`}>
            {r.name} {r.ok ? `= ${r.detail}` : `refused: ${r.detail}`}
          </p>
        ))}
      {saved !== null && <p className="px-3 py-1 font-mono text-[11px] text-fg-3">{saved}</p>}
      {act.error !== null && <p className="px-3 py-1 font-mono text-[11px] text-fault">{act.error}</p>}
    </Panel>
  );
}
