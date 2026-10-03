/**
 * Commandes de l'application, partagées entre la barre de menus, les raccourcis clavier et
 * les vues.
 *
 * Un menu déclenche souvent une action qui appartient à une vue — exporter la mesure
 * affichée dans le Scope, par exemple. Plutôt que de remonter l'état de chaque vue jusqu'à
 * la barre, le menu **émet** une commande et la vue concernée l'**écoute** tant qu'elle est
 * montée. Une commande sans personne pour l'écouter ne fait rien, et le menu la grise
 * (`hasHandler`).
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';

export type CommandId =
  | 'measurement:export-csv'
  | 'measurement:export-json'
  | 'measurement:export-png'
  | 'measurement:import'
  | 'recipe:open';

const handlers = new Map<CommandId, Set<() => void>>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const l of listeners) l();
}

export function emitCommand(id: CommandId): boolean {
  const set = handlers.get(id);
  if (set === undefined || set.size === 0) return false;
  for (const h of set) h();
  return true;
}

export function hasHandler(id: CommandId): boolean {
  return (handlers.get(id)?.size ?? 0) > 0;
}

/** Écoute une commande tant que le composant est monté. */
export function useCommand(id: CommandId, handler: () => void, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return undefined;
    const h = (): void => ref.current();
    let set = handlers.get(id);
    if (set === undefined) handlers.set(id, (set = new Set()));
    set.add(h);
    changed();
    return () => {
      set.delete(h);
      changed();
    };
  }, [id, enabled]);
}

/** Se redessine quand une commande gagne ou perd son écouteur — pour griser les menus. */
export function useCommandsVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}
