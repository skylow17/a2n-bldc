/**
 * Base de temps d'une capture scope.
 *
 * Extrait de la vue et isolé ici pour être testable : c'est une arithmétique d'indices, et
 * c'est exactement le genre d'endroit où une erreur d'un cran passe inaperçue à l'écran.
 * Une courbe décalée d'un point ressemble à une courbe correcte.
 *
 * Convention retenue : **l'origine est l'instant de déclenchement**, en millisecondes,
 * négative avant et positive après. C'est ainsi qu'on lit un oscilloscope, et c'est ce qui
 * donne un sens au pré-trigger — sans origine au déclenchement, les points d'avant ne se
 * distinguent pas de ceux d'après.
 */

import type { ScopeStatus } from '../shared/messages.js';

/** Valeur de `trigger_index` tant que le déclenchement n'a pas eu lieu — protocole §6. */
export const SCOPE_TRIGGER_INDEX_NONE = 0xffff;

export interface ScopeTimeBase {
  /** Abscisse de chaque point, en millisecondes relatives au déclenchement. */
  t: number[];
  /** Période d'échantillonnage, en millisecondes. */
  periodMs: number;
  /** Durée totale de la fenêtre capturée, en millisecondes. */
  durationMs: number;
  /** Index logique du point de déclenchement, ou `null` s'il n'a pas eu lieu. */
  triggerIndex: number | null;
}

export function scopeTimeBase(sampleCount: number, status: ScopeStatus): ScopeTimeBase {
  const periodMs = status.samplePeriodNs / 1e6;

  // Une capture complète porte toujours un index de déclenchement, mais on ne le suppose
  // pas : sans lui, l'origine retombe sur le premier point plutôt que de produire des
  // abscisses aberrantes autour de 65535.
  const triggerIndex =
    status.triggerIndex === SCOPE_TRIGGER_INDEX_NONE ? null : status.triggerIndex;
  const origin = triggerIndex ?? 0;

  const t = new Array<number>(sampleCount);
  for (let i = 0; i < sampleCount; i++) t[i] = (i - origin) * periodMs;

  return { t, periodMs, durationMs: sampleCount * periodMs, triggerIndex };
}
