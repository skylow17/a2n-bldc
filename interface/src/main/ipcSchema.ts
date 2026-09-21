/**
 * Schémas des arguments IPC, un par canal.
 *
 * ### Pourquoi
 *
 * Les annotations TypeScript des handlers disparaissent à la compilation. Écrit
 * `handle('device:console', (line: string) => …)`, le processus principal accepte à
 * l'exécution un objet, `undefined`, ou n'importe quoi d'autre, et le passe tel quel à la
 * couche qui parle à la carte. Ce n'est pas théorique : `device:updateFirmware` prend un
 * **chemin de fichier** et programme ce qu'il y trouve, `device:setAiControl` gouverne le
 * verrou qui autorise un agent à faire bouger un axe, et `device:console` peut porter
 * `PWM ON`. Le renderer est notre propre code, mais c'est précisément le genre de frontière
 * dont `AGENTS.md` §6 demande qu'elle valide ce qui entre.
 *
 * ### La forme retenue
 *
 * Un schéma par canal, dans une table, et `handle()` refuse de servir un canal absent de
 * cette table. **On ne peut donc pas ajouter un canal en oubliant sa validation** : le
 * programme s'arrête au démarrage. Une liste qu'on peut oublier de tenir à jour n'est pas
 * une barrière, c'est une intention.
 *
 * Les bornes reprennent celles du protocole (`docs/protocol.md`) plutôt que d'en inventer
 * de nouvelles. Elles ne remplacent aucune vérification du firmware : les limites vivent
 * dans la carte (`AGENTS.md` §4.2), et ce fichier ne fait qu'éviter d'envoyer du charabia.
 */

import { z } from 'zod';

/** Sources de journal, telles que `DeviceCore` les nomme. */
const logSource = z.enum(['device', 'gui', 'mcp']);

const connectTarget = z.object({
  kind: z.enum(['serial', 'simulator']),
  path: z.string().min(1).max(260).optional(),
});

/** Bornes de `docs/protocol.md` §6 : profondeur, décimation, nombre de signaux. */
const scopeRequest = z.object({
  depth: z.number().int().min(1).max(2048).optional(),
  decimation: z.number().int().min(1).max(256).optional(),
  pretriggerSamples: z.number().int().min(0).max(2047).optional(),
  triggerMode: z.number().int().min(0).max(255).optional(),
  triggerSignalName: z.string().min(1).max(32).optional(),
  threshold: z.number().finite().optional(),
  signalNames: z.array(z.string().min(1).max(32)).min(1).max(4).optional(),
});

/* Une ligne de console tient sur une ligne : le firmware la découpe sur CR/LF, donc un
 * argument qui en contient viserait à faire passer deux commandes pour une. */
const consoleLine = z.string().min(1).max(200).refine((s) => !/[\r\n\0]/.test(s), {
  message: 'a console line carries no newline',
});

/**
 * Arguments attendus par canal. `z.tuple([])` dit « aucun argument », et le dit
 * explicitement : c'est ce qui permet de distinguer un canal sans argument d'un canal
 * qu'on aurait oublié de décrire.
 */
export const IPC_SCHEMA = {
  'device:snapshot': z.tuple([]),
  'device:listPorts': z.tuple([]),
  'device:connect': z.tuple([connectTarget]),
  'device:disconnect': z.tuple([]),
  'device:refresh': z.tuple([]),
  'device:writeParam': z.tuple([
    z.union([z.number().int().min(0).max(0xffff), z.string().min(1).max(64)]),
    z.number().finite(),
    logSource.optional(),
  ]),
  'device:resetDefaults': z.tuple([]),
  'device:console': z.tuple([consoleLine]),
  'device:readSignals': z.tuple([]),
  'device:captureScope': z.tuple([scopeRequest]),
  'device:startTelemetry': z.tuple([
    z.array(z.string().min(1).max(32)).min(1).max(8).optional(),
    z.number().int().min(1).max(1000).optional(),
  ]),
  'device:stopTelemetry': z.tuple([]),
  'device:saveText': z.tuple([z.string().min(1).max(260), z.string().max(64 * 1024 * 1024)]),
  'device:pickFirmware': z.tuple([]),
  'device:updateFirmware': z.tuple([z.string().min(1).max(260), z.string().min(1).max(32)]),
  'device:setAiControl': z.tuple([z.boolean()]),
  'device:clearFault': z.tuple([]),
} as const;

export type IpcChannel = keyof typeof IPC_SCHEMA;

export function isIpcChannel(name: string): name is IpcChannel {
  return Object.prototype.hasOwnProperty.call(IPC_SCHEMA, name);
}

/**
 * Valide les arguments d'un canal.
 *
 * Rend le message d'erreur plutôt que de lever : le handler le renvoie au renderer, qui
 * l'affiche. Une validation qui échoue en silence serait pire que pas de validation.
 */
export function validateIpc(channel: IpcChannel, args: unknown[]): { ok: true; value: unknown[] }
  | { ok: false; error: string } {
  const parsed = IPC_SCHEMA[channel].safeParse(args);
  if (parsed.success) return { ok: true, value: parsed.data as unknown[] };
  const first = parsed.error.issues[0];
  const where = first !== undefined && first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
  return { ok: false, error: `${channel}: invalid argument${where} — ${first?.message ?? 'rejected'}` };
}
