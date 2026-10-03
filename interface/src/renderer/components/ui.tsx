/**
 * Éléments d'interface communs. Volontairement peu nombreux : un poste d'instrumentation
 * gagne à être monotone, l'attention doit aller aux valeurs, pas aux boutons.
 */

import type { ReactNode } from 'react';

import { useConfig } from '../config.js';
import { Hint } from './Hint.js';

export function Panel({
  title,
  hint,
  right,
  children,
  className = '',
}: {
  title?: string;
  /** Explication du panneau, repliée derrière une icône à côté du titre — voir `Hint`. */
  hint?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactNode {
  const { config } = useConfig();
  const inline = config.ui.helpMode === 'inline';
  return (
    <section
      className={`flex min-h-0 flex-col rounded-[4px] border border-line-soft bg-panel ${className}`}
    >
      {title !== undefined && (
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line-soft px-3 py-2">
          <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-2">
            {title}
            {hint !== undefined && !inline && <Hint label={`About ${title}`}>{hint}</Hint>}
          </h2>
          {right}
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {hint !== undefined && (inline || title === undefined) && <Hint>{hint}</Hint>}
        {children}
      </div>
    </section>
  );
}

type ButtonTone = 'default' | 'accent' | 'danger';

export function Button({
  children,
  onClick,
  disabled = false,
  tone = 'default',
  title,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: ButtonTone;
  title?: string;
  className?: string;
}): ReactNode {
  // Les trois tons vivent dans styles.css : un fond translucide ne se transpose pas d'un
  // theme a l'autre, et le bouton STOP sur fond clair l'a montre.
  const tones: Record<ButtonTone, string> = {
    default: 'tone-default',
    accent: 'tone-accent',
    danger: 'tone-danger',
  };
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-[3px] border px-2.5 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  tone = 'default',
  disabled = false,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  tone?: ButtonTone;
  disabled?: boolean;
  title?: string;
}): ReactNode {
  const on = tone === 'danger' ? 'tone-danger' : 'tone-accent';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex items-center gap-2 rounded-[3px] border px-2.5 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? on : 'tone-default text-fg-2'
      }`}
    >
      <span
        className={`h-2 w-2 rounded-full ${checked ? 'bg-current' : 'bg-fg-3'}`}
        aria-hidden="true"
      />
      {label}
    </button>
  );
}

/* Pastille d'etat. La couleur redouble toujours un mot : une information n'est jamais
 * portee par la seule couleur. */
export function Dot({ tone }: { tone: 'ok' | 'warn' | 'fault' | 'idle' }): ReactNode {
  const colors = {
    ok: 'bg-ok',
    warn: 'bg-accent',
    fault: 'bg-fault',
    idle: 'bg-fg-3',
  } as const;
  return <span className={`inline-block h-2 w-2 rounded-full ${colors[tone]}`} aria-hidden="true" />;
}

export function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4 px-3 py-1.5 odd:bg-panel-2/40">
      <span className="text-[12px] text-fg-2">{label}</span>
      <span className="selectable font-mono text-[12px] text-fg">{children}</span>
    </div>
  );
}

export function Empty({
  title,
  hint,
}: {
  title: string;
  hint?: string | undefined;
}): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-[13px] text-fg-2">{title}</p>
      {hint !== undefined && <p className="max-w-md text-[12px] text-fg-3">{hint}</p>}
    </div>
  );
}

/** Formate une valeur sans traîner de décimales parasites. */
export function fmt(v: number | null, digits = 6): string {
  if (v === null || !Number.isFinite(v)) return '—';
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(digits)));
}
