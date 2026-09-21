/**
 * Bornage des tailles reglables a la main.
 *
 * C'est la seule logique pure de `Resizable.tsx`, et c'est celle qui empeche de se coincer :
 * une colonne laterale qui avalerait tout l'instrument, ou un panneau reduit a rien, se
 * reparent d'autant moins que la taille est memorisee d'une session a l'autre.
 */

import { describe, expect, it } from 'vitest';

import { clampSize } from '../components/Resizable.js';

describe('bornage d une taille reglable', () => {
  it('laisse passer ce qui est deja dans les bornes', () => {
    expect(clampSize(300, 100, 800)).toBe(300);
  });

  it('retient aux deux bouts', () => {
    expect(clampSize(10, 100, 800)).toBe(100);
    expect(clampSize(5000, 100, 800)).toBe(800);
  });

  it('rend un entier de pixels', () => {
    // Une hauteur fractionnaire fait baver les bordures d un panneau a un pixel.
    expect(Number.isInteger(clampSize(300.4, 100, 800))).toBe(true);
    expect(clampSize(300.6, 100, 800)).toBe(301);
  });

  it('privilegie le plancher quand les bornes se croisent', () => {
    // Le plafond se calcule sur la fenetre : sur un ecran tres etroit il peut passer sous
    // le plancher. Mieux vaut un panneau lisible qui deborde qu un panneau ecrase.
    expect(clampSize(500, 300, 100)).toBe(300);
    expect(clampSize(50, 300, 100)).toBe(300);
  });
});
