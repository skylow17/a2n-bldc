/**
 * Le DeviceCore face au device simulé.
 *
 * C'est la logique que l'UI se contente de refléter : la tester ici vaut mieux que de
 * cliquer dans la fenêtre, et couvre aussi le chemin qu'emprunteront la CLI et le serveur
 * MCP, puisque c'est le même.
 */

import { describe, expect, it } from 'vitest';

import type { TelemFrame } from '../../../shared/messages.js';
import { ScopeTrigger } from '../../../shared/protocol.js';
import { DeviceCore, type LogEntry } from '../DeviceCore.js';

async function connected(): Promise<{ core: DeviceCore; logs: LogEntry[] }> {
  const core = new DeviceCore();
  const logs: LogEntry[] = [];
  core.onLog.on((e) => logs.push(e));
  await core.connect({ kind: 'simulator' });
  return { core, logs };
}

describe('connexion', () => {
  it('charge identité, dictionnaire et valeurs en une passe', async () => {
    const { core } = await connected();
    const s = core.snapshot();

    expect(s.connection).toBe('connected');
    expect(s.info?.product).toBe('A2N-BLDC');
    expect(s.params).toHaveLength(s.info!.paramCount);
    expect(s.params.every((p) => p.value !== null)).toBe(true);
  });

  it("vérifie l'intégrité du dictionnaire reçu", async () => {
    const { core } = await connected();
    // Le hash recalculé sur les entrées reçues doit retomber sur celui du handshake.
    expect(core.snapshot().dictIntegrity).toBe(true);
  });

  it('expose les constantes réelles de la carte', async () => {
    const { core } = await connected();
    const byName = new Map(core.snapshot().params.map((p) => [p.name, p.value]));
    expect(byName.get('board.sysclk_hz')).toBe(144_000_000);
    expect(byName.get('pwm.freq_hz')).toBe(20_000);
    expect(byName.get('pwm.arr')).toBe(3599);
  });

  it('rend un état propre après déconnexion', async () => {
    const { core } = await connected();
    await core.disconnect();
    const s = core.snapshot();
    expect(s.connection).toBe('disconnected');
    expect(s.info).toBeNull();
    expect(s.params).toEqual([]);
  });

  it('signale une connexion impossible sans rester en « connecting »', async () => {
    const core = new DeviceCore();
    await expect(core.connect({ kind: 'serial', path: 'COM_INEXISTANT' })).rejects.toThrow();
    expect(core.snapshot().connection).toBe('error');
    expect(core.snapshot().lastError).not.toBeNull();
  });
});

describe('écriture de paramètres', () => {
  it('écrit puis relit, et publie la valeur retenue par le firmware', async () => {
    const { core } = await connected();
    const returned = await core.writeParam('dbg.echo_f32', 12.5);
    expect(returned).toBe(12.5);

    const p = core.snapshot().params.find((x) => x.name === 'dbg.echo_f32');
    expect(p?.value).toBe(12.5);
  });

  it("publie la valeur arrondie, pas celle qui a été saisie", async () => {
    // Le firmware arrondit vers le type réel. Afficher la saisie plutôt que la valeur
    // retenue est exactement le genre de mensonge qui fait régler à l'aveugle.
    const { core } = await connected();
    const returned = await core.writeParam('dbg.echo_i16', 2.9999997);
    expect(returned).toBe(3);
    expect(core.snapshot().params.find((p) => p.name === 'dbg.echo_i16')?.value).toBe(3);
  });

  it('contraint au domaine déclaré avant d’envoyer', async () => {
    const { core } = await connected();
    // 1e6 est hors bornes : la valeur est ramenée à max plutôt que refusée par le firmware.
    expect(await core.writeParam('dbg.echo_f32', 1e6)).toBe(1000);
  });

  it('remonte un refus en lecture seule comme une erreur', async () => {
    const { core } = await connected();
    await expect(core.writeParam('pwm.arr', 1234)).rejects.toThrow(/rejected/i);
    expect(core.snapshot().params.find((p) => p.name === 'pwm.arr')?.value).toBe(3599);
  });

  it('rejette un paramètre inconnu', async () => {
    const { core } = await connected();
    await expect(core.writeParam('pid.iq.kp', 1)).rejects.toThrow(/unknown parameter/);
  });

  it('remet les valeurs par défaut', async () => {
    const { core } = await connected();
    await core.writeParam('dbg.echo_u32', 999);
    await core.resetDefaults();
    expect(core.snapshot().params.find((p) => p.name === 'dbg.echo_u32')?.value).toBe(0);
  });
});

describe('pilotage par agent', () => {
  it('refuse une écriture d’origine agent tant que le contrôle est désactivé', async () => {
    const { core } = await connected();
    expect(core.isAiControlEnabled).toBe(false);

    // La barrière vit dans le DeviceCore et non dans le renderer : elle tient même si
    // quelqu'un contourne l'interface.
    await expect(core.writeParam('dbg.echo_f32', 1, 'mcp')).rejects.toThrow(/AI control/i);
  });

  it('laisse passer une fois le contrôle activé, et le journalise', async () => {
    const { core, logs } = await connected();
    core.setAiControl(true);
    await core.writeParam('dbg.echo_f32', 3.5, 'mcp');

    expect(core.snapshot().params.find((p) => p.name === 'dbg.echo_f32')?.value).toBe(3.5);
    // La source doit rester visible dans le journal : une action d'agent ne doit pas être
    // indiscernable d'une action humaine.
    expect(logs.some((l) => l.source === 'mcp' && l.text.includes('dbg.echo_f32'))).toBe(true);
    expect(logs.some((l) => l.level === 'warn' && l.text.includes('ENABLED'))).toBe(true);
  });

  it('n’entrave jamais une action humaine', async () => {
    const { core } = await connected();
    await expect(core.writeParam('dbg.echo_f32', 2, 'gui')).resolves.toBe(2);
  });
});

describe('console', () => {
  it('relaie une commande et journalise la réponse du device', async () => {
    const { core, logs } = await connected();
    expect(await core.sendConsole('PING')).toBe('OK');
    expect(logs.some((l) => l.source === 'device' && l.text === 'OK')).toBe(true);
  });

  it('répond à STOP et coupe la sortie de puissance', async () => {
    // Le bouton STOP de l'interface s'appuie sur cette commande. Elle a été spécifiée dès
    // le départ mais n'existait pas dans le firmware : le bouton répondait ERR CMD, donc
    // ne faisait rien tout en paraissant agir. Ce test est là pour que ça ne se reproduise
    // pas — une commande d'arrêt qui échoue en silence est pire que pas de bouton.
    const { core } = await connected();
    expect(await core.sendConsole('STOP')).toBe('OK');
    expect(await core.sendConsole('PWM?')).toBe('OK enabled=0');
  });

  it('rapporte un auto-test réel, vecteurs à l’appui', async () => {
    const { core } = await connected();
    const reply = await core.sendConsole('SELFTEST');
    expect(reply).toMatch(/^OK /);
    expect(reply).toMatch(/failed=0/);
    expect(reply).toMatch(/dict_ok=1/);
    // Un auto-test qui n'a exécuté aucun vecteur ne vaut pas un succès.
    expect(Number(/total=(\d+)/.exec(reply)?.[1] ?? 0)).toBeGreaterThan(0);
  });
});

describe('scope', () => {
  it('capture les quatre premiers signaux par défaut, en immédiat', async () => {
    const { core } = await connected();
    const { signals, capture } = await core.captureScope({ depth: 256 });

    expect(signals).toHaveLength(4);
    expect(capture.samples).toHaveLength(256);
    expect(capture.samples[0]).toHaveLength(4);
  });

  it('désigne les signaux par nom, jamais par identifiant', async () => {
    // L'appelant travaille avec le dictionnaire publié par le firmware ; la numérotation
    // reste une affaire interne au protocole.
    const { core } = await connected();
    const { signals } = await core.captureScope({
      depth: 64,
      signalNames: ['loop.load_pct', 'current.raw_ia_count'],
    });

    expect(signals.map((s) => s.name)).toEqual(['loop.load_pct', 'current.raw_ia_count']);
  });

  it('rejette un nom de signal inconnu', async () => {
    const { core } = await connected();
    await expect(core.captureScope({ signalNames: ['nope'] })).rejects.toThrow('unknown signal');
  });

  it('refuse plus de quatre signaux', async () => {
    const { core } = await connected();
    const names = (await core.readSignals()).slice(0, 5).map((s) => s.name);
    await expect(core.captureScope({ signalNames: names })).rejects.toThrow('1 to 4');
  });

  it('accepte une configuration de déclenchement complète', async () => {
    const { core } = await connected();
    const { capture } = await core.captureScope({
      depth: 128,
      decimation: 4,
      pretriggerSamples: 32,
      triggerMode: ScopeTrigger.RISING,
      triggerSignalName: 'current.raw_ia_count',
      threshold: 2048,
      signalNames: ['current.raw_ia_count', 'loop.load_pct'],
    });

    // La configuration rendue est celle que le firmware a normalisée, pas celle demandée.
    expect(capture.config.decimation).toBe(4);
    expect(capture.config.pretriggerSamples).toBe(32);
    expect(capture.config.triggerMode).toBe(ScopeTrigger.RISING);
    expect(capture.status.samplePeriodNs).toBe(50_000 * 4);
  });

  it('exige que le signal de déclenchement soit capturé', async () => {
    // Sans cela, le point de déclenchement n'apparaîtrait sur aucune courbe tracée — et le
    // firmware refuserait la configuration de toute façon, avec un message moins clair.
    const { core } = await connected();
    await expect(
      core.captureScope({
        triggerMode: ScopeTrigger.RISING,
        triggerSignalName: 'loop.load_pct',
        signalNames: ['current.raw_ia_count'],
      }),
    ).rejects.toThrow('must be one of the captured signals');
  });

  it('refuse un pretrigger qui ne tient pas dans la profondeur', async () => {
    const { core } = await connected();
    await expect(
      core.captureScope({ depth: 16, pretriggerSamples: 16 }),
    ).rejects.toThrow('pretrigger must be below depth');
  });
});

describe('télémétrie continue', () => {
  /** Attend `n` trames sur le flux souscrit, ou échoue au bout de 3 s. */
  async function collect(core: DeviceCore, n: number): Promise<TelemFrame[]> {
    const got: TelemFrame[] = [];
    return new Promise<TelemFrame[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`only ${got.length}/${n} frames`));
      }, 3000);
      const off = core.onTelemetry.on((f) => {
        got.push(f);
        if (got.length >= n) {
          clearTimeout(timer);
          off();
          resolve(got);
        }
      });
    });
  }

  it('ouvre un flux qui dure et pousse les trames', async () => {
    const { core } = await connected();
    const state = await core.startTelemetry(['loop.load_pct'], 500);

    expect(state.signalNames).toEqual(['loop.load_pct']);
    expect(state.units).toEqual(['%']);
    // Le firmware choisit un diviseur entier de la boucle : c'est la cadence retenue qui
    // est publiée, pas celle demandée.
    expect(state.rateHz).toBe(500);

    const frames = await collect(core, 5);
    expect(frames).toHaveLength(5);
    expect(frames[0]?.values).toHaveLength(1);
  });

  it("publie l'abonnement dans le snapshot", async () => {
    // Le device n'accepte qu'un seul abonnement : à quoi l'interface s'est abonnée fait
    // partie de l'état partagé, pas d'un détail interne.
    const { core } = await connected();
    expect(core.snapshot().telemetry).toBeNull();

    await core.startTelemetry(['loop.load_pct', 'loop.duration_ns'], 200);
    expect(core.snapshot().telemetry?.signalNames).toEqual([
      'loop.load_pct',
      'loop.duration_ns',
    ]);

    await core.stopTelemetry();
    expect(core.snapshot().telemetry).toBeNull();
  });

  it('coupe le flux à la déconnexion', async () => {
    const { core } = await connected();
    await core.startTelemetry(['loop.load_pct'], 200);
    await core.disconnect();
    expect(core.snapshot().telemetry).toBeNull();
  });

  it('rétablit le flux après un burst pris par un agent', async () => {
    // C'est le vrai piège : le device n'a qu'un abonnement, et sampleTelemetry le
    // réécrivait. Un agent qui échantillonnait faisait décrocher les courbes de
    // l'interface, sans que rien ne le dise.
    const { core, logs } = await connected();
    await core.startTelemetry(['loop.load_pct'], 500);
    const before = core.snapshot().telemetry;

    await core.sampleTelemetry(5, 100, ['current.raw_ia_count']);

    expect(core.snapshot().telemetry).toEqual(before);
    expect(logs.some((l) => l.text.includes('paused for a burst sample'))).toBe(true);

    // Et le flux rétabli pousse réellement à nouveau.
    const frames = await collect(core, 3);
    expect(frames[0]?.values).toHaveLength(1);
  });

  it('laisse le flux coupé si rien ne tournait avant le burst', async () => {
    const { core } = await connected();
    await core.sampleTelemetry(5, 100, ['loop.load_pct']);
    expect(core.snapshot().telemetry).toBeNull();
  });

  it('refuse une sélection vide ou trop large', async () => {
    const { core } = await connected();
    await expect(core.startTelemetry([], 200)).resolves.toBeDefined(); // vide = tous
    const names = (await core.readSignals()).map((s) => s.name);
    await expect(core.startTelemetry([...names, ...names], 200)).rejects.toThrow('1 to 16');
    await expect(core.startTelemetry(['nope'], 200)).rejects.toThrow('unknown signal');
  });
});

describe('attribution dans le journal', () => {
  it('attribue une capture à son appelant, pas à une constante', async () => {
    // Le journal sert à distinguer qui a fait quoi. `captureScope` et `sampleTelemetry`
    // journalisaient en dur comme `mcp` : une capture lancée depuis l'interface
    // s'affichait comme une action d'agent, ce qui vide la traçabilité de son sens.
    const { core, logs } = await connected();

    await core.captureScope({ depth: 64 });
    const fromGui = logs.find((l) => l.text.startsWith('captured '));
    expect(fromGui?.source).toBe('gui');

    await core.captureScope({ depth: 64 }, 'mcp');
    const fromMcp = logs.filter((l) => l.text.startsWith('captured ')).at(-1);
    expect(fromMcp?.source).toBe('mcp');
  });

  it("attribue un échantillon de télémétrie de la même façon", async () => {
    const { core, logs } = await connected();
    await core.sampleTelemetry(3, 500, ['loop.load_pct']);
    expect(logs.find((l) => l.text.startsWith('sampled '))?.source).toBe('gui');
  });
});
