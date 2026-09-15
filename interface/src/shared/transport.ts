/**
 * Transport : le lien d'octets, abstrait.
 *
 * Tout ce qui est au-dessus — codec, client, CLI, plus tard l'UI et le serveur MCP — ne
 * connaît que cette interface. Un port série réel et un device simulé sont donc strictement
 * interchangeables, ce qui n'est pas un confort mais la condition pour développer et tester
 * le poste PC sans immobiliser la carte, et pour rejouer un scénario de panne à volonté.
 *
 * Volontairement sans dépendance à Node : l'implémentation série vit dans `src/node/`.
 */

export interface Transport {
  /** Émet des octets. Rejette si le lien est fermé ou en faute. */
  write(data: Uint8Array): Promise<void>;

  /** S'abonne aux octets reçus. Rend une fonction de désabonnement. */
  onData(listener: (data: Uint8Array) => void): () => void;

  /** S'abonne aux erreurs de lien (câble arraché, port disparu). */
  onError(listener: (error: Error) => void): () => void;

  close(): Promise<void>;

  readonly isOpen: boolean;

  /** Libellé lisible, pour les journaux : `COM7`, `simulator`… */
  readonly description: string;
}

/** Petit utilitaire d'abonnement, partagé par les implémentations. */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  on(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T): void {
    // Copie avant parcours : un abonné a le droit de se désabonner en réagissant.
    for (const l of [...this.listeners]) l(value);
  }

  clear(): void {
    this.listeners.clear();
  }

  get size(): number {
    return this.listeners.size;
  }
}
