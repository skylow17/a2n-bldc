/**
 * CLI de bring-up du firmware.
 *
 * Bâtie sur `src/shared/`, le codec définitif — pas un script jetable. C'est le premier
 * consommateur du protocole, et il sert à valider le firmware bien avant que l'application
 * existe. La même chose vaut dans l'autre sens : tout ce que la CLI sait faire, l'UI et le
 * serveur MCP le feront par le même chemin.
 *
 *   node src/cli/main.ts <commande> [options]
 *
 * `--sim` remplace la carte par le device simulé : toutes les commandes fonctionnent sans
 * matériel, ce qui permet de mettre au point l'outil et de rejouer un scénario à volonté.
 */

import { parseArgs } from 'node:util';

import { DeviceClient } from '../shared/client.js';
import { PARAM_STATUS_NAME, ParamStatus } from '../shared/messages.js';
import {
  PARAM_FLAG,
  clampToParam,
  paramDictHash,
  type ParamDesc,
  type ParamDictionary,
} from '../shared/params.js';
import { PROTO_CAP, type DeviceInfo } from '../shared/protocol.js';
import { SimulatedDevice } from '../shared/simulator.js';
import type { Transport } from '../shared/transport.js';
import { SerialTransport, findBoardPorts, listSerialPorts } from '../node/serial.js';

/* ------------------------------------------------------------------ présentation */

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const useColor = process.stdout.isTTY && process.env['NO_COLOR'] === undefined;
const paint = (code: string, text: string): string => (useColor ? `${code}${text}${C.reset}` : text);

const ok = (t: string): string => paint(C.green, t);
const bad = (t: string): string => paint(C.red, t);
const warn = (t: string): string => paint(C.yellow, t);
const dim = (t: string): string => paint(C.dim, t);
const head = (t: string): string => paint(C.bold + C.cyan, t);

function table(rows: string[][], headers: string[]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]): string =>
    r.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ').trimEnd();
  return [
    dim(line(headers)),
    dim(widths.map((w) => '─'.repeat(w)).join('  ')),
    ...rows.map(line),
  ].join('\n');
}

/** Affiche un nombre sans décimales parasites : 20000, 1.5, 3.14159. */
function num(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(7)));
}

function flagsText(p: ParamDesc): string {
  const f: string[] = [];
  if (p.flags & PARAM_FLAG.READ_ONLY) f.push('ro');
  if (p.flags & PARAM_FLAG.PERSISTENT) f.push('nvm');
  if (p.flags & PARAM_FLAG.REQUIRES_DISARM) f.push('disarm');
  if (p.flags & PARAM_FLAG.ADVANCED) f.push('adv');
  if (p.flags & PARAM_FLAG.CALIBRATED) f.push('cal');
  return f.join(',');
}

/* ------------------------------------------------------------------ connexion */

interface GlobalOptions {
  port?: string;
  sim: boolean;
  timeout: number;
}

async function openTransport(o: GlobalOptions): Promise<Transport> {
  if (o.sim) return new SimulatedDevice();

  let path = o.port;
  if (path === undefined) {
    const candidates = await findBoardPorts();
    if (candidates.length === 0) {
      const all = await listSerialPorts();
      throw new Error(
        `no A2N board found (VID 0483 / PID 5740).\n` +
          (all.length === 0
            ? '  No serial port on this machine.'
            : `  Ports present: ${all.map((p) => p.path).join(', ')}\n` +
              '  Pass --port COMx, or use --sim.'),
      );
    }
    if (candidates.length > 1) {
      throw new Error(
        `several boards found (${candidates.map((p) => p.path).join(', ')}): ` +
          'pass --port',
      );
    }
    path = candidates[0]!.path;
  }
  return SerialTransport.open(path);
}

async function withClient<T>(
  o: GlobalOptions,
  fn: (client: DeviceClient) => Promise<T>,
): Promise<T> {
  const transport = await openTransport(o);
  const client = new DeviceClient(transport, { timeoutMs: o.timeout });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/* ------------------------------------------------------------------ commandes */

function printInfo(info: DeviceInfo): void {
  const caps = Object.entries(PROTO_CAP)
    .filter(([, bit]) => (info.capabilities & bit) !== 0)
    .map(([name]) => name.toLowerCase());

  console.log(head('Device'));
  console.log(
    table(
      [
        ['product', info.product],
        ['firmware', info.fwVersion],
        ['protocol', `${info.protocolMajor}.${info.protocolMinor}`],
        ['uid', info.uid.map((u) => u.toString(16).padStart(8, '0')).join('-')],
        ['parameters', String(info.paramCount)],
        ['telemetry signals', String(info.telemSignalCount)],
        ['dict_hash', info.paramDictHash.toString(16).toUpperCase().padStart(8, '0')],
        ['capabilities', caps.length > 0 ? caps.join(', ') : dim('none')],
      ],
      ['field', 'value'],
    ),
  );
}

async function cmdPorts(): Promise<number> {
  const ports = await listSerialPorts();
  if (ports.length === 0) {
    console.log(dim('no serial port'));
    return 0;
  }
  const board = new Set((await findBoardPorts()).map((p) => p.path));
  console.log(
    table(
      ports.map((p) => [
        p.path,
        board.has(p.path) ? ok('A2N board') : '',
        p.manufacturer ?? '',
        p.vendorId !== undefined ? `${p.vendorId}:${p.productId ?? '????'}` : '',
      ]),
      ['port', '', 'manufacturer', 'vid:pid'],
    ),
  );
  return 0;
}

async function cmdInfo(o: GlobalOptions): Promise<number> {
  return withClient(o, async (c) => {
    printInfo(await c.hello());
    return 0;
  });
}

async function cmdDict(o: GlobalOptions, filter?: string): Promise<number> {
  return withClient(o, async (c) => {
    const info = await c.hello();
    const dict = await c.readDictionary();
    const values = await c.readParams(dict.entries.map((p) => p.id));
    const byId = new Map(values.map((v) => [v.id, v]));

    for (const group of dict.groups()) {
      const rows = dict.entries
        .filter((p) => p.group === group)
        .filter((p) => filter === undefined || p.name.includes(filter))
        .map((p) => {
          const v = byId.get(p.id);
          const shown =
            v === undefined || v.status !== ParamStatus.OK
              ? bad(PARAM_STATUS_NAME[v?.status ?? 1] ?? '?')
              : num(v.value);
          return [
            p.name,
            shown,
            p.unit,
            `${num(p.min)} … ${num(p.max)}`,
            num(p.def),
            dim(flagsText(p)),
          ];
        });
      if (rows.length === 0) continue;
      console.log(head(group));
      console.log(table(rows, ['name', 'value', 'unit', 'range', 'default', 'flags']));
      console.log();
    }

    // Le contrôle qui compte : le hash recalculé sur ce qui a été reçu doit retomber sur
    // celui du handshake. C'est le critère de validation de M1b.
    const recomputed = paramDictHash(dict.entries);
    const hex = (n: number): string => n.toString(16).toUpperCase().padStart(8, '0');
    if (recomputed === info.paramDictHash) {
      console.log(`${ok('✓')} hash ${hex(recomputed)} — ${dict.size} entries, transfer intact`);
      return 0;
    }
    console.log(
      `${bad('✗')} hash announced ${hex(info.paramDictHash)}, recomputed ${hex(recomputed)}`,
    );
    return 1;
  });
}

async function cmdGet(o: GlobalOptions, names: string[]): Promise<number> {
  if (names.length === 0) {
    console.error(bad('get expects at least one parameter name'));
    return 2;
  }
  return withClient(o, async (c) => {
    await c.hello();
    const dict = await c.readDictionary();

    const unknown = names.filter((n) => dict.get(n) === undefined);
    if (unknown.length > 0) {
      console.error(bad(`unknown parameter: ${unknown.join(', ')}`));
      return 2;
    }

    const ids = names.map((n) => dict.get(n)!.id);
    const results = await c.readParams(ids);
    console.log(
      table(
        results.map((r, i) => {
          const p = dict.get(names[i]!)!;
          return [
            p.name,
            r.status === ParamStatus.OK ? num(r.value) : bad(PARAM_STATUS_NAME[r.status] ?? '?'),
            p.unit,
          ];
        }),
        ['name', 'value', 'unit'],
      ),
    );
    return results.every((r) => r.status === ParamStatus.OK) ? 0 : 1;
  });
}

async function cmdSet(o: GlobalOptions, name: string, raw: string): Promise<number> {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(bad(`not a number: ${raw}`));
    return 2;
  }
  return withClient(o, async (c) => {
    await c.hello();
    const dict = await c.readDictionary();
    const p = dict.get(name);
    if (p === undefined) {
      console.error(bad(`unknown parameter: ${name}`));
      return 2;
    }

    const clamped = clampToParam(p, value);
    if (clamped !== value) {
      console.log(warn(`clamped to [${num(p.min)}, ${num(p.max)}]: ${num(clamped)}`));
    }

    const [res] = await c.writeParams([{ id: p.id, value: clamped }]);
    if (res === undefined || res.status !== ParamStatus.OK) {
      console.error(bad(`rejected: ${PARAM_STATUS_NAME[res?.status ?? 1] ?? '?'}`));
      return 1;
    }

    // Relecture systématique : un accusé d'écriture n'est pas une preuve que la valeur est
    // celle qu'on croit — le firmware arrondit vers son type réel.
    const [after] = await c.readParams([p.id]);
    console.log(`${ok('✓')} ${p.name} = ${num(after?.value ?? Number.NaN)} ${p.unit}`.trimEnd());
    return 0;
  });
}

async function cmdConsole(o: GlobalOptions, line: string): Promise<number> {
  return withClient(o, async (c) => {
    const reply = await c.console(line);
    console.log(reply);
    return reply.startsWith('ERR') ? 1 : 0;
  });
}

async function cmdMonitor(o: GlobalOptions): Promise<number> {
  return withClient(o, async (c) => {
    console.log(dim('listening on the link — Ctrl+C to stop'));
    c.onLine((t) => console.log(`${dim(new Date().toISOString().slice(11, 23))} ${t}`));
    c.onPush((f) =>
      console.log(
        `${dim(new Date().toISOString().slice(11, 23))} push msg=0x${f.msgId
          .toString(16)
          .padStart(4, '0')} len=${f.payload.length}`,
      ),
    );
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => resolve());
    });
    return 0;
  });
}

/**
 * Séquence de validation de M1b, de bout en bout.
 *
 * C'est la commande à lancer sur une carte fraîchement flashée : elle enchaîne tout ce que
 * le jalon promet et rend un verdict unique, au lieu de laisser interpréter cinq sorties.
 */
async function cmdCheck(o: GlobalOptions): Promise<number> {
  return withClient(o, async (c) => {
    const failures: string[] = [];
    const step = (label: string, good: boolean, detail = ''): void => {
      console.log(`${good ? ok('✓') : bad('✗')} ${label}${detail ? ` ${dim(detail)}` : ''}`);
      if (!good) failures.push(label);
    };

    const info = await c.hello();
    step('handshake', true, `${info.product} ${info.fwVersion}`);
    step(
      'protocol version',
      info.protocolMajor === 2 && info.protocolMinor === 0,
      `${info.protocolMajor}.${info.protocolMinor}`,
    );

    const dict = await c.readDictionary();
    step(
      'dictionary complete',
      dict.size === info.paramCount,
      `${dict.size}/${info.paramCount} entries`,
    );

    const recomputed = paramDictHash(dict.entries);
    step(
      'dictionary hash',
      recomputed === info.paramDictHash,
      recomputed.toString(16).toUpperCase().padStart(8, '0'),
    );

    // Console ASCII sur le même lien : le démultiplexage doit tenir dans les deux sens.
    const pong = await c.console('PING');
    step('ASCII console', pong === 'OK', pong);

    // On exige `total > 0` : un auto-test qui n'a exécuté aucun vecteur ne vaut pas un
    // succès, et `failed=0` seul ne distingue pas les deux cas.
    const selftest = await c.console('SELFTEST');
    const ran = Number(/total=(\d+)/.exec(selftest)?.[1] ?? 0);
    step(
      'codec self-test',
      ran > 0 && /failed=0\b/.test(selftest) && /dict_ok=1\b/.test(selftest),
      selftest,
    );

    // Lecture des constantes réelles de la carte.
    try {
      const v = await c.readByName(dict, ['board.sysclk_hz', 'pwm.freq_hz', 'pwm.arr']);
      step(
        'board constants',
        v.get('board.sysclk_hz') === 144_000_000 &&
          v.get('pwm.freq_hz') === 20_000 &&
          v.get('pwm.arr') === 3599,
        `sysclk=${num(v.get('board.sysclk_hz') ?? 0)} pwm=${num(v.get('pwm.freq_hz') ?? 0)} arr=${num(v.get('pwm.arr') ?? 0)}`,
      );
    } catch (e) {
      step('board constants', false, e instanceof Error ? e.message : String(e));
    }

    // Écriture puis relecture : c'est le seul moyen de prouver que le chemin complet
    // fonctionne, accusé de réception compris.
    const target = dict.get('dbg.echo_f32');
    if (target === undefined) {
      step('write/read-back', false, 'dbg.echo_f32 missing from the dictionary');
    } else {
      const [w] = await c.writeParams([{ id: target.id, value: 12.5 }]);
      const [r] = await c.readParams([target.id]);
      step(
        'write then read back',
        w?.status === ParamStatus.OK && r?.value === 12.5,
        `wrote 12.5, read ${num(r?.value ?? Number.NaN)}`,
      );
      await c.resetDefaults();
    }

    // Un refus doit être un refus : une écriture en lecture seule ne doit pas passer.
    const ro = dict.entries.find((p) => (p.flags & PARAM_FLAG.READ_ONLY) !== 0);
    if (ro !== undefined) {
      const [w] = await c.writeParams([{ id: ro.id, value: 1 }]);
      step(
        'read-only write refused',
        w?.status === ParamStatus.ERR_READ_ONLY,
        `${ro.name} → ${PARAM_STATUS_NAME[w?.status ?? 0] ?? '?'}`,
      );
    }

    console.log();
    if (failures.length === 0) {
      console.log(ok('M1b validated on this device.'));
      return 0;
    }
    console.log(bad(`${failures.length} check(s) failed: ${failures.join(', ')}`));
    return 1;
  });
}

/* ------------------------------------------------------------------ entrée */

const USAGE = `
${head('a2n — A2N BLDC bring-up CLI')}

  node src/cli/main.ts <commande> [options]

${head('Commands')}
  ports                    list serial ports and spot the board
  info                     handshake and device identity
  check                    full M1b validation sequence
  dict [pattern]           parameter dictionary and current values
  get <name> [name...]     read one or more parameters
  set <name> <value>       write a parameter, then read it back
  console <command>        send a line to the ASCII console
  monitor                  print everything arriving on the link

${head('Options')}
  --port <COMx>            serial port; otherwise the board is found by its USB ids
  --sim                    simulated device, no hardware needed
  --timeout <ms>           response timeout (default 1000)

${head('Examples')}
  node src/cli/main.ts check --sim
  node src/cli/main.ts dict pwm
  node src/cli/main.ts set dbg.echo_f32 1.5
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      sim: { type: 'boolean', default: false },
      timeout: { type: 'string', default: '1000' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [command, ...rest] = positionals;

  if (values.help || command === undefined) {
    console.log(USAGE);
    return command === undefined && !values.help ? 2 : 0;
  }

  const o: GlobalOptions = {
    ...(values.port !== undefined && { port: values.port }),
    sim: values.sim,
    timeout: Number(values.timeout) || 1000,
  };

  switch (command) {
    case 'ports':
      return cmdPorts();
    case 'info':
      return cmdInfo(o);
    case 'check':
      return cmdCheck(o);
    case 'dict':
      return cmdDict(o, rest[0]);
    case 'get':
      return cmdGet(o, rest);
    case 'set':
      if (rest.length < 2) {
        console.error(bad('set expects a name and a value'));
        return 2;
      }
      return cmdSet(o, rest[0]!, rest[1]!);
    case 'console':
      if (rest.length === 0) {
        console.error(bad('console expects a command'));
        return 2;
      }
      return cmdConsole(o, rest.join(' '));
    case 'monitor':
      return cmdMonitor(o);
    default:
      console.error(bad(`unknown command: ${command}`));
      console.log(USAGE);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    console.error(bad(e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  });
