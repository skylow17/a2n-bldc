/**
 * Le serveur MCP vu comme un client le voit.
 *
 * Les outils sont exercés à travers un vrai client MCP branché sur un transport en
 * mémoire, pas en appelant les handlers directement : ce qui est testé est donc la surface
 * réellement publiée — noms, schémas, contenu des résultats — et pas une fonction interne
 * qui se trouverait être appelée par un outil.
 *
 * Le device est le simulateur. Il parle le même protocole que la carte, ce qui rend ces
 * tests représentatifs du chemin de bout en bout, à l'exception du port série lui-même.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { DeviceCore, type LogEntry } from '../../device/DeviceCore.js';
import { createA2nMcpServer } from '../server.js';

interface Harness {
  core: DeviceCore;
  client: Client;
  logs: LogEntry[];
  close: () => Promise<void>;
}

const open: Harness[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

async function harness(connect = true): Promise<Harness> {
  const core = new DeviceCore();
  const logs: LogEntry[] = [];
  core.onLog.on((e) => logs.push(e));

  const { server, dispose } = createA2nMcpServer(core);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  if (connect) await core.connect({ kind: 'simulator' });

  const h: Harness = {
    core,
    client,
    logs,
    close: async () => {
      dispose();
      await client.close();
      await server.close();
      await core.disconnect(true);
    },
  };
  open.push(h);
  return h;
}

/** Rend le texte du résultat, et dit si l'outil a répondu par une erreur. */
async function call(
  h: Harness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const res = await h.client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string }> | undefined;
  const text = content?.map((c) => c.text ?? '').join('\n') ?? '';
  return { text, isError: res.isError === true };
}

async function json<T>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { text, isError } = await call(h, name, args);
  if (isError) throw new Error(`tool ${name} returned an error: ${text}`);
  return JSON.parse(text) as T;
}

/* ------------------------------------------------------------------ surface */

describe('surface publiée', () => {
  it('publie les familles prévues et rien de plus', async () => {
    const h = await harness(false);
    const names = (await h.client.listTools()).tools.map((t) => t.name).sort();

    expect(names).toEqual([
      'console_send',
      'device_connect',
      'device_disconnect',
      'device_list_ports',
      'device_status',
      'log_read',
      'param_get',
      'param_list',
      'param_reset_defaults',
      'param_set',
      'scope_capture',
      'telemetry_sample',
      'telemetry_signals',
    ]);
  });

  it("n'expose aucun outil capable d'activer « AI control »", async () => {
    const h = await harness(false);
    const tools = (await h.client.listTools()).tools;

    // Le toggle est une action humaine dans l'interface. Un outil qui l'activerait viderait
    // la barrière de son sens, et c'est le genre de chose qu'on ajoute par mégarde en
    // exposant « toutes les méthodes du DeviceCore ».
    for (const t of tools) {
      expect(t.name).not.toMatch(/ai.?control|enable/i);
      expect(JSON.stringify(t.inputSchema)).not.toMatch(/aiControl/i);
    }
  });

  it("n'expose ni armement, ni consigne, ni mouvement", async () => {
    const h = await harness(false);
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    for (const forbidden of ['arm', 'disarm', 'motion', 'setpoint', 'jog', 'move']) {
      expect(names.some((n) => n.includes(forbidden))).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ device */

describe('device', () => {
  it('se connecte au simulateur et rend un état lisible', async () => {
    const h = await harness(false);
    await json(h, 'device_connect', { target: 'simulator' });

    const status = await json<{
      connection: string;
      dictionaryIntegrity: boolean;
      aiControlEnabled: boolean;
      parameterCount: number;
      info: { product: string } | null;
    }>(h, 'device_status');

    expect(status.connection).toBe('connected');
    expect(status.dictionaryIntegrity).toBe(true);
    expect(status.aiControlEnabled).toBe(false);
    expect(status.parameterCount).toBeGreaterThan(0);
    expect(status.info?.product).toBe('A2N-BLDC');
  });

  it('rend une erreur lisible plutôt qu\'un échec de transport', async () => {
    const h = await harness(false);
    const res = await call(h, 'param_get', { names: ['pwm.freq_hz'] });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('no device connected');
  });
});

/* ------------------------------------------------------------------ paramètres */

describe('paramètres', () => {
  it('rend le dictionnaire du firmware, filtrable', async () => {
    const h = await harness();
    const all = await json<unknown[]>(h, 'param_list');
    expect(all.length).toBe(h.core.snapshot().params.length);

    const pwm = await json<Array<{ name: string; unit: string; flags: string[] }>>(
      h,
      'param_list',
      { filter: 'pwm.' },
    );
    expect(pwm.length).toBeGreaterThan(0);
    expect(pwm.every((p) => p.name.startsWith('pwm.'))).toBe(true);
  });

  it('marque les paramètres en lecture seule', async () => {
    const h = await harness();
    const params = await json<Array<{ name: string; flags: string[] }>>(h, 'param_list', {
      filter: 'board.sysclk_hz',
    });
    expect(params[0]?.flags).toContain('read_only');
  });

  it('refuse une écriture tant que « AI control » est off, en disant quoi faire', async () => {
    const h = await harness();
    const res = await call(h, 'param_set', { name: 'dbg.echo_f32', value: 1.5 });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('AI control is off');
    expect(res.text).toContain('interface');
  });

  it('refuse aussi la remise aux valeurs par défaut', async () => {
    const h = await harness();
    // C'est l'écriture la plus large qui soit : elle ne peut pas être moins gardée que
    // l'écriture unitaire.
    const res = await call(h, 'param_reset_defaults');
    expect(res.isError).toBe(true);
    expect(res.text).toContain('AI control is off');
  });

  it('écrit une fois « AI control » activé, et rend la valeur réellement retenue', async () => {
    const h = await harness();
    h.core.setAiControl(true);

    const res = await json<{ requested: number; stored: number }>(h, 'param_set', {
      name: 'dbg.echo_f32',
      value: 1.5,
    });
    expect(res.requested).toBe(1.5);
    expect(res.stored).toBe(1.5);

    const back = await json<Array<{ name: string; value: number }>>(h, 'param_get', {
      names: ['dbg.echo_f32'],
    });
    expect(back[0]?.value).toBe(1.5);
  });

  it('rejette un nom de paramètre inconnu', async () => {
    const h = await harness();
    h.core.setAiControl(true);
    const res = await call(h, 'param_set', { name: 'nope.nothing', value: 1 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('unknown parameter');
  });
});

/* ------------------------------------------------------------------ télémétrie, scope */

describe('télémétrie et scope', () => {
  it('rend le dictionnaire de signaux', async () => {
    const h = await harness();
    const signals = await json<Array<{ id: number; name: string; unit: string }>>(
      h,
      'telemetry_signals',
    );
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.some((s) => s.name === 'loop.load_pct')).toBe(true);
  });

  it('résume un échantillon de télémétrie et compte les trames perdues', async () => {
    const h = await harness();
    const res = await json<{
      frames: number;
      droppedFrames: number;
      appliedRateHz: number;
      signals: Array<{ name: string; unit: string; min: number; max: number; mean: number }>;
    }>(h, 'telemetry_sample', { frames: 10, rate_hz: 500, signals: ['loop.load_pct'] });

    expect(res.frames).toBe(10);
    expect(res.droppedFrames).toBe(0);
    expect(res.appliedRateHz).toBe(500);
    expect(res.signals).toHaveLength(1);
    expect(res.signals[0]?.name).toBe('loop.load_pct');
    expect(res.signals[0]?.min).toBeLessThanOrEqual(res.signals[0]!.max);
  });

  it('capture au scope sans déverser les points par défaut', async () => {
    const h = await harness();
    const res = await json<{
      captured: number;
      state: string;
      samples?: unknown;
      signals: Array<{ name: string }>;
    }>(h, 'scope_capture', { depth: 512, signals: ['current.raw_ia_count'] });

    expect(res.captured).toBe(512);
    expect(res.state).toBe('complete');
    expect(res.signals).toHaveLength(1);
    // 512 points rendus tels quels noieraient la fenêtre de l'agent pour rien.
    expect(res.samples).toBeUndefined();
  });

  it('décime les points quand on les demande, en gardant les extrémités', async () => {
    const h = await harness();
    const res = await json<{ samples: Array<{ name: string; values: number[] }> }>(
      h,
      'scope_capture',
      {
        depth: 512,
        signals: ['current.raw_ia_count'],
        include_samples: true,
        max_points: 16,
      },
    );

    expect(res.samples).toHaveLength(1);
    expect(res.samples[0]?.values).toHaveLength(16);
  });

  it('refuse plus de quatre signaux au scope', async () => {
    const h = await harness();
    const res = await call(h, 'scope_capture', {
      signals: ['current.raw_ia_count', 'current.raw_ib_count', 'current.raw_ic_count',
                'loop.duration_ns', 'loop.load_pct'],
    });
    expect(res.isError).toBe(true);
  });
});

/* ------------------------------------------------------------------ console, journal */

describe('console et journal', () => {
  it('accepte une commande de diagnostic', async () => {
    const h = await harness();
    const res = await json<{ command: string; response: string }>(h, 'console_send', {
      line: 'SELFTEST',
    });
    expect(res.response).toContain('OK');
  });

  it('refuse une commande hors de la liste blanche, en la nommant', async () => {
    const h = await harness();
    const res = await call(h, 'console_send', { line: 'ARM' });

    // Refuser bruyamment plutôt que filtrer en silence : l'agent doit savoir que la
    // commande existe et qu'elle ne lui est pas ouverte.
    expect(res.isError).toBe(true);
    expect(res.text).toContain('not allowed');
    expect(res.text).toContain('ARM');
  });

  it('journalise chaque appel avec ses arguments et son résultat, source mcp', async () => {
    const h = await harness();
    await call(h, 'param_list', { filter: 'pwm.' });

    const mcp = h.logs.filter((e) => e.source === 'mcp');
    expect(mcp.some((e) => e.text.startsWith('param_list(') && e.text.includes('pwm.'))).toBe(true);
    expect(mcp.some((e) => e.text.startsWith('param_list ->'))).toBe(true);
  });

  it('journalise un refus en erreur', async () => {
    const h = await harness();
    await call(h, 'param_set', { name: 'dbg.echo_f32', value: 1.5 });

    const refusal = h.logs.find((e) => e.source === 'mcp' && e.level === 'error');
    expect(refusal?.text).toContain('param_set failed');
    expect(refusal?.text).toContain('AI control is off');
  });

  it('relit le journal partagé, filtrable par source', async () => {
    const h = await harness();
    await call(h, 'device_status');

    const entries = await json<Array<{ source: string; text: string; level: string }>>(
      h,
      'log_read',
      { limit: 20, source: 'mcp' },
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.source === 'mcp')).toBe(true);

    // Le journal est celui de l'interface : l'agent y voit ce que la connexion a produit.
    const all = await json<Array<{ source: string }>>(h, 'log_read', { limit: 200 });
    expect(all.some((e) => e.source === 'gui' || e.source === 'device')).toBe(true);
  });

  it('ne rend que les entrées au moins aussi graves que le niveau demandé', async () => {
    const h = await harness();
    await call(h, 'param_set', { name: 'dbg.echo_f32', value: 1.5 });

    const errors = await json<Array<{ level: string }>>(h, 'log_read', { level: 'error' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.level === 'error')).toBe(true);
  });
});
