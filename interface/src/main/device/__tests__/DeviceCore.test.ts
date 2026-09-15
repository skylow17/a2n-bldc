/**
 * Le DeviceCore face au device simulé.
 *
 * C'est la logique que l'UI se contente de refléter : la tester ici vaut mieux que de
 * cliquer dans la fenêtre, et couvre aussi le chemin qu'emprunteront la CLI et le serveur
 * MCP, puisque c'est le même.
 */

import { describe, expect, it } from 'vitest';

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
    await expect(core.writeParam('pwm.arr', 1234)).rejects.toThrow(/refus/i);
    expect(core.snapshot().params.find((p) => p.name === 'pwm.arr')?.value).toBe(3599);
  });

  it('rejette un paramètre inconnu', async () => {
    const { core } = await connected();
    await expect(core.writeParam('pid.iq.kp', 1)).rejects.toThrow(/inconnu/);
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
    await expect(core.writeParam('dbg.echo_f32', 1, 'mcp')).rejects.toThrow(/agent/i);
  });

  it('laisse passer une fois le contrôle activé, et le journalise', async () => {
    const { core, logs } = await connected();
    core.setAiControl(true);
    await core.writeParam('dbg.echo_f32', 3.5, 'mcp');

    expect(core.snapshot().params.find((p) => p.name === 'dbg.echo_f32')?.value).toBe(3.5);
    // La source doit rester visible dans le journal : une action d'agent ne doit pas être
    // indiscernable d'une action humaine.
    expect(logs.some((l) => l.source === 'mcp' && l.text.includes('dbg.echo_f32'))).toBe(true);
    expect(logs.some((l) => l.level === 'warn' && l.text.includes('ACTIVÉ'))).toBe(true);
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
