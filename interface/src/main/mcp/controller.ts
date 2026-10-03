/**
 * Cycle de vie du serveur MCP HTTP, piloté depuis l'interface (Tools › AI / MCP server).
 *
 * Le serveur démarrait une fois au lancement, sur un port fixé par variable d'environnement.
 * On peut maintenant l'arrêter, le relancer sur un autre port et voir combien d'agents y
 * sont connectés. Rien ici ne touche à la barrière « Enable AI control » : elle reste dans
 * le `DeviceCore`, commandée par l'humain seul, et aucun outil ne peut l'activer.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { DeviceCore } from '../device/DeviceCore.js';
import { A2N_MCP_NAME, createA2nMcpServer } from './server.js';
import { startA2nMcpHttpServer, type McpHttpServer } from './http.js';

export interface McpStatus {
  running: boolean;
  enabled: boolean;
  /** Port demandé ; le port réel est dans `url` quand le serveur tourne. */
  port: number;
  url: string | null;
  sessions: number;
  name: string;
  /** Dernier échec de démarrage (port pris…), `null` sinon. */
  error: string | null;
  /** Vrai si `A2N_MCP_PORT` impose le port : la config ne le change alors pas. */
  portFromEnv: boolean;
}

export interface McpToolInfo {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
}

export class McpController {
  private server: McpHttpServer | null = null;
  private status: McpStatus;
  private readonly listeners = new Set<(s: McpStatus) => void>();

  constructor(
    private readonly core: DeviceCore,
    private readonly envPort: number | null,
  ) {
    this.status = {
      running: false,
      enabled: false,
      port: envPort ?? 0,
      url: null,
      sessions: 0,
      name: A2N_MCP_NAME,
      error: null,
      portFromEnv: envPort !== null,
    };
  }

  onChange(fn: (s: McpStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get current(): McpStatus {
    return { ...this.status };
  }

  private set(patch: Partial<McpStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn(this.current);
  }

  /** Les demandes s'enchaînent : deux démarrages simultanés ouvriraient deux serveurs. */
  private chain: Promise<unknown> = Promise.resolve();

  /** Met le serveur dans l'état demandé : arrêté, ou en marche sur ce port. */
  apply(enabled: boolean, port: number): Promise<McpStatus> {
    const next = this.chain.then(() => this.applyNow(enabled, port));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async applyNow(enabled: boolean, port: number): Promise<McpStatus> {
    const want = this.envPort ?? port;
    if (this.server !== null && (!enabled || this.server.port !== want)) {
      await this.server.close();
      this.server = null;
      this.core.log('info', 'mcp', 'MCP server stopped');
      this.set({ running: false, url: null, sessions: 0 });
    }
    this.set({ enabled, port: want, error: null });
    if (enabled && this.server === null) {
      try {
        this.server = await startA2nMcpHttpServer(this.core, {
          port: want,
          onSessions: (n) => this.set({ sessions: n }),
        });
        this.set({ running: true, url: this.server.url, sessions: 0 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.core.log('error', 'mcp', `MCP server not started: ${msg}`);
        this.set({ running: false, url: null, error: msg });
      }
    }
    return this.current;
  }

  async stop(): Promise<void> {
    if (this.server !== null) await this.server.close();
    this.server = null;
  }

  /**
   * Outils exposés, lus comme un client les verrait : un serveur neuf branché sur un
   * transport en mémoire. Pas de liste recopiée à la main, qui divergerait.
   */
  async tools(): Promise<McpToolInfo[]> {
    const { server, dispose } = createA2nMcpServer(this.core);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'a2n-gui-inspector', version: '0' });
    try {
      await server.connect(a);
      await client.connect(b);
      const { tools } = await client.listTools();
      return tools.map((t) => ({
        name: t.name,
        title: t.title ?? t.annotations?.title ?? t.name,
        description: t.description ?? '',
        readOnly: t.annotations?.readOnlyHint === true,
      }));
    } finally {
      await client.close();
      await server.close();
      dispose();
    }
  }
}
