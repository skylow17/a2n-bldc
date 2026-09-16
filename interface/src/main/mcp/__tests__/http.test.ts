/**
 * Le serveur MCP atteint par HTTP, comme un agent l'atteint depuis l'extérieur du processus.
 *
 * `server.test.ts` couvre les outils à travers un transport en mémoire ; ici, seul le
 * transport est en jeu : ouverture de session, routage par identifiant, partage d'un même
 * `DeviceCore` entre deux clients, et fermeture.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceCore, type LogEntry } from '../../device/DeviceCore.js';
import { startA2nMcpHttpServer, type McpHttpServer } from '../http.js';

const opened: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.();
});

async function serve(): Promise<{ core: DeviceCore; http: McpHttpServer; logs: LogEntry[] }> {
  const core = new DeviceCore();
  const logs: LogEntry[] = [];
  core.onLog.on((e) => logs.push(e));
  const http = await startA2nMcpHttpServer(core, { port: 0 });
  opened.push(async () => {
    await http.close();
    await core.disconnect(true);
  });
  return { core, http, logs };
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'test-http', version: '0' });
  // Même écart `exactOptionalPropertyTypes` que côté serveur (voir `http.ts`).
  await client.connect(new StreamableHTTPClientTransport(new URL(url)) as Transport);
  opened.push(() => client.close());
  return client;
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('');
}

describe('MCP over local HTTP', () => {
  it('binds to loopback on an OS-chosen port and announces itself in the journal', async () => {
    const { http, logs } = await serve();
    expect(http.url).toBe(`http://127.0.0.1:${http.port}/mcp`);
    expect(http.port).toBeGreaterThan(0);
    expect(logs.some((l) => l.source === 'mcp' && l.text.includes(http.url))).toBe(true);
  });

  it('serves the full tool list to a real HTTP client', async () => {
    const { http } = await serve();
    const client = await connect(http.url);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('device_status');
    expect(tools.length).toBe(13);
  });

  it('shares one DeviceCore between two sessions', async () => {
    const { core, http } = await serve();
    const a = await connect(http.url);
    const b = await connect(http.url);
    await core.connect({ kind: 'simulator' });
    const fromA = JSON.parse(text(await a.callTool({ name: 'device_status', arguments: {} })));
    const fromB = JSON.parse(text(await b.callTool({ name: 'device_status', arguments: {} })));
    expect(fromA.connection).toBe('connected');
    expect(fromB).toEqual(fromA);
  });

  it('rejects a request that carries no session and is not an initialization', async () => {
    const { http } = await serve();
    const res = await fetch(http.url, { method: 'GET', headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(400);
  });

  it('answers 404 outside the MCP path', async () => {
    const { http } = await serve();
    const res = await fetch(`http://127.0.0.1:${http.port}/`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
