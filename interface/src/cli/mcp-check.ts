/**
 * Recette du serveur MCP, de bout en bout.
 *
 *   npm run mcp:check            contre le device simulé
 *   npm run mcp:check -- --port COM3   contre une vraie carte
 *
 * Le serveur est démarré dans ce processus, sur un transport en mémoire, et interrogé par
 * un vrai client MCP. Ce qui est vérifié est donc la surface publiée — celle qu'un agent
 * verra — et non une fonction interne.
 *
 * Pourquoi cet outil en plus des tests unitaires : les tests tournent contre le simulateur,
 * toujours. Celui-ci prend un `--port` et rejoue la même séquence sur la carte réelle, ce
 * qui est la seule façon de valider le serveur pour de bon. C'est la même règle que pour
 * les jalons firmware : le simulateur prouve la cohérence, la carte prouve le reste.
 *
 * Il ne demande **jamais** l'activation d'« AI control » et ne met rien en mouvement : il
 * vérifie au contraire que l'écriture est bien refusée sans elle.
 */

import { parseArgs } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { DeviceCore } from '../main/device/DeviceCore.js';
import { createA2nMcpServer } from '../main/mcp/server.js';
import { findBoardPorts } from '../node/serial.js';

const useColor = process.stdout.isTTY && process.env['NO_COLOR'] === undefined;
const paint = (code: string, text: string): string =>
  useColor ? `${code}${text}\x1b[0m` : text;
const ok = (t: string): string => paint('\x1b[32m', t);
const bad = (t: string): string => paint('\x1b[31m', t);
const dim = (t: string): string => paint('\x1b[2m', t);

let failures = 0;

function pass(what: string, detail = ''): void {
  console.log(`${ok('✓')} ${what}${detail === '' ? '' : ` ${dim(detail)}`}`);
}

function fail(what: string, detail: string): void {
  failures++;
  console.log(`${bad('✗')} ${what} ${detail}`);
}

function check(condition: boolean, what: string, detail = ''): void {
  if (condition) pass(what, detail);
  else fail(what, detail === '' ? '(condition non remplie)' : detail);
}

interface ToolOutcome {
  text: string;
  isError: boolean;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: 'string' },
      sim: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help === true) {
    console.log('usage: mcp-check [--port COMx | --sim]');
    console.log('  Sans option, utilise la carte si une seule est branchée, sinon le simulateur.');
    return 0;
  }

  const core = new DeviceCore();
  const { server, dispose } = createA2nMcpServer(core);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'a2n-mcp-check', version: '0.1.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const callTool = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolOutcome> => {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as Array<{ text?: string }> | undefined;
    return {
      text: content?.map((c) => c.text ?? '').join('\n') ?? '',
      isError: res.isError === true,
    };
  };
  const callJson = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const r = await callTool(name, args);
    if (r.isError) throw new Error(`${name}: ${r.text}`);
    return JSON.parse(r.text) as T;
  };

  try {
    /* -------------------------------------------------- surface */

    const tools = (await client.listTools()).tools;
    check(tools.length > 0, 'tool list', `${tools.length} tools`);
    check(
      !tools.some((t) => /ai.?control|enable/i.test(t.name)),
      'no tool can enable AI control',
    );
    check(
      !tools.some((t) => /(^|_)(arm|disarm|jog|move|setpoint|motion)(_|$)/.test(t.name)),
      'no motion tool exposed',
    );

    /* -------------------------------------------------- connexion */

    let target: Record<string, unknown> = { target: 'simulator' };
    if (values.sim !== true) {
      const path = values.port ?? (await findBoardPorts().then((p) => p[0]?.path));
      if (path !== undefined) target = { target: 'serial', path };
    }
    const connected = await callJson<{ connection: string; info: { product: string; fwVersion: string } | null }>(
      'device_connect',
      target,
    );
    check(connected.connection === 'connected', 'device_connect',
      `${connected.info?.product ?? '?'} ${connected.info?.fwVersion ?? ''} ` +
      `(${target['target'] === 'serial' ? String(target['path']) : 'simulator'})`);

    const status = await callJson<{
      dictionaryIntegrity: boolean | null;
      parameterCount: number;
      aiControlEnabled: boolean;
    }>('device_status');
    check(status.dictionaryIntegrity === true, 'dictionary integrity');
    check(status.parameterCount > 0, 'device_status', `${status.parameterCount} parameters`);
    check(status.aiControlEnabled === false, 'AI control starts off');

    /* -------------------------------------------------- lecture */

    const params = await callJson<Array<{ name: string }>>('param_list', { filter: 'pwm.' });
    check(params.length > 0, 'param_list', `${params.length} pwm parameters`);

    const signals = await callJson<Array<{ name: string }>>('telemetry_signals');
    check(signals.length > 0, 'telemetry_signals', `${signals.length} signals`);

    const telem = await callJson<{ frames: number; droppedFrames: number; appliedRateHz: number }>(
      'telemetry_sample',
      { frames: 20, rate_hz: 500 },
    );
    check(
      telem.frames === 20 && telem.droppedFrames === 0,
      'telemetry_sample',
      `${telem.frames} frames at ${telem.appliedRateHz} Hz, ${telem.droppedFrames} dropped`,
    );

    const scope = await callJson<{ captured: number; state: string; samples?: unknown }>(
      'scope_capture',
      { depth: 512 },
    );
    check(
      scope.captured === 512 && scope.state === 'complete',
      'scope_capture',
      `${scope.captured} points, ${scope.state}`,
    );
    check(scope.samples === undefined, 'scope_capture withholds raw points by default');

    const console_ = await callJson<{ response: string }>('console_send', { line: 'SELFTEST' });
    check(console_.response.includes('OK'), 'console_send SELFTEST', console_.response.slice(0, 60));

    /* -------------------------------------------------- barrières */

    const refusedWrite = await callTool('param_set', { name: 'dbg.echo_f32', value: 1.5 });
    check(
      refusedWrite.isError && refusedWrite.text.includes('AI control is off'),
      'param_set refused while AI control is off',
    );

    const refusedReset = await callTool('param_reset_defaults');
    check(
      refusedReset.isError && refusedReset.text.includes('AI control is off'),
      'param_reset_defaults refused while AI control is off',
    );

    const refusedConsole = await callTool('console_send', { line: 'ARM' });
    check(
      refusedConsole.isError && refusedConsole.text.includes('not allowed'),
      'console_send refuses a command outside the allow-list',
    );

    /* -------------------------------------------------- journal */

    const log = await callJson<Array<{ source: string }>>('log_read', { limit: 100 });
    check(
      log.some((e) => e.source === 'mcp') && log.some((e) => e.source !== 'mcp'),
      'log_read shows the shared journal',
      `${log.length} entries`,
    );

    await callTool('device_disconnect');
  } catch (e) {
    fail('unexpected failure', e instanceof Error ? e.message : String(e));
  } finally {
    dispose();
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await core.disconnect(true).catch(() => undefined);
  }

  console.log();
  if (failures === 0) {
    console.log(ok('MCP surface validated on this device.'));
    return 0;
  }
  console.log(bad(`${failures} check(s) failed.`));
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(bad(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
