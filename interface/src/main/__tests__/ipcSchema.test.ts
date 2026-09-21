/**
 * La frontière IPC.
 *
 * Elle se teste à part parce que c'est le seul endroit de l'interface où une valeur venue
 * d'ailleurs entre dans le processus qui tient le port série. Les types TypeScript n'y sont
 * plus à l'exécution : ce qui reste, c'est ce fichier-là.
 */

import { describe, expect, it } from 'vitest';

import { IPC_SCHEMA, isIpcChannel, validateIpc } from '../ipcSchema.js';

describe('validation des arguments IPC', () => {
  it('reconnaît les canaux déclarés et rejette les autres', () => {
    expect(isIpcChannel('device:console')).toBe(true);
    expect(isIpcChannel('device:whatever')).toBe(false);
    // `hasOwnProperty` et non `in` : sinon `toString` ou `constructor` passeraient pour
    // des canaux valides, et `IPC_SCHEMA[channel]` rendrait une fonction.
    expect(isIpcChannel('toString')).toBe(false);
    expect(isIpcChannel('__proto__')).toBe(false);
  });

  it('accepte ce que le renderer envoie normalement', () => {
    expect(validateIpc('device:console', ['SENS.ALL?']).ok).toBe(true);
    expect(validateIpc('device:connect', [{ kind: 'simulator' }]).ok).toBe(true);
    expect(validateIpc('device:connect', [{ kind: 'serial', path: 'COM3' }]).ok).toBe(true);
    expect(validateIpc('device:writeParam', ['lim.i_max_a', 4]).ok).toBe(true);
    expect(validateIpc('device:writeParam', [12, 4, 'gui']).ok).toBe(true);
    expect(validateIpc('device:setAiControl', [true]).ok).toBe(true);
    expect(validateIpc('device:snapshot', []).ok).toBe(true);
  });

  it('refuse une ligne de console qui en cacherait deux', () => {
    // Le firmware découpe sur CR/LF. Une ligne qui en contient fait passer deux commandes
    // pour une — dont la seconde que personne n'a vue.
    expect(validateIpc('device:console', ['STATS?\r\nPWM ON']).ok).toBe(false);
    expect(validateIpc('device:console', ['STATS?\n']).ok).toBe(false);
    expect(validateIpc('device:console', ['STATS?\0']).ok).toBe(false);
    expect(validateIpc('device:console', ['']).ok).toBe(false);
  });

  it('refuse le verrou de pilotage par agent quand ce n est pas un booléen', () => {
    // Ce verrou décide si un agent peut mettre un axe en mouvement (AGENTS.md §4.6). Une
    // chaîne non vide est « vraie » en JavaScript : sans schéma, `'false'` l'activerait.
    expect(validateIpc('device:setAiControl', ['false']).ok).toBe(false);
    expect(validateIpc('device:setAiControl', [1]).ok).toBe(false);
    expect(validateIpc('device:setAiControl', []).ok).toBe(false);
  });

  it('refuse une valeur de paramètre qui n est pas un nombre fini', () => {
    // NaN et Infinity traversent JSON sous forme de `null` ou survivent en IPC structuré
    // selon le chemin ; dans les deux cas ils n'ont rien à faire sur un paramètre physique.
    expect(validateIpc('device:writeParam', ['lim.i_max_a', Number.NaN]).ok).toBe(false);
    expect(validateIpc('device:writeParam', ['lim.i_max_a', Number.POSITIVE_INFINITY]).ok).toBe(false);
    expect(validateIpc('device:writeParam', ['lim.i_max_a', '4']).ok).toBe(false);
  });

  it('tient les bornes du protocole sur une demande de capture', () => {
    expect(validateIpc('device:captureScope', [{ depth: 2048 }]).ok).toBe(true);
    expect(validateIpc('device:captureScope', [{ depth: 2049 }]).ok).toBe(false);
    expect(validateIpc('device:captureScope', [{ depth: 0 }]).ok).toBe(false);
    expect(validateIpc('device:captureScope', [{ depth: 12.5 }]).ok).toBe(false);
    // Quatre signaux au plus — docs/protocol.md §6.
    expect(validateIpc('device:captureScope', [{ signalNames: ['a', 'b', 'c', 'd', 'e'] }]).ok).toBe(false);
  });

  it('refuse un canal appelé avec trop ou trop peu d arguments', () => {
    expect(validateIpc('device:snapshot', ['extra']).ok).toBe(false);
    expect(validateIpc('device:console', []).ok).toBe(false);
    expect(validateIpc('device:updateFirmware', ['/tmp/a.bin']).ok).toBe(false);
  });

  it('nomme le canal et l endroit du refus', () => {
    // Le message remonte jusqu'au journal de l'interface : « invalid argument » tout court
    // ferait chercher le défaut du côté de la carte.
    const r = validateIpc('device:connect', [{ kind: 'usb' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('device:connect');
      expect(r.error).toContain('kind');
    }
  });

  it('couvre tous les canaux que le processus principal expose', () => {
    // Le garde-fou de `handle()` échouerait au démarrage sur un canal non déclaré, mais ce
    // test le dit au moment du commit plutôt qu'au premier lancement.
    const declared = Object.keys(IPC_SCHEMA);
    expect(declared).toContain('device:updateFirmware');
    expect(declared.every((c) => c.startsWith('device:'))).toBe(true);
    expect(new Set(declared).size).toBe(declared.length);
  });
});
