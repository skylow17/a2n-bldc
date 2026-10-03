/**
 * Fenêtre modale dans l'interface : Settings, AI / MCP, About, raccourcis.
 *
 * Modale **dans** la fenêtre et non une fenêtre système : elle prend le thème, et la barre
 * haute reste au-dessus du voile — STOP et AI CONTROL demeurent visibles et cliquables
 * pendant qu'un réglage est ouvert (`AGENTS.md` §4.6). `Échap` ou un clic sur le voile la
 * referment.
 */

import { useEffect, type ReactNode } from 'react';

export function Dialog({
  title,
  onClose,
  children,
  footer,
  width = 'max-w-3xl',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-[800] flex items-start justify-center bg-black/50 p-6 pt-10"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-full w-full ${width} flex-col rounded-[6px] border border-line bg-panel shadow-2xl shadow-black/50`}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-line-soft px-4 py-2.5">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-fg-2">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-[3px] px-2 text-[16px] leading-none text-fg-3 hover:bg-raise hover:text-fg"
          >
            ×
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        {footer !== undefined && (
          <footer className="flex shrink-0 items-center gap-2 border-t border-line-soft px-4 py-2.5">{footer}</footer>
        )}
      </section>
    </div>
  );
}
