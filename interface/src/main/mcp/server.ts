/**
 * Serveur MCP — la même carte, vue par un agent.
 *
 * Il tourne dans le processus principal Electron et reçoit **le `DeviceCore` de
 * l'interface**, pas une instance à lui. C'est toute l'idée : l'agent et l'humain partagent
 * la connexion, l'état et le journal. Un paramètre écrit par l'agent bouge dans l'UI, et
 * une commande de l'agent apparaît dans la console commune, source `mcp`, avec ses
 * arguments et son résultat.
 *
 * Trois règles structurent ce fichier, dans l'ordre d'importance :
 *
 * 1. **Aucun outil n'a de chemin dédié vers la carte.** Chaque handler appelle une méthode
 *    du `DeviceCore` que l'UI utilise déjà. Si un outil MCP pouvait faire quelque chose que
 *    l'UI ne peut pas, ce serait un trou dans l'UI, pas un besoin du MCP.
 * 2. **La barrière « Enable AI control » vit dans le `DeviceCore`**, pas ici. Ce fichier ne
 *    la réimplémente pas : il laisse remonter le refus. Une barrière recopiée est une
 *    barrière qui finit par diverger. Et il n'existe **aucun outil pour l'activer** —
 *    c'est une action humaine dans l'UI, point.
 * 3. **Rien qui mette le moteur en mouvement n'est exposé.** Ni `ARM`, ni consigne, ni
 *    mouvement. Ces fonctions existent dans le firmware depuis M3 — `ARM`, `OL`, `CL` — et
 *    restent hors de portée : la console MCP n'en laisse passer que les lectures d'état
 *    (`OL?`, `CL?`). Si un jour elles sont exposées, elles le seront gated.
 *
 * Nommage des outils : `famille_action`, avec des underscores. `interface/AGENTS.md` §5
 * prévoit `device.*`, `param.*`, etc. ; les clients MCP courants n'acceptent que
 * `[a-zA-Z0-9_-]` dans un nom d'outil, donc le point devient un underscore. Les familles
 * sont inchangées.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import { A2N_USB_PID, A2N_USB_VID } from '../../node/serial.js';
import { PARAM_FLAG, PARAM_TYPE_NAME } from '../../shared/params.js';
import { ScopeState } from '../../shared/protocol.js';
import type { DeviceCore, LogEntry, LogLevel } from '../device/DeviceCore.js';
import { column, decimateSeries, round6, summarizeSeries } from './summarize.js';

export const A2N_MCP_NAME = 'a2n-bldc';
export const A2N_MCP_VERSION = '0.1.0';

/** Nom lisible d'un état de scope, dérivé de la table du protocole plutôt que recopié. */
const SCOPE_STATE_NAME: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(Object.entries(ScopeState).map(([k, v]) => [v, k.toLowerCase()])),
);

/** Profondeur du journal relu par `log_read`. Au-delà, l'UI reste la bonne fenêtre. */
const LOG_BUFFER_SIZE = 500;

/** Plafond de points rendus par `scope_capture`, même si l'agent en demande plus. */
const MAX_RENDERED_POINTS = 256;

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): ToolResult {
  // `isError` plutôt qu'une exception : l'agent doit pouvoir lire la raison et corriger,
  // pas recevoir un échec de transport. Un refus de la barrière AI control passe par ici,
  // et son message dit quoi faire.
  return { content: [{ type: 'text', text: message }], isError: true };
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Coupe un aperçu destiné à la console commune : une capture ne doit pas la noyer. */
function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return 'ok';
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

/**
 * Exécute un outil en le journalisant des deux côtés.
 *
 * C'est la seule voie d'exécution des handlers : tout appel MCP laisse donc une trace dans
 * la console que l'humain regarde, avec ses arguments et son résultat. Rien ne se passe
 * dans le dos de l'utilisateur — c'est la contrepartie du fait qu'un agent puisse toucher
 * au banc.
 */
async function invoke(
  core: DeviceCore,
  name: string,
  args: unknown,
  fn: () => Promise<unknown>,
): Promise<ToolResult> {
  const shown = args === undefined || Object.keys(args as object).length === 0
    ? ''
    : preview(args);
  core.log('info', 'mcp', `${name}(${shown})`);
  try {
    const value = await fn();
    core.log('info', 'mcp', `${name} -> ${preview(value)}`);
    return ok(value);
  } catch (e) {
    const message = describe(e);
    core.log('error', 'mcp', `${name} failed: ${message}`);
    return fail(message);
  }
}

function flagNames(flags: number): string[] {
  const out: string[] = [];
  for (const [name, bit] of Object.entries(PARAM_FLAG)) {
    if ((flags & bit) !== 0) out.push(name.toLowerCase());
  }
  return out;
}

/**
 * Crée le serveur et enregistre les outils.
 *
 * Exporté séparément de `startA2nMcpServer` pour que les tests puissent le brancher sur un
 * transport en mémoire : le serveur se teste alors exactement comme un client le verra,
 * plutôt qu'en appelant les handlers à la main.
 */
export function createA2nMcpServer(core: DeviceCore): { server: McpServer; dispose: () => void } {
  const server = new McpServer(
    { name: A2N_MCP_NAME, version: A2N_MCP_VERSION },
    {
      instructions:
        'Bench control for the A2N BLDC motor controller. Read-only tools are always ' +
        'available. Writing a parameter requires the human to enable "AI control" in the ' +
        'interface; no tool can enable it. Motion, arming and setpoints are not exposed. ' +
        'Safety limits live in the firmware and apply regardless of the command source.',
    },
  );

  // Le journal est celui du DeviceCore ; ce tampon n'en est qu'une fenêtre relisible, pour
  // que `log_read` rende les dernières lignes sans obliger l'agent à rester abonné.
  const recent: LogEntry[] = [];
  const unsubscribe = core.onLog.on((entry) => {
    recent.push(entry);
    if (recent.length > LOG_BUFFER_SIZE) recent.splice(0, recent.length - LOG_BUFFER_SIZE);
  });

  /* ------------------------------------------------------------------ device */

  server.registerTool(
    'device_list_ports',
    {
      title: 'List serial ports',
      description:
        'List the serial ports of this machine, marking the ones whose USB identifiers ' +
        'match an A2N BLDC board.',
      annotations: { readOnlyHint: true },
    },
    async () =>
      invoke(core, 'device_list_ports', undefined, async () => {
        const ports = await core.listPorts();
        return ports.map((p) => ({
          ...p,
          isA2nBoard:
            p.vendorId?.toLowerCase() === A2N_USB_VID && p.productId?.toLowerCase() === A2N_USB_PID,
        }));
      }),
  );

  server.registerTool(
    'device_connect',
    {
      title: 'Connect to a device',
      description:
        'Open the link to a board or to the simulated device. The simulator speaks the ' +
        'same protocol and needs no hardware: prefer it while developing a sequence. ' +
        'Any existing connection is closed first.',
      inputSchema: {
        target: z
          .enum(['serial', 'simulator'])
          .describe('"serial" for a real board, "simulator" for the simulated device'),
        path: z
          .string()
          .optional()
          .describe('Serial port path, e.g. "COM3". Ignored for the simulator.'),
      },
    },
    async (args) =>
      invoke(core, 'device_connect', args, async () => {
        await core.connect(
          args.target === 'simulator'
            ? { kind: 'simulator' }
            : { kind: 'serial', ...(args.path !== undefined && { path: args.path }) },
        );
        const s = core.snapshot();
        return { connection: s.connection, port: s.portDescription, info: s.info };
      }),
  );

  server.registerTool(
    'device_disconnect',
    {
      title: 'Disconnect',
      description: 'Close the link and release the serial port.',
    },
    async () =>
      invoke(core, 'device_disconnect', undefined, async () => {
        await core.disconnect();
        return { connection: core.snapshot().connection };
      }),
  );

  server.registerTool(
    'device_status',
    {
      title: 'Device status',
      description:
        'Connection state, firmware identity, parameter dictionary integrity, and whether ' +
        'the human has enabled AI control. Start here.',
      annotations: { readOnlyHint: true },
    },
    async () =>
      invoke(core, 'device_status', undefined, async () => {
        const s = core.snapshot();
        return {
          connection: s.connection,
          port: s.portDescription,
          info: s.info,
          // Le hash recalculé sur ce qui a été reçu doit retomber sur celui annoncé au
          // handshake. Un `false` ici veut dire que le dictionnaire a été mal transféré :
          // aucune écriture ne doit être tentée avant d'avoir compris pourquoi.
          dictionaryIntegrity: s.dictIntegrity,
          parameterCount: s.params.length,
          aiControlEnabled: s.aiControl,
          lastError: s.lastError,
        };
      }),
  );

  /* ------------------------------------------------------------------ paramètres */

  server.registerTool(
    'param_list',
    {
      title: 'List parameters',
      description:
        'The firmware\'s self-described parameter dictionary, with units, bounds and ' +
        'current values. This list comes from the device: there is no hard-coded copy.',
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe('Case-insensitive substring matched against the name and the group.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      invoke(core, 'param_list', args, async () => {
        const needle = args.filter?.toLowerCase();
        return core
          .snapshot()
          .params.filter(
            (p) =>
              needle === undefined ||
              p.name.toLowerCase().includes(needle) ||
              p.group.toLowerCase().includes(needle),
          )
          .map((p) => ({
            id: p.id,
            name: p.name,
            unit: p.unit,
            group: p.group,
            type: PARAM_TYPE_NAME[p.type] ?? String(p.type),
            flags: flagNames(p.flags),
            min: round6(p.min),
            max: round6(p.max),
            default: round6(p.def),
            value: p.value === null ? null : round6(p.value),
          }));
      }),
  );

  server.registerTool(
    'param_get',
    {
      title: 'Read parameters',
      description:
        'Re-read the named parameters from the device. Use it after a write, or when the ' +
        'cached value in param_list may be stale.',
      inputSchema: {
        names: z
          .array(z.string())
          .min(1)
          .describe('Parameter names, e.g. ["pwm.freq_hz"].'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      invoke(core, 'param_get', args, async () => {
        await core.refreshValues();
        const params = core.snapshot().params;
        return args.names.map((name) => {
          const p = params.find((candidate) => candidate.name === name);
          if (p === undefined) throw new Error(`unknown parameter: ${name}`);
          return {
            name: p.name,
            value: p.value === null ? null : round6(p.value),
            unit: p.unit,
          };
        });
      }),
  );

  server.registerTool(
    'param_set',
    {
      title: 'Write a parameter',
      description:
        'Write one parameter, then read it back and return what the firmware actually ' +
        'kept — it rounds to the real type, so the stored value is not always the one ' +
        'sent. Requires the human to have enabled AI control. Widening a safety limit is ' +
        'a deliberate, logged act: never do it to make a test pass.',
      inputSchema: {
        name: z.string().describe('Parameter name, e.g. "pwm.freq_hz".'),
        value: z.number().describe('Value in the unit declared by the dictionary.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) =>
      invoke(core, 'param_set', args, async () => {
        const stored = await core.writeParam(args.name, args.value, 'mcp');
        return { name: args.name, requested: args.value, stored: round6(stored) };
      }),
  );

  server.registerTool(
    'param_reset_defaults',
    {
      title: 'Reset parameters to defaults',
      description:
        'Reset every writable parameter to its compiled default. Requires AI control. ' +
        'This discards the current tuning: it is the widest write there is.',
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async () =>
      invoke(core, 'param_reset_defaults', undefined, async () => {
        await core.resetDefaults('mcp');
        return { reset: true };
      }),
  );

  /* ------------------------------------------------------------------ sécurité */

  server.registerTool(
    'safety_status',
    {
      title: 'Read the safety barrier',
      description:
        'What the firmware barrier is doing right now: the cause of the last cut, whether ' +
        'a fault is latched, whether the outputs are live, and how many times the ' +
        'command-flow watchdog has tripped since reset. Read this before assuming a ' +
        'silent bench is a broken one — the firmware cuts torque on its own when the ' +
        'command flow stops.',
      annotations: { readOnlyHint: true },
    },
    async () =>
      invoke(core, 'safety_status', undefined, async () => core.readSafety()),
  );

  server.registerTool(
    'safety_clear_fault',
    {
      title: 'Acknowledge a latched fault',
      description:
        'Clears the latched fault so the outputs can be enabled again. Requires AI ' +
        'control. The firmware refuses while the cause is still present, and reports ' +
        'that refusal as cleared: false — it is an answer, not an error.',
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async () =>
      invoke(core, 'safety_clear_fault', undefined, async () => ({
        cleared: await core.clearFault('mcp'),
      })),
  );

  /* ------------------------------------------------------------------ télémétrie */

  server.registerTool(
    'telemetry_signals',
    {
      title: 'List traceable signals',
      description:
        'The firmware\'s self-described signal dictionary — what can be streamed or ' +
        'captured, with units. Raw measurements are named as raw on purpose.',
      annotations: { readOnlyHint: true },
    },
    async () =>
      invoke(core, 'telemetry_signals', undefined, async () =>
        (await core.readSignals()).map((s) => ({ id: s.id, name: s.name, unit: s.unit })),
      ),
  );

  server.registerTool(
    'telemetry_sample',
    {
      title: 'Sample telemetry',
      description:
        'Subscribe to signals, collect a short burst of frames at 100-500 Hz, then ' +
        'unsubscribe. Returns per-signal min/max/mean/last plus a frame-gap count. This ' +
        'is the tool for "what is the board doing right now", not for tuning a loop — ' +
        'use scope_capture for that.',
      inputSchema: {
        frames: z.number().int().min(1).max(500).default(50).describe('Frames to collect.'),
        rate_hz: z.number().int().min(100).max(500).default(100).describe('Requested rate.'),
        signals: z
          .array(z.string())
          .max(16)
          .optional()
          .describe('Signal names. Omit for every signal the firmware publishes.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      invoke(core, 'telemetry_sample', args, async () => {
        const result = await core.sampleTelemetry(args.frames, args.rate_hz, args.signals, 'mcp');
        const values = result.frames.map((f) => f.values);

        // Un trou dans `sampleSeq` veut dire que des trames ont été perdues entre le
        // firmware et ici. Le taire rendrait une moyenne calculée sur un échantillon
        // troué, sans que rien ne le dise.
        let gaps = 0;
        for (let i = 1; i < result.frames.length; i++) {
          const prev = result.frames[i - 1];
          const cur = result.frames[i];
          if (prev !== undefined && cur !== undefined) {
            gaps += ((cur.sampleSeq - prev.sampleSeq) & 0xffff) - 1;
          }
        }

        return {
          appliedRateHz: result.rateHz,
          frames: result.frames.length,
          droppedFrames: gaps,
          durationUs:
            (result.frames[result.frames.length - 1]?.timestampUs ?? 0) -
            (result.frames[0]?.timestampUs ?? 0),
          signals: result.signals.map((s, i) => summarizeSeries(s.name, s.unit, column(values, i))),
        };
      }),
  );

  /* ------------------------------------------------------------------ scope */

  server.registerTool(
    'scope_capture',
    {
      title: 'Capture a scope burst',
      description:
        'Record up to 2048 points at the 20 kHz control-loop rate and read the buffer ' +
        'back. This is the only way to see a current-loop step response. By default it ' +
        'returns per-signal statistics only: ask for samples explicitly, and they come ' +
        `back decimated to at most ${MAX_RENDERED_POINTS} points per signal.`,
      inputSchema: {
        depth: z.number().int().min(1).max(2048).default(2048).describe('Points to capture.'),
        decimation: z
          .number()
          .int()
          .min(1)
          .max(256)
          .default(1)
          .describe('Keep one point every N loop passes. 1 means the full 20 kHz.'),
        signals: z
          .array(z.string())
          .min(1)
          .max(4)
          .optional()
          .describe('1 to 4 signal names. Omit for the first four the firmware publishes.'),
        include_samples: z
          .boolean()
          .default(false)
          .describe('Also return the point values, decimated. Off by default: a full ' +
            'capture is 8192 floats and is not readable as a tool result.'),
        max_points: z
          .number()
          .int()
          .min(2)
          .max(MAX_RENDERED_POINTS)
          .default(64)
          .describe('Upper bound on returned points per signal when include_samples is on.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      invoke(core, 'scope_capture', args, async () => {
        // Pas d'options de déclenchement ici, et c'est délibéré : aucun outil MCP ne peut
        // provoquer un transitoire tant que le mouvement n'est pas exposé (M3). Un seuil
        // servirait à attendre un front que l'agent n'a aucun moyen de produire.
        const { signals, capture } = await core.captureScope(
          {
            depth: args.depth,
            decimation: args.decimation,
            ...(args.signals !== undefined && { signalNames: args.signals }),
          },
          'mcp',
        );
        const columns = signals.map((_, i) => column(capture.samples, i));
        return {
          state: SCOPE_STATE_NAME[capture.status.state] ?? String(capture.status.state),
          captured: capture.samples.length,
          depth: capture.status.depth,
          decimation: capture.status.decimation,
          samplePeriodNs: capture.status.samplePeriodNs,
          startTimestampUs: capture.status.startTimestampUs,
          signals: signals.map((s, i) => summarizeSeries(s.name, s.unit, columns[i] ?? [])),
          ...(args.include_samples && {
            samples: signals.map((s, i) => ({
              name: s.name,
              values: decimateSeries(columns[i] ?? [], args.max_points),
            })),
          }),
        };
      }),
  );

  /* ------------------------------------------------------------------ console, journal */

  server.registerTool(
    'console_send',
    {
      title: 'Send a diagnostic console command',
      description:
        'Send one ASCII console line. Strictly allow-listed to diagnostics and STOP: ' +
        'PING, INFO?, STATS?, LINK?, PROTO?, PWM?, DRV?, SENS.ALL?, SAFETY?, ENC?, IMOT?, ' +
        'NVM?, OL?, FOC?, CL?, SELFTEST, STOP. Anything that could ' +
        'start motion is refused here, not filtered out silently. SELFTEST makes the ' +
        'firmware run the protocol reference vectors on target, which separates a codec ' +
        'problem from a cable or host problem.',
      inputSchema: {
        line: z.string().min(1).describe('One console command, e.g. "SELFTEST".'),
      },
    },
    async (args) =>
      invoke(core, 'console_send', args, async () => ({
        command: args.line,
        response: await core.sendSafeConsole(args.line, 'mcp'),
      })),
  );

  server.registerTool(
    'log_read',
    {
      title: 'Read the shared log',
      description:
        'The last entries of the console shared by the device, the interface and this ' +
        'server. Sources are "device", "gui" and "mcp": reading it is how an agent sees ' +
        'what the human just did, and vice versa.',
      inputSchema: {
        limit: z.number().int().min(1).max(LOG_BUFFER_SIZE).default(50).describe('Entries.'),
        level: z
          .enum(['debug', 'info', 'warn', 'error'])
          .optional()
          .describe('Minimum level to return.'),
        source: z.enum(['device', 'gui', 'mcp']).optional().describe('Restrict to one source.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      invoke(core, 'log_read', args, async () => {
        const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
        const floor = args.level === undefined ? -1 : order[args.level];
        return recent
          .filter((e) => order[e.level] >= floor && (args.source === undefined || e.source === args.source))
          .slice(-args.limit)
          .map((e) => ({
            at: new Date(e.at).toISOString(),
            level: e.level,
            source: e.source,
            text: e.text,
          }));
      }),
  );

  return { server, dispose: unsubscribe };
}

/**
 * Démarre le serveur sur un transport. Appelé par le processus principal avec `--mcp`.
 *
 * Le `DeviceCore` reçu est celui de l'application : ne jamais en construire un ici, sous
 * peine d'ouvrir un second port série et de donner à l'agent un état que l'humain ne voit
 * pas.
 */
export async function startA2nMcpServer(core: DeviceCore, transport: Transport): Promise<McpServer> {
  const { server } = createA2nMcpServer(core);
  await server.connect(transport);
  core.log('info', 'mcp', `MCP server ready (${A2N_MCP_NAME} ${A2N_MCP_VERSION})`);
  return server;
}
