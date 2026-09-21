/**
 * Dimensionnement du tampon de telemetrie.
 *
 * La fenetre d'affichage et la memoire sont deux reglages distincts, et les desaccorder ne
 * se voit pas : demander trente secondes avec un tampon de quinze donnait une courbe
 * tronquee, sans rien pour l'expliquer a l'ecran.
 */

import { describe, expect, it } from 'vitest';

import { bufferCapacity } from '../components/LiveTelemetry.js';

describe('capacite du tampon de telemetrie', () => {
  it('tient la fenetre demandee, avec de la marge', () => {
    // Le minimum indispensable est fenetre x cadence ; en dessous, la fenetre est un
    // mensonge. La marge absorbe les variations de cadence reelle.
    expect(bufferCapacity(30, 200)).toBeGreaterThan(30 * 200);
    expect(bufferCapacity(5, 500)).toBeGreaterThan(5 * 500);
  });

  it('garde un plancher utilisable sur une fenetre courte', () => {
    // Une seconde a 100 Hz ne fait que cent points : le tampon serait vide avant meme
    // qu'on ait le temps de regarder.
    expect(bufferCapacity(1, 100)).toBeGreaterThanOrEqual(600);
  });

  it('borne la memoire', () => {
    // A 500 Hz sur une minute, huit signaux, on est deja autour de trois megaoctets.
    expect(bufferCapacity(3600, 500)).toBeLessThanOrEqual(100_000);
  });

  it('grandit avec la fenetre comme avec la cadence', () => {
    expect(bufferCapacity(30, 200)).toBeGreaterThan(bufferCapacity(5, 200));
    expect(bufferCapacity(5, 500)).toBeGreaterThan(bufferCapacity(5, 100));
  });
});
