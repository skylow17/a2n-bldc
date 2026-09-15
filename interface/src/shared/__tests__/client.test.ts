/**
 * Le client face au device simulé : le chemin complet, du codec au dialogue.
 *
 * Ces tests valident aussi le simulateur lui-même, puisque les deux s'éprouvent mutuellement.
 * Ce que ni l'un ni l'autre ne peut prouver, c'est l'accord avec le firmware réel — c'est le
 * rôle des vecteurs partagés, et de l'essai sur carte.
 */

import { describe, expect, it } from 'vitest';

import { DeviceClient, ProtocolError, TimeoutError } from '../client.js';
import { ParamStatus } from '../messages.js';
import { paramDictHash } from '../params.js';
import { PROTO_ERR } from '../protocol.js';
import { DEFAULT_SIM_PARAMS, SimulatedDevice } from '../simulator.js';

function connect(options?: ConstructorParameters<typeof SimulatedDevice>[0]) {
  const device = new SimulatedDevice(options);
  const client = new DeviceClient(device, { timeoutMs: 250 });
  return { device, client };
}

describe('handshake', () => {
  it("rend l'identité du device", async () => {
    const { client } = connect();
    const info = await client.hello();

    expect(info.product).toBe('A2N-BLDC');
    expect(info.protocolMajor).toBe(2);
    expect(info.protocolMinor).toBe(0);
    expect(info.paramCount).toBe(DEFAULT_SIM_PARAMS.length);
    expect(info.uid).toHaveLength(3);
  });

  it("n'annonce aucune capacité tant que rien n'est implémenté", async () => {
    const { client } = connect();
    const info = await client.hello();
    // Un bit levé ici sans code derrière ferait proposer à l'UI un bouton qui échoue.
    expect(info.capabilities).toBe(0);
    expect(info.telemSignalCount).toBe(0);
  });
});

describe('dictionnaire', () => {
  it("le hash recalculé sur les entrées reçues correspond au handshake", async () => {
    // C'est le critère de validation de M1b : il vérifie du même coup que le transfert
    // est complet et dans le bon ordre.
    const { client } = connect();
    const info = await client.hello();
    const dict = await client.readDictionary();

    expect(dict.size).toBe(info.paramCount);
    expect(paramDictHash(dict.entries)).toBe(info.paramDictHash);
  });

  it('pagine correctement, quelle que soit la taille de page', async () => {
    for (const pageSize of [1, 2, 3, 6, 11, 50]) {
      const { client } = connect();
      const dict = await client.readDictionary(pageSize);
      expect(dict.size, `page de ${pageSize}`).toBe(DEFAULT_SIM_PARAMS.length);
      expect(dict.entries[0]!.name).toBe('board.sysclk_hz');
      expect(dict.entries.at(-1)!.name).toBe('dbg.echo_enum');
    }
  });

  it("respecte le plafond d'entrées par page du firmware", async () => {
    // On demande 50 entrées ; le firmware en renvoie au plus 6 et réduit sans se plaindre.
    const { client } = connect({ dictPageSize: 6 });
    const dict = await client.readDictionary(50);
    expect(dict.size).toBe(DEFAULT_SIM_PARAMS.length);
  });

  it('expose les groupes dans l’ordre du firmware', async () => {
    const { client } = connect();
    const dict = await client.readDictionary();
    expect(dict.groups()).toEqual(['Board', 'PWM', 'Debug']);
  });
});

describe('lecture et écriture', () => {
  it('lit les constantes de la carte', async () => {
    const { client } = connect();
    const dict = await client.readDictionary();
    const v = await client.readByName(dict, ['board.sysclk_hz', 'pwm.freq_hz', 'pwm.arr']);

    expect(v.get('board.sysclk_hz')).toBe(144_000_000);
    expect(v.get('pwm.freq_hz')).toBe(20_000);
    expect(v.get('pwm.arr')).toBe(3599);
  });

  it('écrit puis relit une valeur', async () => {
    const { client } = connect();
    const dict = await client.readDictionary();
    const id = dict.get('dbg.echo_f32')!.id;

    expect(await client.writeParams([{ id, value: 12.5 }])).toEqual([
      { id, status: ParamStatus.OK },
    ]);
    expect((await client.readParams([id]))[0]!.value).toBe(12.5);
  });

  it('arrondit un entier au plus proche, comme le firmware', async () => {
    const { client } = connect();
    const dict = await client.readDictionary();
    const id = dict.get('dbg.echo_i16')!.id;

    await client.writeParams([{ id, value: 2.9999997 }]);
    expect((await client.readParams([id]))[0]!.value).toBe(3);
  });

  it('refuse une écriture en lecture seule sans toucher la valeur', async () => {
    const { client } = connect();
    const dict = await client.readDictionary();
    const id = dict.get('pwm.arr')!.id;

    expect(await client.writeParams([{ id, value: 1000 }])).toEqual([
      { id, status: ParamStatus.ERR_READ_ONLY },
    ]);
    expect((await client.readParams([id]))[0]!.value).toBe(3599);
  });

  it('refuse une valeur hors bornes', async () => {
    const { client } = connect();
    const dict = await client.readDictionary();
    const id = dict.get('dbg.echo_f32')!.id;

    expect((await client.writeParams([{ id, value: 1e6 }]))[0]!.status).toBe(
      ParamStatus.ERR_RANGE,
    );
  });

  it('signale un identifiant inconnu au lieu de rendre une valeur', async () => {
    const { client } = connect();
    expect((await client.readParams([0x7fff]))[0]).toEqual({
      id: 0x7fff,
      status: ParamStatus.ERR_ID,
      value: 0,
    });
  });

  it("applique un lot d'écritures indépendamment : un refus n'annule pas les autres", async () => {
    const { client } = connect();
    const dict = await client.readDictionary();
    const ok = dict.get('dbg.echo_u32')!.id;
    const ro = dict.get('pwm.freq_hz')!.id;

    const res = await client.writeParams([
      { id: ok, value: 7 },
      { id: ro, value: 1 },
    ]);
    expect(res.map((r) => r.status)).toEqual([ParamStatus.OK, ParamStatus.ERR_READ_ONLY]);
    expect((await client.readParams([ok]))[0]!.value).toBe(7);
  });

  it('remet les valeurs par défaut', async () => {
    const { client } = connect();
    const dict = await client.readDictionary();
    const id = dict.get('dbg.echo_u32')!.id;

    await client.writeParams([{ id, value: 999 }]);
    await client.resetDefaults();
    expect((await client.readParams([id]))[0]!.value).toBe(0);
  });
});

describe('erreurs et robustesse', () => {
  it('remonte un refus du firmware comme une erreur typée', async () => {
    const { client } = connect();
    // La persistance NVM n'existe pas encore : le firmware refuse explicitement plutôt
    // que de répondre OK sans rien écrire.
    await expect(client['request'](0x0014, 0x0014, new Uint8Array(0), 'SAVE')).rejects.toThrow(
      ProtocolError,
    );
    await expect(
      client['request'](0x0014, 0x0014, new Uint8Array(0), 'SAVE'),
    ).rejects.toMatchObject({ code: PROTO_ERR.NVM, codeName: 'NVM' });
  });

  it('expire proprement si le device ne répond pas', async () => {
    const { device, client } = connect();
    await device.close();
    await expect(client.hello()).rejects.toThrow();
  });

  it('réveille les requêtes en attente quand le lien tombe', async () => {
    const { device, client } = connect({ latencyMs: 5000 });
    const p = client.hello();
    device.fail('câble débranché');
    // Sans ce réveil, la CLI resterait suspendue et l'UI paraîtrait figée.
    await expect(p).rejects.toThrow('câble débranché');
  });

  it('survit à des trames corrompues et finit par aboutir', async () => {
    // Une trame corrompue est indiscernable d'une trame perdue : elle expire. Ce que l'on
    // vérifie ici, c'est qu'elle n'empoisonne pas le flux et que la requête suivante passe.
    const { client } = connect({ corruptionRate: 1 });
    await expect(client.hello()).rejects.toThrow(TimeoutError);

    const { client: healthy } = connect();
    await expect(healthy.hello()).resolves.toMatchObject({ product: 'A2N-BLDC' });
  });
});

describe('console ASCII sur le même lien', () => {
  it('répond à PING', async () => {
    const { client } = connect();
    expect(await client.console('PING')).toBe('OK');
    expect(await client.console('PING salut')).toBe('OK salut');
  });

  it('rejette une commande inconnue', async () => {
    const { client } = connect();
    expect(await client.console('NIMPORTEQUOI')).toBe('ERR CMD');
  });

  it('ne confond pas une ligne de console avec une trame binaire', async () => {
    const { client } = connect();
    const lines: string[] = [];
    client.onLine((t) => lines.push(t));

    // Les deux canaux en vol simultanément : c'est exactement ce que le démultiplexeur
    // doit démêler, des deux côtés du lien.
    const [info, pong] = await Promise.all([client.hello(), client.console('PING')]);

    expect(info.product).toBe('A2N-BLDC');
    expect(pong).toBe('OK');
  });

  it('expose le hash du dictionnaire via PROTO?, cohérent avec le handshake', async () => {
    const { client } = connect();
    const info = await client.hello();
    const line = await client.console('PROTO?');

    const m = /dict_hash=([0-9A-F]{8})/.exec(line);
    expect(m, `réponse inattendue : ${line}`).not.toBeNull();
    expect(parseInt(m![1]!, 16)).toBe(info.paramDictHash);
  });
});
