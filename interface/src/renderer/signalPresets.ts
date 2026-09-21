/**
 * Préréglages de souscription télémétrie.
 *
 * Seize signaux sont souscriptibles (`docs/protocol.md` §6), mais en cocher seize n'aide
 * personne : seize courbes sur un écran ne se lisent pas, et la palette n'a que huit teintes
 * distinctes. Un préréglage est donc d'abord une **sélection**, pas un raccourci.
 *
 * ### Pourquoi une liste écrite ici
 *
 * Le dictionnaire de signaux vient du firmware et n'est jamais recopié côté PC
 * (`AGENTS.md` §3) : un signal ajouté à la carte apparaît sans qu'on touche à l'interface,
 * et c'est ce qui fait la valeur du mécanisme. Un préréglage ne le contredit pas — il ne
 * décrit aucun signal, il ne fait qu'en **nommer** quelques-uns pour dire lesquels vont
 * bien ensemble. C'est un point de vue, pas une source de vérité.
 *
 * Conséquence directe : `resolvePreset` **confronte** les noms au dictionnaire publié et
 * laisse tomber ceux que la carte ne connaît pas. Un préréglage qui référencerait un signal
 * disparu ne casse donc rien, et un firmware plus ancien en garde simplement moins.
 *
 * Libellés en anglais (`AGENTS.md` §5).
 */

export interface SignalPreset {
  id: string;
  label: string;
  /** Ce que ce point de vue sert à voir, en une ligne. */
  hint: string;
  /** Noms exacts, dans l'ordre d'affichage souhaité. Les inconnus sont ignorés. */
  names: readonly string[];
}

/**
 * Le premier de la liste est celui qu'on applique à la connexion.
 *
 * « Diagnostic » d'abord, et son contenu répond à une question précise : qu'est-ce qu'on
 * regarde quand on ne sait pas encore ce qui ne va pas ? Les trois courants centrés, parce
 * que c'est la mesure qui vient d'être réparée et celle sur laquelle tout repose ; l'angle
 * et la vitesse, parce qu'une boucle de position s'y lit ; la charge de boucle, parce qu'une
 * ISR qui déborde explique tout le reste ; et l'âge de l'échantillon d'angle, qui plafonne
 * la vitesse exploitable. Sept signaux, sous les huit teintes de la palette.
 */
export const SIGNAL_PRESETS: readonly SignalPreset[] = [
  {
    id: 'diagnostic',
    label: 'Diagnostic',
    hint: 'What you look at before you know what is wrong.',
    names: [
      'current.ia_count',
      'current.ib_count',
      'current.ic_count',
      'enc.pos_rad',
      'enc.vel_rad_s',
      'loop.load_pct',
      'enc.age_us',
    ],
  },
  {
    id: 'currents',
    label: 'Currents',
    hint: 'Centred and raw side by side: the offset shows up as the gap between them.',
    names: [
      'current.ia_count',
      'current.ib_count',
      'current.ic_count',
      'current.raw_ia_count',
      'current.raw_ib_count',
      'current.raw_ic_count',
    ],
  },
  {
    id: 'encoder',
    label: 'Position',
    hint: 'Angle, speed, and how old the sample was when the loop read it.',
    names: ['enc.pos_rad', 'enc.vel_rad_s', 'enc.age_us'],
  },
  {
    id: 'loop',
    label: 'Loop health',
    hint: 'Where the 50 us budget goes, and whether anything delays it.',
    names: ['loop.duration_ns', 'loop.max_duration_ns', 'loop.load_pct', 'enc.age_us'],
  },
];

/** Plafond du protocole — `docs/protocol.md` §6, `u8 count 0..16`. */
export const MAX_SUBSCRIBED = 16;

/**
 * Traduit un préréglage en sélection réelle, contre le dictionnaire que la carte publie.
 *
 * Trois choses à la fois, et c'est voulu : on garde l'**ordre du préréglage**, parce qu'il
 * porte une intention de lecture ; on **écarte les inconnus** plutôt que d'échouer, pour
 * qu'un firmware plus ancien reste utilisable ; et on **plafonne**, parce que le firmware
 * refuse une souscription trop longue et qu'il vaut mieux tronquer ici que se faire
 * renvoyer une erreur qu'on ne saurait pas expliquer à l'utilisateur.
 */
export function resolvePreset(
  preset: SignalPreset,
  available: readonly string[],
  max: number = MAX_SUBSCRIBED,
): string[] {
  const known = new Set(available);
  const out: string[] = [];
  for (const n of preset.names) {
    if (known.has(n) && !out.includes(n) && out.length < max) out.push(n);
  }
  return out;
}

/**
 * Le préréglage dont la sélection courante est exactement l'image, s'il y en a un.
 *
 * Sert à afficher lequel est actif. Une sélection modifiée à la main ne correspond plus à
 * aucun, et il faut que ça se voie : prétendre qu'un préréglage est actif alors qu'on a
 * décoché un signal ferait mentir l'affichage sur ce qui est réellement souscrit.
 */
export function matchingPreset(
  picked: readonly string[],
  available: readonly string[],
  max: number = MAX_SUBSCRIBED,
): SignalPreset | null {
  for (const p of SIGNAL_PRESETS) {
    const want = resolvePreset(p, available, max);
    if (want.length === picked.length && want.every((n) => picked.includes(n))) return p;
  }
  return null;
}
