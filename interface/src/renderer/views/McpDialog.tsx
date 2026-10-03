/**
 * Tools › AI / MCP server — configuration du serveur MCP et mise en route d'un agent.
 *
 * Trois choses ici :
 *
 * - l'**état** du serveur (marche, URL, sessions d'agent ouvertes) et ses réglages, rangés
 *   dans la config (`mcp.enabled`, `mcp.port`) ;
 * - les **extraits** à coller dans un client MCP pour s'y connecter ;
 * - un **prompt d'installation** à donner tel quel à un LLM : comment se brancher, ce que
 *   font les outils, et les règles du banc. Il est généré avec l'URL réelle, modifiable,
 *   et se copie d'un clic.
 *
 * Ce qu'on n'y trouve **pas** : l'interrupteur « Enable AI control ». Il reste dans la barre
 * haute, seul chemin pour l'activer (`AGENTS.md` §4.6) — la fenêtre en montre l'état et le
 * rappelle, sans le dupliquer.
 */

import { useEffect, useState, type ReactNode } from 'react';

import type { DeviceSnapshot } from '../../main/device/DeviceCore.js';
import type { McpStatus, McpToolInfo } from '../../main/mcp/controller.js';
import { Dialog } from '../components/Dialog.js';
import { Pill } from '../components/Metric.js';
import { Button } from '../components/ui.js';
import { useConfig } from '../config.js';
import { api, useAction } from '../useDevice.js';

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/** Le prompt donné à un LLM pour qu'il installe le serveur et sache s'en servir. */
export function installPrompt(url: string, name: string, tools: McpToolInfo[]): string {
  const list =
    tools.length === 0
      ? '(start the server to list them)'
      : tools.map((t) => `- ${t.name}${t.readOnly ? ' (read-only)' : ''}: ${t.description.split('. ')[0]}`).join('\n');
  return `You are going to drive a motor-controller test bench (A2N BLDC) through an MCP server.

## 1. Connect to the server

The server runs inside the A2N BLDC desktop interface, which must stay open. It speaks the MCP
"Streamable HTTP" transport, on the local machine only:

    URL:  ${url}
    Name: ${name}

Install it in your MCP client, then reload the client so the tools appear:

- Claude Code:     claude mcp add --transport http ${name} ${url}
- JSON config (clients with HTTP support, e.g. .mcp.json):
    { "mcpServers": { "${name}": { "type": "http", "url": "${url}" } } }
- stdio-only clients (e.g. Claude Desktop), through the mcp-remote bridge:
    { "mcpServers": { "${name}": { "command": "npx", "args": ["-y", "mcp-remote", "${url}"] } } }

Check the connection by calling device_status. If the call fails, ask the user whether the
interface is open and the server is enabled (Tools > AI / MCP server).

## 2. Tools

${list}

## 3. Bench rules — non-negotiable

- A real motor with a rotating mass is attached. Read-only tools are always available.
- Writing anything, arming and moving (motion_arm, motion_position_move) require the human
  to switch on "Enable AI control" in the interface. No tool can switch it on: if a tool
  refuses because of it, stop and ask the user. Move only when the user asked for it.
- Nothing turns without ARM. A reset, a fault or a lost link always return the board to the
  disarmed state. Faults are latched and need an explicit clear. Disarm (motion_disarm) as
  soon as a test is over; motion_disarm and STOP are always allowed.
- Safety limits (current, speed, voltage, temperature, link watchdog) live in the firmware
  and apply whatever the command source. Never widen a limit to make a test pass: if a limit
  blocks a legitimate test, say so and let the human decide.
- Everything you do is logged in the console shared with the human (source "mcp").
- Report what was measured, not what was expected. A setting that does not converge is
  reported as such.

## 4. How to start

1. device_status, then device_connect if no board is connected (ask which port).
2. param_list to read the parameter dictionary: names, units, bounds and flags come from the
   firmware; never assume them.
3. Use telemetry and scope tools to observe before changing anything.
`;
}

function Snippet({ label, text }: { label: string; text: string }): ReactNode {
  const [done, setDone] = useState(false);
  return (
    <div className="px-4 py-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] text-fg-2">{label}</span>
        <Button
          onClick={() =>
            void copy(text).then(() => {
              setDone(true);
              setTimeout(() => setDone(false), 1200);
            })
          }
        >
          {done ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="selectable overflow-x-auto rounded-[3px] border border-line-soft bg-bg px-2 py-1.5 font-mono text-[11px] text-fg">
        {text}
      </pre>
    </div>
  );
}

export function McpDialog({ state, onClose }: { state: DeviceSnapshot; onClose: () => void }): ReactNode {
  const { config } = useConfig();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [enabled, setEnabled] = useState(config.mcp.enabled);
  const [port, setPort] = useState(String(config.mcp.port));
  const [prompt, setPrompt] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [copied, setCopied] = useState(false);
  const act = useAction();

  useEffect(() => {
    void api().mcpStatus().then(setStatus).catch(() => undefined);
    void api().mcpTools().then(setTools).catch(() => setTools([]));
    return api().onMcpStatus(setStatus);
  }, []);

  const name = status?.name ?? 'a2n-bldc';
  const url = status?.url ?? `http://127.0.0.1:${status?.port ?? config.mcp.port}/mcp`;
  const generated = installPrompt(url, name, tools);
  const text = prompt ?? generated;
  const portN = Number(port);
  const portOk = Number.isInteger(portN) && portN >= 1024 && portN <= 65535;
  const dirty = enabled !== config.mcp.enabled || portN !== config.mcp.port;

  return (
    <Dialog
      title="AI / MCP server"
      onClose={onClose}
      footer={
        <>
          <span className="min-w-0 flex-1 truncate text-[11px] text-fault">{act.error ?? status?.error ?? ''}</span>
          <Button tone="accent" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="border-b border-line-soft px-4 py-3">
        <div className="flex items-center gap-3">
          <Pill tone={status?.running === true ? 'ok' : status?.error != null ? 'fault' : 'idle'}>
            {status?.running === true ? 'running' : status?.error != null ? 'failed' : 'stopped'}
          </Pill>
          <span className="selectable font-mono text-[12px] text-fg">{status?.running === true ? status.url : '—'}</span>
          <span className="font-mono text-[11px] text-fg-3">
            {status?.sessions ?? 0} agent session{status?.sessions === 1 ? '' : 's'}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-[12px] text-fg-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4" />
            Run the server
          </label>
          <label className="flex items-center gap-2 text-[12px] text-fg-2">
            Port
            <input
              value={port}
              disabled={status?.portFromEnv === true}
              onChange={(e) => setPort(e.target.value)}
              inputMode="numeric"
              className="w-20 rounded-[3px] border border-line bg-raise px-1.5 py-0.5 font-mono text-[12px] text-fg outline-none disabled:opacity-40"
            />
          </label>
          <Button
            tone="accent"
            disabled={act.busy || !portOk || (!dirty && status?.error == null)}
            onClick={() => void act.run(() => api().mcpApply(enabled, portN))}
          >
            Apply
          </Button>
          {status?.portFromEnv === true && (
            <span className="text-[11px] text-fg-3">Port set by A2N_MCP_PORT</span>
          )}
          {!portOk && <span className="text-[11px] text-fault">Port 1024 to 65535</span>}
        </div>
        <p className="mt-3 text-[12px] text-fg-2">
          AI control is{' '}
          <strong className={state.aiControl ? 'text-accent' : 'text-fg'}>{state.aiControl ? 'ON' : 'OFF'}</strong>
          {state.aiControl
            ? ': an agent may write parameters. Switch it off in the top bar at any time.'
            : ': agents can read, not write. Only you can switch it on, in the top bar.'}
        </p>
      </div>

      <Snippet label="Claude Code" text={`claude mcp add --transport http ${name} ${url}`} />
      <Snippet
        label="JSON config — clients with HTTP support"
        text={JSON.stringify({ mcpServers: { [name]: { type: 'http', url } } }, null, 2)}
      />
      <Snippet
        label="JSON config — stdio-only clients (Claude Desktop), through mcp-remote"
        text={JSON.stringify({ mcpServers: { [name]: { command: 'npx', args: ['-y', 'mcp-remote', url] } } }, null, 2)}
      />

      <div className="border-t border-line-soft px-4 py-2">
        <button
          type="button"
          onClick={() => setShowTools((v) => !v)}
          className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-2 hover:text-fg"
        >
          {showTools ? '▾' : '▸'} Tools ({tools.length})
        </button>
        {showTools && (
          <div className="mt-1">
            {tools.map((t) => (
              <div key={t.name} className="flex gap-3 py-0.5">
                <span className="w-44 shrink-0 font-mono text-[11px] text-fg">{t.name}</span>
                <span className="w-16 shrink-0 text-[10px] text-fg-3">{t.readOnly ? 'read-only' : 'writes'}</span>
                <span className="text-[11px] text-fg-3">{t.description}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-line-soft px-4 py-3">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-2">Prompt for an LLM</span>
          <span className="flex-1 text-[11px] text-fg-3">Give it to an agent: it explains how to install the server and the bench rules.</span>
          <Button disabled={prompt === null} onClick={() => setPrompt(null)}>
            Regenerate
          </Button>
          <Button
            tone="accent"
            onClick={() =>
              void copy(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              })
            }
          >
            {copied ? 'Copied' : 'Copy prompt'}
          </Button>
        </div>
        <textarea
          value={text}
          onChange={(e) => setPrompt(e.target.value)}
          spellCheck={false}
          className="h-72 w-full resize-y rounded-[3px] border border-line bg-bg px-2 py-1.5 font-mono text-[11px] leading-relaxed text-fg outline-none focus:border-fg-3"
        />
      </div>
    </Dialog>
  );
}
