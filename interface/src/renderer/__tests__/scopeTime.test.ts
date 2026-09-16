/**
 * Base de temps d'une capture scope.
 *
 * Une erreur d'un cran ici ne se voit pas à l'écran : la courbe reste plausible, seulement
 * décalée. D'où des vecteurs explicites plutôt qu'une relecture.
 */

import { describe, expect, it } from 'vitest';

import { ScopeState } from '../../shared/protocol.js';
import type { ScopeStatus } from '../../shared/messages.js';
import { SCOPE_TRIGGER_INDEX_NONE, scopeTimeBase } from '../scopeTime.js';

function status(over: Partial<ScopeStatus> = {}): ScopeStatus {
  return {
    state: ScopeState.COMPLETE,
    signalCount: 1,
    captured: 8,
    depth: 8,
    triggerIndex: 0,
    decimation: 1,
    samplePeriodNs: 50_000, // 20 kHz → 0,05 ms
    startTimestampUs: 0,
    ...over,
  };
}

describe('scopeTimeBase', () => {
  it('place le premier point à zéro quand il n’y a pas de pré-trigger', () => {
    const b = scopeTimeBase(4, status({ triggerIndex: 0 }));
    expect(b.t).toEqual([0, 0.05, 0.1, 0.15000000000000002]);
    expect(b.periodMs).toBe(0.05);
    expect(b.durationMs).toBeCloseTo(0.2, 10);
    expect(b.triggerIndex).toBe(0);
  });

  it('met l’origine sur le déclenchement, négatif avant', () => {
    // C'est tout l'intérêt du pré-trigger : voir ce qui précède l'événement, et savoir
    // que ça le précède.
    const b = scopeTimeBase(5, status({ triggerIndex: 2 }));
    expect(b.t[0]).toBeCloseTo(-0.1, 10);
    expect(b.t[1]).toBeCloseTo(-0.05, 10);
    expect(b.t[2]).toBe(0);
    expect(b.t[3]).toBeCloseTo(0.05, 10);
    expect(b.t[4]).toBeCloseTo(0.1, 10);
  });

  it('suit la décimation par la période annoncée, pas par une hypothèse', () => {
    // Le firmware renvoie `samplePeriodNs` = 50 000 × décimation. On le lit plutôt que de
    // le recalculer : si la boucle change de cadence, la base de temps suit.
    const b = scopeTimeBase(3, status({ decimation: 4, samplePeriodNs: 200_000 }));
    expect(b.periodMs).toBe(0.2);
    expect(b.t).toEqual([0, 0.2, 0.4]);
  });

  it('retombe sur le premier point si le déclenchement n’a pas eu lieu', () => {
    // Sans ce repli, un index de 0xffff donnerait des abscisses autour de -3,3 secondes
    // pour une fenêtre de 0,2 ms.
    const b = scopeTimeBase(3, status({ triggerIndex: SCOPE_TRIGGER_INDEX_NONE }));
    expect(b.triggerIndex).toBeNull();
    expect(b.t[0]).toBe(0);
    expect(b.t[2]).toBeCloseTo(0.1, 10);
  });

  it('donne la durée de la fenêtre réellement capturée', () => {
    // 2048 points à 20 kHz = 102,4 ms — la valeur affichée sous la capture.
    const b = scopeTimeBase(2048, status({ captured: 2048, depth: 2048 }));
    expect(b.durationMs).toBeCloseTo(102.4, 6);
  });

  it('rend une base vide pour une capture vide', () => {
    const b = scopeTimeBase(0, status());
    expect(b.t).toEqual([]);
    expect(b.durationMs).toBe(0);
  });
});
