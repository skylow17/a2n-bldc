/**
 * Historique de mesures sur disque : `<dossier de données>/measurements/`.
 *
 * - un fichier par mesure, `<id>.json`, au format de `shared/measurement.ts` — lisible,
 *   copiable, réimportable ailleurs ;
 * - `tree.json`, le rangement en dossiers ;
 * - `index.json`, les métadonnées de chaque mesure, pour afficher la liste sans relire des
 *   mégaoctets de données. Ce n'est qu'un cache : il se reconstruit à partir des fichiers
 *   s'il manque ou ne correspond plus, et un fichier de mesure déposé à la main apparaît.
 *
 * Écritures atomiques (`writeAtomic`). Rien ici n'efface une mesure sans un appel explicite
 * à `delete`.
 */

import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  EMPTY_TREE,
  forgetMeasurements,
  metaOf,
  normalizeTree,
  parseMeasurement,
  serializeMeasurement,
  type MeasTree,
  type Measurement,
  type MeasurementMeta,
} from '../../shared/measurement.js';
import { writeAtomic } from '../config/store.js';

const RESERVED = new Set(['index.json', 'tree.json']);

export interface MeasurementPatch {
  title?: string;
  comment?: string;
  tags?: string[];
}

export class MeasurementStore {
  private metas = new Map<string, MeasurementMeta>();
  private tree: MeasTree = EMPTY_TREE;
  private dir = '';
  private readonly listeners = new Set<() => void>();

  constructor(private readonly log: (level: 'info' | 'warn' | 'error', text: string) => void) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private file(id: string): string {
    // L'identifiant est validé par le schéma (lettres, chiffres, tirets) : il ne peut pas
    // sortir du dossier.
    return join(this.dir, `${id}.json`);
  }

  /** (Re)charge depuis un dossier de données. */
  async open(dataDir: string): Promise<void> {
    this.dir = join(dataDir, 'measurements');
    this.metas.clear();
    let cached: Record<string, MeasurementMeta> = {};
    try {
      cached = JSON.parse(await readFile(join(this.dir, 'index.json'), 'utf8')) as Record<string, MeasurementMeta>;
    } catch {
      /* pas d'index : on le reconstruit */
    }
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith('.json') && !RESERVED.has(n) && !n.endsWith('.tmp'));
    } catch {
      /* dossier absent : historique vide */
    }
    let rebuilt = 0;
    for (const n of names) {
      const id = n.slice(0, -5);
      const hit = cached[id];
      if (hit !== undefined && hit.id === id) {
        this.metas.set(id, hit);
        continue;
      }
      try {
        const r = parseMeasurement(JSON.parse(await readFile(join(this.dir, n), 'utf8')));
        if (r.ok && r.m.id === id) {
          this.metas.set(id, metaOf(r.m));
          rebuilt += 1;
        } else {
          this.log('warn', `measurements/${n}: ${r.ok ? 'id does not match the file name' : r.error} — skipped`);
        }
      } catch (e) {
        this.log('warn', `measurements/${n}: unreadable (${e instanceof Error ? e.message : String(e)}) — skipped`);
      }
    }
    try {
      this.tree = normalizeTree(JSON.parse(await readFile(join(this.dir, 'tree.json'), 'utf8')), new Set(this.metas.keys()));
    } catch {
      this.tree = EMPTY_TREE;
    }
    if (rebuilt > 0 || Object.keys(cached).length !== this.metas.size) await this.writeIndex();
    this.emit();
  }

  private async writeIndex(): Promise<void> {
    await writeAtomic(join(this.dir, 'index.json'), JSON.stringify(Object.fromEntries(this.metas)));
  }

  private async writeTree(): Promise<void> {
    await writeAtomic(join(this.dir, 'tree.json'), `${JSON.stringify(this.tree, null, 2)}\n`);
  }

  list(): { metas: MeasurementMeta[]; tree: MeasTree } {
    return { metas: [...this.metas.values()], tree: this.tree };
  }

  async get(id: string): Promise<Measurement> {
    if (!this.metas.has(id)) throw new Error(`no measurement ${id}`);
    const r = parseMeasurement(JSON.parse(await readFile(this.file(id), 'utf8')));
    if (!r.ok) throw new Error(`measurement ${id}: ${r.error}`);
    return r.m;
  }

  /** Enregistre une mesure ; une mesure au même identifiant est remplacée. */
  async save(raw: unknown, folder: string | null = null): Promise<MeasurementMeta> {
    const r = parseMeasurement(raw);
    if (!r.ok) throw new Error(`measurement rejected: ${r.error}`);
    await writeAtomic(this.file(r.m.id), serializeMeasurement(r.m));
    const meta = metaOf(r.m);
    this.metas.set(r.m.id, meta);
    if (folder !== null && this.tree.folders.some((f) => f.id === folder)) {
      this.tree = { ...this.tree, placement: { ...this.tree.placement, [r.m.id]: folder } };
      await this.writeTree();
    }
    await this.writeIndex();
    this.emit();
    return meta;
  }

  async update(id: string, patch: MeasurementPatch): Promise<MeasurementMeta> {
    const m = await this.get(id);
    return this.save({
      ...m,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.comment !== undefined ? { comment: patch.comment } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    });
  }

  async delete(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      if (!this.metas.has(id)) continue;
      await rm(this.file(id), { force: true });
      this.metas.delete(id);
      this.log('info', `measurement ${id} deleted`);
    }
    this.tree = forgetMeasurements(this.tree, ids);
    await this.writeTree();
    await this.writeIndex();
    this.emit();
  }

  async setTree(raw: unknown): Promise<MeasTree> {
    this.tree = normalizeTree(raw, new Set(this.metas.keys()));
    await this.writeTree();
    this.emit();
    return this.tree;
  }

  /**
   * Importe une mesure lue ailleurs. Si son identifiant existe déjà (même fichier importé
   * deux fois, ou copie d'un autre poste), elle en reçoit un neuf : rien n'est écrasé.
   */
  async importText(text: string, folder: string | null): Promise<MeasurementMeta> {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const id = typeof raw['id'] === 'string' && !this.metas.has(raw['id']) ? raw['id'] : randomUUID();
    return this.save({ ...raw, id }, folder);
  }
}
