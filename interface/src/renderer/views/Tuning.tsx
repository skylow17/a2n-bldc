/**
 * Tuning — les paramètres, générés depuis le dictionnaire du firmware.
 *
 * Rien de la liste n'est codé en dur : noms, unités, bornes, drapeaux et regroupement
 * viennent tous du device. C'est ce qui évite qu'une liste maintenue des deux côtés
 * diverge — le défaut qui rendait le firmware v1 pénible à régler.
 */

import { useMemo, useState, type ReactNode } from 'react';

import type { DeviceSnapshot } from '../../main/device/DeviceCore.js';
import { PARAM_STATUS_NAME } from '../../shared/messages.js';
import { PARAM_FLAG, PARAM_TYPE_NAME } from '../../shared/params.js';
import { Button, Empty, Panel, fmt } from '../components/ui.js';
import { api, useAction } from '../useDevice.js';

type Param = DeviceSnapshot['params'][number];

function flagsOf(p: Param): string[] {
  const f: string[] = [];
  if (p.flags & PARAM_FLAG.READ_ONLY) f.push('ro');
  if (p.flags & PARAM_FLAG.PERSISTENT) f.push('nvm');
  if (p.flags & PARAM_FLAG.REQUIRES_DISARM) f.push('disarm');
  if (p.flags & PARAM_FLAG.ADVANCED) f.push('adv');
  if (p.flags & PARAM_FLAG.CALIBRATED) f.push('cal');
  return f;
}

function Row({ p }: { p: Param }): ReactNode {
  const readOnly = (p.flags & PARAM_FLAG.READ_ONLY) !== 0;
  const [draft, setDraft] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const shown = draft ?? (p.value === null ? '' : fmt(p.value));
  const parsed = Number(shown);
  const invalid = draft !== null && (shown.trim() === '' || !Number.isFinite(parsed));
  const outOfRange = !invalid && draft !== null && (parsed < p.min || parsed > p.max);
  const dirty = draft !== null && Number(draft) !== p.value;

  const commit = (): void => {
    if (draft === null || invalid) return;
    void run(async () => {
      await api().writeParam(p.id, parsed);
      setDraft(null);
    });
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_7rem_4rem_10rem_5rem] items-center gap-2 border-b border-line-soft/60 px-3 py-1.5 last:border-b-0 hover:bg-panel-2/40">
      <div className="min-w-0">
        <div className="selectable truncate font-mono text-[12px] text-fg">{p.name}</div>
        {(error !== null || outOfRange) && (
          <div className="truncate text-[11px] text-fault">
            {error ?? `hors bornes [${fmt(p.min)}, ${fmt(p.max)}]`}
          </div>
        )}
      </div>

      {readOnly ? (
        <div className="selectable text-right font-mono text-[12px] text-fg-2">
          {p.status === 0 ? fmt(p.value) : (PARAM_STATUS_NAME[p.status] ?? '?')}
        </div>
      ) : (
        <input
          className={`w-full rounded-[3px] border bg-raise px-2 py-0.5 text-right font-mono text-[12px] text-fg outline-none ${
            invalid || outOfRange
              ? 'border-fault'
              : dirty
                ? 'border-accent-dim'
                : 'border-line focus:border-fg-3'
          }`}
          value={shown}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setDraft(null);
          }}
          onBlur={commit}
        />
      )}

      <div className="text-[11px] text-fg-3">{p.unit}</div>

      <div className="font-mono text-[11px] text-fg-3">
        {fmt(p.min)} … {fmt(p.max)}
        <span className="ml-2 opacity-70">déf {fmt(p.def)}</span>
      </div>

      <div className="flex flex-wrap gap-1">
        <span className="rounded-[2px] bg-panel-2 px-1 text-[10px] text-fg-3">
          {PARAM_TYPE_NAME[p.type] ?? p.type}
        </span>
        {flagsOf(p).map((f) => (
          <span key={f} className="rounded-[2px] bg-panel-2 px-1 text-[10px] text-fg-3">
            {f}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Tuning({ state }: { state: DeviceSnapshot }): ReactNode {
  const [filter, setFilter] = useState('');
  const { busy, run } = useAction();

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const out = new Map<string, Param[]>();
    for (const p of state.params) {
      if (needle !== '' && !p.name.toLowerCase().includes(needle)) continue;
      const list = out.get(p.group) ?? [];
      list.push(p);
      out.set(p.group, list);
    }
    return out;
  }, [state.params, filter]);

  if (state.params.length === 0) {
    return (
      <Empty
        title="Aucun dictionnaire chargé"
        hint="Les paramètres sont publiés par le firmware au moment de la connexion."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="flex shrink-0 items-center gap-2">
        <input
          className="w-72 rounded-[3px] border border-line bg-raise px-2 py-1 font-mono text-[12px] text-fg outline-none focus:border-fg-3"
          placeholder="filtrer par nom…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="flex-1" />
        <Button onClick={() => void run(() => api().refresh())} disabled={busy}>
          Relire tout
        </Button>
        <Button onClick={() => void run(() => api().resetDefaults())} disabled={busy}>
          Valeurs par défaut
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto">
        {[...groups].map(([group, params]) => (
          <Panel key={group} title={group}>
            <div className="grid grid-cols-[minmax(0,1fr)_7rem_4rem_10rem_5rem] gap-2 border-b border-line-soft px-3 py-1 text-[10px] uppercase tracking-wider text-fg-3">
              <span>nom</span>
              <span className="text-right">valeur</span>
              <span>unité</span>
              <span>bornes</span>
              <span>type</span>
            </div>
            {params.map((p) => (
              <Row key={p.id} p={p} />
            ))}
          </Panel>
        ))}
        {groups.size === 0 && <Empty title={`Aucun paramètre ne correspond à « ${filter} »`} />}
      </div>

      <p className="shrink-0 text-[11px] text-fg-3">
        Chaque écriture est relue aussitôt : le firmware arrondit vers le type réel du
        paramètre, la valeur affichée est donc celle qu'il a retenue, pas celle qui a été
        saisie.
      </p>
    </div>
  );
}
