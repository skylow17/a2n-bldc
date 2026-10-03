/**
 * Dossier de données et fichier de configuration, côté processus principal.
 *
 * Deux niveaux, parce qu'il faut bien savoir où chercher avant d'avoir lu quoi que ce soit :
 *
 * - une **amorce** fixe, `userData/location.json`, qui ne contient que le chemin du dossier
 *   de données ;
 * - le **dossier de données** lui-même, visible et déplaçable (défaut
 *   `Documents/A2N BLDC`) : `config.json` et `measurements/`.
 *
 * Toute écriture passe par un fichier temporaire renommé ensuite : une coupure au milieu
 * laisse l'ancien fichier entier plutôt qu'un fichier tronqué que la lecture tolérante
 * remplacerait par les défauts.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  DEFAULT_CONFIG,
  mergeConfig,
  parseConfig,
  serializeConfig,
  type AppConfig,
  type ConfigPatch,
} from '../../shared/config.js';

export async function writeAtomic(path: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents);
  await rename(tmp, path);
}

export class ConfigStore {
  private config: AppConfig = DEFAULT_CONFIG;
  private dir = '';
  private readonly listeners = new Set<(c: AppConfig) => void>();

  constructor(
    private readonly bootstrapFile: string,
    private readonly defaultDir: string,
    private readonly log: (level: 'info' | 'warn' | 'error', text: string) => void,
  ) {}

  get dataDir(): string {
    return this.dir;
  }

  get configFile(): string {
    return join(this.dir, 'config.json');
  }

  get current(): AppConfig {
    return this.config;
  }

  onChange(fn: (c: AppConfig) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Lit l'amorce puis la config. Un fichier absent n'est pas une erreur : premier lancement. */
  async load(): Promise<string[]> {
    this.dir = this.defaultDir;
    try {
      const boot = JSON.parse(await readFile(this.bootstrapFile, 'utf8')) as { dataDir?: unknown };
      if (typeof boot.dataDir === 'string' && boot.dataDir.length > 0) this.dir = boot.dataDir;
    } catch {
      /* pas d'amorce : dossier par défaut */
    }
    await mkdir(this.dir, { recursive: true });
    let warnings: string[] = [];
    try {
      const parsed = parseConfig(await readFile(this.configFile, 'utf8'));
      this.config = parsed.config;
      warnings = parsed.warnings;
    } catch {
      this.config = DEFAULT_CONFIG;
      await this.persist();
    }
    for (const w of warnings) this.log('warn', `config.json: ${w}`);
    return warnings;
  }

  private async persist(): Promise<void> {
    await writeAtomic(this.configFile, serializeConfig(this.config));
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.config);
  }

  async set(patch: ConfigPatch): Promise<{ config: AppConfig; warnings: string[] }> {
    const r = mergeConfig(this.config, patch);
    this.config = r.config;
    await this.persist();
    this.emit();
    return r;
  }

  async reset(): Promise<AppConfig> {
    this.config = DEFAULT_CONFIG;
    await this.persist();
    this.emit();
    return this.config;
  }

  async importText(text: string): Promise<{ config: AppConfig; warnings: string[] }> {
    const r = parseConfig(text);
    this.config = r.config;
    await this.persist();
    this.emit();
    return r;
  }

  exportText(): string {
    return serializeConfig(this.config);
  }

  /**
   * Change de dossier de données. La config courante y est écrite si le dossier n'en a pas
   * encore ; s'il en a une, c'est **elle** qui est reprise — on rejoint un dossier existant,
   * on ne l'écrase pas.
   */
  async moveTo(dir: string): Promise<string[]> {
    await mkdir(dir, { recursive: true });
    await writeAtomic(this.bootstrapFile, `${JSON.stringify({ dataDir: dir }, null, 2)}\n`);
    const previous = this.config;
    let hasConfig = true;
    try {
      await readFile(join(dir, 'config.json'), 'utf8');
    } catch {
      hasConfig = false;
    }
    const warnings = await this.load();
    if (!hasConfig) {
      this.config = previous;
      await this.persist();
    }
    this.emit();
    return warnings;
  }
}
