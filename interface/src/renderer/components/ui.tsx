/**
 * Éléments d'interface communs. Volontairement peu nombreux : un poste d'instrumentation
 * gagne à être monotone, l'attention doit aller aux valeurs, pas aux boutons.
 */

import type { ReactNode } from 'react';

export function Panel({
  title,
  right,
  children,
  className = '',
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section
      className={`flex min-h-0 flex-col rounded-[4px] border border-line-soft bg-panel ${className}`}
    >
      {title !== undefined && (
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line-soft px-3 py-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-2">
            {title}
          </h2>
          {right}
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
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
  const tones: Record<ButtonTone, string> = {
    default: 'border-line bg-raise text-fg hover:border-fg-3',
    accent: 'border-accent-dim bg-accent/15 text-accent hover:bg-accent/25',
    danger: 'border-fault/60 bg-fault/15 text-fault hover:bg-fault/25',
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
  const on =
    tone === 'danger'
      ? 'border-fault bg-fault/20 text-fault'
      : 'border-accent-dim bg-accent/20 text-accent';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex items-center gap-2 rounded-[3px] border px-2.5 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? on : 'border-line bg-raise text-fg-2 hover:border-fg-3'
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
