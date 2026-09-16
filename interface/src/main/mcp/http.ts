/**
 * Serveur MCP sur HTTP local — le transport par lequel un agent atteint l'interface.
 *
 * Pourquoi HTTP et pas stdio : un serveur stdio vit dans le processus que le client a lancé.
 * Ici, ce processus devrait être Electron avec sa fenêtre, puisque c'est la fenêtre qui porte
 * « Enable AI control » — et sous Windows, Electron ferme le stdin du processus principal
 * avant le premier octet. Le mode `electron . --mcp` n'a donc jamais pu répondre sur ce
 * poste, et `mcp:check` ne pouvait pas le voir puisqu'il instancie le serveur en mémoire.
 *
 * Avec HTTP, le serveur tourne dans l'interface déjà ouverte, sur `127.0.0.1` seulement, et
 * l'agent s'y connecte de l'extérieur : c'est exactement « l'agent et l'humain partagent le
 * même `DeviceCore` » — la connexion, l'état, le journal, et la barrière.
 *
 * Une session MCP par client (transport *Streamable HTTP* avec identifiant de session) :
 * chaque client reçoit son propre `McpServer`, tous branchés sur le même `DeviceCore`.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { DeviceCore } from '../device/DeviceCore.js';
import { A2N_MCP_NAME, A2N_MCP_VERSION, createA2nMcpServer } from './server.js';

/** Port par défaut. Surchargeable par `A2N_MCP_PORT`, et `0` laisse l'OS choisir. */
export const A2N_MCP_DEFAULT_PORT = 4817;
export const A2N_MCP_PATH = '/mcp';

export interface McpHttpServer {
  /** URL complète à donner au client, port réel compris. */
  url: string;
  port: number;
  close: () => Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  dispose: () => void;
}

export async function startA2nMcpHttpServer(
  core: DeviceCore,
  options: { port?: number; host?: string } = {},
): Promise<McpHttpServer> {
  const host = options.host ?? '127.0.0.1';
  const sessions = new Map<string, Session>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== A2N_MCP_PATH) {
      res.writeHead(404).end();
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (existing !== undefined) {
      await existing.transport.handleRequest(req, res);
      return;
    }

    // Sans session connue, seule une initialisation (POST) est recevable.
    if (req.method !== 'POST') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown or missing mcp-session-id' }));
      return;
    }

    const { server, dispose } = createA2nMcpServer(core);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, dispose });
        core.log('info', 'mcp', `agent session opened (${id.slice(0, 8)})`);
      },
      onsessionclosed: (id) => {
        sessions.get(id)?.dispose();
        sessions.delete(id);
        core.log('info', 'mcp', `agent session closed (${id.slice(0, 8)})`);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined && sessions.delete(id)) {
        dispose();
        core.log('info', 'mcp', `agent session closed (${id.slice(0, 8)})`);
      }
    };
    // `exactOptionalPropertyTypes` : le SDK déclare `onclose?: () => void` sur ce transport
    // et `onclose?: (() => void) | undefined` sur l'interface `Transport`. Même contrat.
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res);
  };

  const http: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      core.log('error', 'mcp', error instanceof Error ? error.message : String(error));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? A2N_MCP_DEFAULT_PORT, host, () => {
      const address = http.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });

  const url = `http://${host}:${port}${A2N_MCP_PATH}`;
  core.log('info', 'mcp', `MCP server ready (${A2N_MCP_NAME} ${A2N_MCP_VERSION}) at ${url}`);

  return {
    url,
    port,
    close: async () => {
      for (const [id, s] of sessions) {
        sessions.delete(id);
        s.dispose();
        await s.transport.close();
      }
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
