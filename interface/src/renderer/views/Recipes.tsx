/**
 * Vue Recipes — jeux de paramètres enregistrés sur le PC (`interface/AGENTS.md` §4).
 *
 * Trois sources : un fichier `.a2nrcp`, l'état courant du device (capture), ou un profil
 * intégré. Quelle qu'en soit l'origine, une recette ne s'applique jamais en aveugle :
 *
 *  - un diff `File | Device | Δ` d'abord, une ligne par entrée — les inconnues, les
 *    lectures seules et les hors-bornes restent **listées**, jamais ignorées en silence ;
 *  - les valeurs calibrées ne sont pas cochées d'office : une recette venue d'une autre
 *    carte porte sa calibration, pas la nôtre ;
 *  - un dictionnaire différent (`param_dict_hash`) bloque l'écriture derrière une
 *    confirmation explicite ;
 *  - écrire (RAM) et « Save to flash » sont deux actions distinctes.
 *
 * Aucune borne n'est vérifiée ici qui ne vienne du dictionnaire du device, et le firmware
 * reste seul juge de chaque écriture.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import type { DeviceSnapshot } from '../../main/device/DeviceCore.js';
import {
  BUILTIN_PROFILES,
  captureRecipe,
  defaultSelection,
  diffRecipe,
  formatDictHash,
  parseRecipe,
  recipeFileName,
  serializeRecipe,
  type DiffRow,
  type Recipe,
} from '../../shared/recipe.js';
import { Hint } from '../components/Hint.js';
import { Pill } from '../components/Metric.js';
import { Button, Field, Panel, fmt } from '../components/ui.js';
import { applyRows, deviceParams, type ApplyResult } from '../recipeApply.js';
import { api, useAction } from '../useDevice.js';

interface Loaded {
  recipe: Recipe;
  /** D'où elle vient, pour l'afficher : chemin, « captured », « built-in ». */
  source: string;
}

const NOTE: Record<DiffRow['status'], string> = {
  same: 'unchanged',
  change: '',
  unknown: 'not in this firmware — never written',
  read_only: 'read-only on this firmware',
  out_of_range: "outside this firmware's bounds — refused",
};

function inputClass(extra = ''): string {
  return `rounded-[3px] border border-line bg-raise px-2 py-1 text-[12px] text-fg outline-none focus:border-fg-3 disabled:opacity-40 ${extra}`;
}

export function Recipes({ state }: { state: DeviceSnapshot }): ReactNode {
  const connected = state.connection === 'connected';
  const act = useAction();

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showSame, setShowSame] = useState(false);
  const [confirmMismatch, setConfirmMismatch] = useState(false);
  const [results, setResults] = useState<ApplyResult[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [captureName, setCaptureName] = useState('');
  const [captureDesc, setCaptureDesc] = useState('');

  const params = useMemo(() => deviceParams(state), [state]);
  const deviceHash = connected ? (state.info?.paramDictHash ?? null) : null;
  const diff = loaded === null ? null : diffRecipe(loaded.recipe, connected ? params : [], deviceHash);

  /* La sélection se refait à chaque recette chargée — pas à chaque rafraîchissement du
   * device, qui déferait les choix de l'utilisateur pendant qu'il les fait. */
  const recipeKey = loaded === null ? null : `${loaded.source}|${loaded.recipe.created}|${loaded.recipe.name}`;
  useEffect(() => {
    if (loaded === null) return;
    setSelected(defaultSelection(diffRecipe(loaded.recipe, params, deviceHash)));
    setConfirmMismatch(false);
    setResults(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipeKey]);

  const load = (recipe: Recipe, source: string): void => {
    setNote(null);
    setLoaded({ recipe, source });
  };

  const openFile = (): void =>
    void act.run(async () => {
      const f = await api().openRecipe();
      if (f === null) return;
      const parsed = parseRecipe(f.text);
      if (!parsed.ok) throw new Error(`${f.path}: ${parsed.error}`);
      load(parsed.recipe, f.path);
    });

  const capture = (): void => {
    if (state.info === null) return;
    const name = captureName.trim() || `${state.info.fwVersion}-${new Date().toISOString().slice(0, 10)}`;
    load(captureRecipe(name, state.info, params, new Date(), captureDesc.trim()), 'captured from the device');
  };

  const saveAs = (): void =>
    void act.run(async () => {
      if (loaded === null) return;
      const path = await api().saveText(recipeFileName(loaded.recipe.name), serializeRecipe(loaded.recipe));
      if (path !== null) setNote(`Saved ${path}`);
    });

  const rows = diff?.rows ?? [];
  const visible = rows.filter((r) => showSame || r.status !== 'same');
  const sameCount = rows.filter((r) => r.status === 'same').length;
  const toWrite = rows.filter((r) => r.status === 'change' && selected.has(r.name));
  const mismatch = diff?.hashMatch === false;
  const canWrite = connected && toWrite.length > 0 && (!mismatch || confirmMismatch) && !act.busy;

  const toggle = (name: string): void =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  return (
    <div className="flex h-full min-h-0 gap-3 p-3">
      {/* Sources */}
      <div className="flex w-72 shrink-0 flex-col gap-3 overflow-auto">
        <Panel title="Open" hint={<>A <span className="font-mono">.a2nrcp</span> file: readable JSON, diffable under git. Nothing is written until you have seen the diff.</>}>
          <div className="flex flex-col gap-2 p-3">
            <Button onClick={openFile} disabled={act.busy}>
              Open a recipe file…
            </Button>
          </div>
        </Panel>

        <Panel title="Capture" hint={<>Every writable value the board holds right now, with its dictionary hash. Then “Save recipe as…” to keep it.</>}>
          <div className="flex flex-col gap-2 p-3">
            <input
              className={inputClass()}
              placeholder="Name (e.g. bench-bare-rotor)"
              value={captureName}
              maxLength={64}
              onChange={(e) => setCaptureName(e.target.value)}
            />
            <textarea
              className={inputClass('h-16 resize-none')}
              placeholder="Description (optional)"
              value={captureDesc}
              maxLength={2000}
              onChange={(e) => setCaptureDesc(e.target.value)}
            />
            <Button disabled={!connected || state.info === null || act.busy} onClick={capture}>
              Capture from the device
            </Button>
          </div>
        </Panel>

        <Panel title="Built-in profiles" hint={<>Partial recipes: they name only the loop settings and apply by name on any firmware that has them.</>}>
          <div className="flex flex-col gap-1 p-2">
            {BUILTIN_PROFILES.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => load(p, 'built-in profile')}
                className={`rounded-[3px] px-2 py-1.5 text-left transition-colors hover:bg-panel-2 ${
                  loaded?.recipe === p ? 'bg-accent/15 text-accent' : 'text-fg-2'
                }`}
              >
                <span className="block text-[12px]">{p.name}</span>
                <span className="block text-[11px] leading-snug text-fg-3">{p.description}</span>
              </button>
            ))}
          </div>
        </Panel>
      </div>

      {/* Recette et diff */}
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto">
        {loaded === null || diff === null ? (
          <Panel title="Recipe">
            <p className="px-3 py-6 text-center text-[12px] text-fg-3">
              Open a file, capture the device, or pick a built-in profile.
            </p>
            {act.error !== null && <p className="px-3 pb-3 font-mono text-[11px] text-fault">{act.error}</p>}
          </Panel>
        ) : (
          <>
            <Panel
              title={`Recipe — ${loaded.recipe.name}`}
              right={
                <Pill tone={diff.hashMatch === null ? 'idle' : diff.hashMatch ? 'ok' : 'warn'}>
                  {loaded.recipe.param_dict_hash === undefined
                    ? 'partial — by name'
                    : diff.hashMatch === null
                      ? 'no device'
                      : diff.hashMatch
                        ? 'same dictionary'
                        : 'different dictionary'}
                </Pill>
              }
            >
              {loaded.recipe.description !== undefined && (
                <p className="px-3 py-2 text-[12px] leading-relaxed text-fg-2">{loaded.recipe.description}</p>
              )}
              <Field label="Source">{loaded.source}</Field>
              {loaded.recipe.created !== '' && <Field label="Created">{loaded.recipe.created}</Field>}
              {loaded.recipe.fw_version !== undefined && <Field label="Firmware">{loaded.recipe.fw_version}</Field>}
              <Field label="Dictionary hash, file / device">
                {`${loaded.recipe.param_dict_hash ?? '—'} / ${deviceHash === null ? '—' : formatDictHash(deviceHash)}`}
              </Field>
              <div className="flex gap-2 px-3 py-2">
                <Button onClick={saveAs} disabled={act.busy}>
                  Save recipe as…
                </Button>
              </div>
              {note !== null && <p className="px-3 pb-2 font-mono text-[11px] text-fg-3">{note}</p>}
            </Panel>

            <Panel
              title="Diff"
              right={
                <label className="flex items-center gap-1.5 text-[11px] text-fg-3">
                  <input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} />
                  show {sameCount} unchanged
                </label>
              }
            >
              {!connected && (
                <p className="px-3 py-2 text-[12px] text-fg-3">
                  No device connected: the file is shown alone. Connect to compare and write.
                </p>
              )}
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr className="border-b border-line-soft text-left text-[11px] uppercase tracking-wider text-fg-3">
                    <th className="w-8 px-3 py-1.5" />
                    <th className="px-2 py-1.5 font-normal">Parameter</th>
                    <th className="px-2 py-1.5 text-right font-normal">File</th>
                    <th className="px-2 py-1.5 text-right font-normal">Device</th>
                    <th className="px-2 py-1.5 text-right font-normal">Δ</th>
                    <th className="px-2 py-1.5 font-normal">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const writable = r.status === 'change';
                    const delta = r.device === null ? null : r.file - r.device;
                    return (
                      <tr key={r.name} className="border-b border-line-soft/50 odd:bg-panel-2/40">
                        <td className="px-3 py-1">
                          <input
                            type="checkbox"
                            disabled={!writable || !connected}
                            checked={writable && selected.has(r.name)}
                            onChange={() => toggle(r.name)}
                          />
                        </td>
                        <td className="px-2 py-1 font-mono text-[11px] text-fg">{r.name}</td>
                        <td className="px-2 py-1 text-right font-mono text-fg">
                          {fmt(r.file, 6)} <span className="text-fg-3">{r.unit}</span>
                        </td>
                        <td className="px-2 py-1 text-right font-mono text-fg-2">{fmt(r.device, 6)}</td>
                        <td className="px-2 py-1 text-right font-mono text-fg-3">
                          {r.status === 'change' && delta !== null ? fmt(delta, 4) : ''}
                        </td>
                        <td
                          className={`px-2 py-1 text-[11px] ${
                            r.status === 'change' || r.status === 'same' ? 'text-fg-3' : 'text-fault'
                          }`}
                        >
                          {connected ? NOTE[r.status] : ''}
                          {r.calibrated && r.status === 'change' && (
                            <span className="text-accent">measured on this board — overwrite only on purpose</span>
                          )}
                          {r.requiresDisarm && r.status === 'change' && state.safety?.outputsLive === true && (
                            <span className="text-fault"> refused while outputs are live</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-3 text-center text-[12px] text-fg-3">
                        {rows.length === 0 ? 'This recipe names no parameter.' : 'Everything matches the device.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              {mismatch && (
                <label className="mx-3 mt-3 flex items-start gap-2 rounded-[3px] border border-fault/60 p-2 text-[12px] text-fg-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={confirmMismatch}
                    onChange={(e) => setConfirmMismatch(e.target.checked)}
                  />
                  <span>
                    This recipe was made for a different parameter dictionary. Names, units or
                    bounds may have changed meaning since. I have checked the diff and want to
                    write the selected values anyway.
                  </span>
                </label>
              )}

              <div className="flex flex-wrap items-center gap-2 px-3 py-3">
                <Button
                  tone="accent"
                  disabled={!canWrite}
                  onClick={() =>
                    void act.run(async () => {
                      setResults(await applyRows(loaded.recipe, rows, selected));
                    })
                  }
                >
                  {`Write ${toWrite.length} to the device`}
                </Button>
                <Button
                  disabled={!connected || act.busy}
                  title="Written values live in RAM until saved: a reset brings back the saved ones"
                  onClick={() =>
                    void act.run(async () => {
                      const r = await api().saveNvm();
                      setNote(`Saved to flash: ${r.saved} entries, record ${r.seq}.`);
                    })
                  }
                >
                  Save to flash
                </Button>
                <Hint label="About Write and Save">
                  Writing changes RAM only. Save to flash is a separate decision.
                </Hint>
              </div>

              {results !== null && (
                <div className="px-3 pb-3">
                  {results.length === 0 && <p className="font-mono text-[11px] text-fg-3">Nothing written.</p>}
                  {results.map((r) => (
                    <p key={r.name} className={`font-mono text-[11px] ${r.ok ? 'text-fg-3' : 'text-fault'}`}>
                      {r.name} {r.ok ? `= ${r.detail}` : `refused: ${r.detail}`}
                    </p>
                  ))}
                </div>
              )}
              {act.error !== null && <p className="px-3 pb-3 font-mono text-[11px] text-fault">{act.error}</p>}
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}
