/**
 * Composants de supervision : le gros chiffre, sa trace, et la pastille d'état.
 *
 * Ce que le mockup d'origine appelait une « carte » du tableau de bord. Trois principes y
 * tiennent, et ils expliquent la forme du code plus bas :
 *
 *  - **Le chiffre d'abord.** Une valeur de supervision se lit de loin, pendant qu'on a les
 *    mains ailleurs. La trace n'est là que pour dire si ça dérive, pas pour être mesurée —
 *    c'est le rôle du Scope, qui a des axes.
 *  - **Une absence de mesure n'est pas un zéro.** `null` s'affiche `—`. Un rail à 0,00 V est
 *    une panne ; le confondre avec « pas encore lu » ferait chercher un problème qui n'existe
 *    pas, ou rater celui qui existe.
 *  - **L'historique vit dans le composant.** Il vient du flux de snapshots, donc il se
 *    remplit au rythme du relevé et se vide tout seul quand on change de vue. Rien à
 *    ranger dans l'état partagé pour une décoration.
 */

import { useEffect, useRef, type ReactNode } from 'react';

/** Points gardés par trace : à un relevé toutes les 500 ms, environ une minute. */
const SPARK_POINTS = 120;

export type Health = 'ok' | 'warn' | 'fault' | 'idle';

export function Pill({ tone, children }: { tone: Health; children: ReactNode }): ReactNode {
  const cls = {
    ok: 'border-ok/40 text-ok',
    warn: 'border-accent/40 text-accent',
    fault: 'border-fault/50 text-fault',
    idle: 'border-line text-fg-3',
  }[tone];
  return (
    <span className={`rounded-[3px] border px-1.5 py-0.5 font-mono text-[10px] tracking-wide ${cls}`}>
      {children}
    </span>
  );
}

/**
 * Courbe d'historique, sans axe ni graduation.
 *
 * Dessinée en SVG plutôt qu'en canvas : à cent vingt points rafraîchis deux fois par
 * seconde, le coût est nul, et une balise reste inspectable et suit le thème sans qu'on ait
 * à relire une variable CSS à la main.
 */
function Spark({ history, tone }: { history: number[]; tone: Health }): ReactNode {
  if (history.length < 2) {
    return <div className="h-8" />;
  }
  let lo = Math.min(...history);
  let hi = Math.max(...history);
  // Une trace parfaitement plate doit se voir plate, pas remplir la hauteur avec du bruit
  // d'arrondi. On lui donne une étendue minimale plutôt que de normaliser sur rien.
  const span = hi - lo;
  const floor = Math.max(Math.abs(hi) * 0.002, 1e-6);
  if (span < floor) {
    const mid = (hi + lo) / 2;
    lo = mid - floor;
    hi = mid + floor;
  }
  const n = history.length;
  const pts = history
    .map((v, i) => {
      const x = (i / (n - 1)) * 100;
      const y = 30 - ((v - lo) / (hi - lo)) * 28 - 1;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const stroke = { ok: 'var(--color-ok)', warn: 'var(--color-accent)', fault: 'var(--color-fault)', idle: 'var(--color-fg-3)' }[tone];

  return (
    <svg className="h-8 w-full" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Metric({
  label,
  value,
  unit,
  digits = 2,
  tone = 'ok',
  note,
}: {
  label: string;
  /** `null` quand la carte n'a rien publié : affiché `—`, jamais 0. */
  value: number | null;
  unit: string;
  digits?: number;
  tone?: Health;
  note?: string;
}): ReactNode {
  const history = useRef<number[]>([]);
  // Le rendu suit le flux de snapshots ; l'historique se remplit à ce rythme-là.
  useEffect(() => {
    if (value === null) return;
    history.current = [...history.current, value].slice(-SPARK_POINTS);
  }, [value]);

  return (
    <section className="flex flex-col rounded-[4px] border border-line-soft bg-panel px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-2">{label}</h3>
        {note !== undefined && <span className="font-mono text-[10px] text-fg-3">{note}</span>}
      </div>
      <div
        className={`font-mono text-[26px] leading-tight ${tone === 'fault' ? 'text-fault' : tone === 'warn' ? 'text-accent' : 'text-fg'}`}
      >
        {value === null ? '—' : value.toFixed(digits)}
        <span className="ml-1 text-[13px] text-fg-3">{unit}</span>
      </div>
      <Spark history={history.current} tone={tone} />
    </section>
  );
}
