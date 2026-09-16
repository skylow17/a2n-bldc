/**
 * Mise à jour A/B : le chemin d'écriture, la probation, et le rollback.
 *
 * Ce code existait depuis longtemps et n'avait **jamais été exécuté** — ni sur carte, faute
 * de bootloader, ni sur simulateur, parce que celui-ci n'annonçait pas la capacité et que
 * `firmware-update` refusait de démarrer. Écrire une mise à jour de firmware qu'on n'a pas
 * fait tourner une seule fois est exactement la situation où une erreur se paie par une
 * carte muette et un retour à la sonde.
 *
 * Deux choses sont modélisées ici, et elles ne sont pas interchangeables :
 *
 *   - **une reconnexion** — on rebranche le câble, la carte ne redémarre pas ;
 *   - **un reset** (`BOOT_REBOOT`) — c'est lui, et lui seul, qui rejoue la décision A/B.
 *
 * Les confondre fait disparaître la probation, donc le rollback, donc la raison d'avoir deux
 * slots. Plusieurs tests ci-dessous ne portent que sur cette distinction.
 */

import { describe, expect, it } from 'vitest';

import { DeviceClient } from '../client.js';
import { crc32 } from '../crc16.js';
import { PROTO_ERR } from '../protocol.js';
import { SimulatedDevice, newSimFlash } from '../simulator.js';

/** Une carte : sa flash persiste, les transports vont et viennent. */
function board(trialOutcome: 'confirm' | 'fail' = 'confirm') {
  const flash = newSimFlash();
  /** Rebrancher le câble. La carte ne redémarre pas. */
  const reconnect = (): DeviceClient =>
    new DeviceClient(new SimulatedDevice({ flash, trialOutcome }), { timeoutMs: 250 });
  return { flash, reconnect };
}

/**
 * Une image plausible pour le slot demandé.
 *
 * Les deux premiers mots comptent : le bootloader refuse de sauter sur des vecteurs qui ne
 * tiennent pas debout, et une image bâtie pour l'autre slot est précisément ce qu'il attrape.
 */
function image(slot: number, bytes = 4096): Uint8Array {
  const img = new Uint8Array(bytes);
  const base = slot === 0 ? 0x0800_8000 : 0x0804_0000;
  const view = new DataView(img.buffer);
  view.setUint32(0, 0x2001_ff00, true); // _estack, comme les quatre linkers du dépôt
  view.setUint32(4, base + 0x201, true); // point d'entrée dans le slot, bit Thumb posé
  for (let i = 8; i < bytes; i++) img[i] = i & 0xff;
  return img;
}

describe('téléversement dans le slot inactif', () => {
  it('écrit, vérifie, et désigne un candidat non essayé', async () => {
    const { flash, reconnect } = board();
    const app = reconnect();
    await app.enterBootloader();
    const boot = reconnect();

    const img = image(1);
    const slot = await boot.flashInactiveSlot(img, '2.1.0');
    expect(slot).toBe(1); // A est actif, donc on écrit dans B

    const info = await boot.bootInfo();
    expect(info.candidateSlot).toBe(1);
    expect(info.slots[1]!.valid).toBe(true);
    expect(info.slots[1]!.imageSize).toBe(img.length);
    expect(info.slots[1]!.crc32).toBe(crc32(img));
    expect(info.slots[1]!.version).toBe('2.1.0');

    // Le slot actif ne bouge pas à la vérification : c'est le reset qui essaie le candidat.
    expect(info.activeSlot).toBe(0);
    expect(flash.candidateAttempted).toBe(false);
  });

  it('remonte la progression jusqu’au dernier octet', async () => {
    const { reconnect } = board();
    await (await reconnect()).enterBootloader();
    const boot = reconnect();

    const seen: number[] = [];
    const img = image(1, 3000);
    await boot.flashInactiveSlot(img, '2.1.0', (written) => seen.push(written));

    // Un compte-rendu qui n'atteint jamais le total laisse une barre de progression bloquée
    // à 98 % sur une opération qui a parfaitement réussi.
    expect(seen.at(-1)).toBe(img.length);
    expect(seen.every((n, i) => i === 0 || n > seen[i - 1]!)).toBe(true);
  });

  it('refuse une image plus grande que le slot, sans rien écrire', async () => {
    const { flash, reconnect } = board();
    await (await reconnect()).enterBootloader();
    const boot = reconnect();

    await expect(boot.flashInactiveSlot(new Uint8Array(225 * 1024), '2.1.0')).rejects.toThrow(
      RangeError,
    );
    expect(flash.meta[1]!.valid).toBe(false);
  });

  it('refuse une écriture sans effacement préalable', async () => {
    // La flash ne sait que passer un 1 à 0. Sans cette règle l'écriture « réussirait » en
    // produisant une image fausse, dont le CRC ne serait découvert qu'au BOOT_VERIFY.
    await (await board().reconnect()).enterBootloader();
    const boot = board().reconnect();
    await expect(boot.bootWrite(1, 0, new Uint8Array(8))).rejects.toMatchObject({
      code: PROTO_ERR.STATE,
    });
  });

  it('refuse de toucher au slot actif', async () => {
    const boot = board().reconnect();
    await expect(boot.bootErase(0)).rejects.toMatchObject({ code: PROTO_ERR.STATE });
  });
});

describe('probation', () => {
  it('rebrancher le câble ne redémarre pas la carte', async () => {
    // La distinction qui porte tout le reste. Une reconnexion prise pour un reset rejouerait
    // la décision A/B, verrait la marque « essayé » et annulerait un candidat parfaitement
    // sain — une mise à jour échouerait à chaque fois, sans que rien ne l'explique.
    const { flash, reconnect } = board();
    await (await reconnect()).enterBootloader();
    const boot = reconnect();
    await boot.flashInactiveSlot(image(1), '2.1.0');
    await boot.bootReboot();

    expect(flash.candidateAttempted).toBe(true);
    expect(flash.trialPending).toBe(true);

    reconnect();
    reconnect();
    expect(flash.candidateSlot).toBe(1);
    expect(flash.trialPending).toBe(true);
  });

  it('promeut le candidat une fois qu’il a confirmé', async () => {
    const { flash, reconnect } = board('confirm');
    await (await reconnect()).enterBootloader();
    const boot = reconnect();
    await boot.flashInactiveSlot(image(1), '2.1.0');
    await boot.bootReboot();

    // Le candidat démarre et atteint son point de santé.
    await reconnect().hello();

    expect(flash.activeSlot).toBe(1);
    expect(flash.candidateSlot).toBe(0xff);
    expect(flash.candidateAttempted).toBe(false);
  });

  it('retombe sur l’ancien slot quand le candidat ne confirme pas', async () => {
    // `Boot/Test/trial_fail.s`. Le rollback repose sur l'**absence** d'une confirmation,
    // jamais sur un signal d'erreur : rien n'est émis, et c'est ce silence qui décide.
    const { flash, reconnect } = board('fail');
    await (await reconnect()).enterBootloader();
    const boot = reconnect();
    await boot.flashInactiveSlot(image(1), '2.1.0');
    await boot.bootReboot();

    await reconnect().hello(); // démarre, ne confirme pas
    expect(flash.activeSlot).toBe(0);
    expect(flash.candidateAttempted).toBe(true);

    // Le reset suivant constate l'échec et abandonne le candidat.
    const after = reconnect();
    await after.enterBootloader();
    await reconnect().bootReboot();

    expect(flash.activeSlot).toBe(0);
    expect(flash.candidateSlot).toBe(0xff);
    // L'image reste valide en flash : un rollback choisit, il ne détruit pas.
    expect(flash.meta[1]!.valid).toBe(true);
  });

  it('n’essaie jamais deux fois le même candidat', async () => {
    // Sans cette règle, une image qui plante au démarrage reboucle indéfiniment et la carte
    // n'est plus joignable que par la sonde.
    const { flash, reconnect } = board('fail');
    await (await reconnect()).enterBootloader();
    const boot = reconnect();
    await boot.flashInactiveSlot(image(1), '2.1.0');

    await boot.bootReboot();
    expect(flash.trialPending).toBe(true);
    await reconnect().hello();

    await reconnect().bootReboot();
    expect(flash.trialPending).toBe(false);
    expect(flash.candidateSlot).toBe(0xff);
  });
});

describe('BOOT_ROLLBACK explicite', () => {
  it('annule un candidat en attente sans toucher au slot actif', async () => {
    const { flash, reconnect } = board();
    await (await reconnect()).enterBootloader();
    const boot = reconnect();
    await boot.flashInactiveSlot(image(1), '2.1.0');

    await boot.bootRollback();
    expect(flash.candidateSlot).toBe(0xff);
    expect(flash.activeSlot).toBe(0);
    expect(flash.meta[1]!.valid).toBe(true);
  });

  it('répond ERR_STATE quand il n’y a rien à annuler', async () => {
    await expect(board().reconnect().bootRollback()).rejects.toMatchObject({
      code: PROTO_ERR.STATE,
    });
  });
});
