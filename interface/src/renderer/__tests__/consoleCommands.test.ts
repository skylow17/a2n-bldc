/**
 * Le catalogue de commandes de la console contre `docs/protocol.md`.
 *
 * `docs/protocol.md` fait autorité sur la liaison (`AGENTS.md` §3) et la console ASCII n'est
 * pas auto-décrite : la liste affichée dans l'interface est donc forcément une copie. Une
 * copie sans vérification dérive — on ajoute une commande au firmware, on la documente, et
 * l'interface continue d'en proposer une autre pendant des mois.
 *
 * Ce test ferme les deux sens : rien de documenté ne manque à l'écran, et rien n'est proposé
 * à l'écran que la carte ne connaisse. Il échoue le jour où l'un des deux avance seul, ce qui
 * est exactement le moment où on veut l'apprendre.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONSOLE_COMMANDS, CONSOLE_GROUPS, QUICK_COMMANDS, searchCommands } from '../consoleCommands.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, '../../../../docs/protocol.md');

/** La section 9 seule : ailleurs, un backtick désigne une trame binaire, pas une commande. */
function consoleSection(): string {
  const text = readFileSync(SPEC, 'utf8');
  const start = text.indexOf('## 9. Console ASCII');
  expect(start).toBeGreaterThan(-1);
  const rest = text.slice(start);
  const end = rest.indexOf('\n## ', 3);
  return end > 0 ? rest.slice(0, end) : rest;
}

/**
 * Les verbes des tableaux de la section 9.
 *
 * On ne prend que le **premier** littéral de la première cellule : c'est la commande, et le
 * reste de la cellule peut porter une variante (`VREF.BUF ON … / OFF`) qui n'est pas un verbe.
 * Les `\|` échappés à l'intérieur d'une cellule sont neutralisés avant de découper, sinon un
 * argument comme `<A\|B\|C>` coupe la ligne au mauvais endroit — ce qui faisait justement
 * disparaître `IMOT.WIGGLE` d'une première version de ce test.
 */
function documentedVerbs(): string[] {
  const verbs: string[] = [];
  for (const line of consoleSection().split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.replaceAll('\\|', '\u0000').split('|');
    if (cells.length < 3) continue;
    const lit = /`([^`]+)`/.exec(cells[1] ?? '');
    if (lit === null) continue;
    const verb = lit[1]!.trim().split(/\s+/)[0]!;
    if (/^[A-Z][A-Z0-9.?]*$/.test(verb) && !verbs.includes(verb)) verbs.push(verb);
  }
  return verbs;
}

describe('catalogue de commandes de la console', () => {
  it('trouve bien la section console de la spécification', () => {
    // Si la spécification se réorganise, les deux assertions suivantes deviendraient vides
    // et passeraient toutes seules. On vérifie donc d'abord qu'on lit quelque chose.
    expect(documentedVerbs().length).toBeGreaterThan(15);
  });

  it('n oublie aucune commande documentée', () => {
    const known = new Set(CONSOLE_COMMANDS.map((c) => c.verb));
    const missing = documentedVerbs().filter((v) => !known.has(v));
    expect(missing).toEqual([]);
  });

  it('ne propose aucune commande que la spécification ignore', () => {
    // Les commandes de liaison et la barrière de sécurité sont décrites en prose plutôt
    // qu'en tableau : on cherche donc le verbe n'importe où dans la section.
    const section = consoleSection();
    const unknown = CONSOLE_COMMANDS.filter((c) => !section.includes(c.verb));
    expect(unknown.map((c) => c.verb)).toEqual([]);
  });

  it('ne décrit jamais deux fois le même verbe', () => {
    const verbs = CONSOLE_COMMANDS.map((c) => c.verb);
    expect(new Set(verbs).size).toBe(verbs.length);
  });

  it('donne à chaque commande une syntaxe qui commence par son verbe', () => {
    for (const c of CONSOLE_COMMANDS) {
      expect(c.syntax.startsWith(c.verb)).toBe(true);
      expect(c.summary.length).toBeGreaterThan(20);
    }
  });

  it('ne propose en raccourci que des commandes sans effet de bord', () => {
    // Un raccourci est à un clic. Rien de ce qui met une sortie de puissance sous tension
    // n'y a sa place : la mise sous tension se tape en entier, volontairement.
    for (const q of QUICK_COMMANDS) {
      const c = CONSOLE_COMMANDS.find((x) => x.verb === q);
      expect(c, `${q} n'est pas au catalogue`).toBeDefined();
      expect(c!.arms).not.toBe(true);
    }
  });

  it('cherche dans le verbe comme dans le résumé', () => {
    expect(searchCommands('ENC.BUS')[0]!.commands[0]!.verb).toBe('ENC.BUS');
    // On se souvient de ce qu'une commande fait plus souvent que de son nom.
    const byMeaning = searchCommands('magnet').flatMap((g) => g.commands);
    expect(byMeaning.some((c) => c.verb === 'ENC?')).toBe(true);
    expect(searchCommands('')).toEqual(CONSOLE_GROUPS);
    expect(searchCommands('zzzzz')).toEqual([]);
  });
});
