/**
 * Preregages de souscription.
 *
 * Testes parce qu'ils touchent a la regle la plus stricte du projet : le dictionnaire de
 * signaux vient du firmware et ne se recopie pas cote PC. Un prereglage nomme des signaux
 * sans les decrire, ce qui est admissible — a condition qu'il se confronte au dictionnaire
 * publie au lieu de le supposer. C'est ce qui est verifie ici.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_SUBSCRIBED,
  SIGNAL_PRESETS,
  matchingPreset,
  resolvePreset,
} from '../signalPresets.js';

/** Ce que le firmware publie aujourd'hui — docs/protocol.md section 6. */
const AVAILABLE = [
  'current.raw_ia_count', 'current.raw_ib_count', 'current.raw_ic_count',
  'loop.duration_ns', 'loop.max_duration_ns', 'loop.load_pct',
  'enc.pos_rad', 'enc.vel_rad_s', 'enc.age_us',
  'current.ia_count', 'current.ib_count', 'current.ic_count',
];

const diagnostic = SIGNAL_PRESETS[0]!;

describe('prereglages de signaux', () => {
  it('propose « Diagnostic » en premier, donc par defaut', () => {
    expect(diagnostic.id).toBe('diagnostic');
  });

  it('tient sous les huit teintes de la palette', () => {
    // Au-dela de huit courbes, aucune couleur distincte n'est fabriquee : un prereglage
    // qui en proposerait plus donnerait deux courbes grises impossibles a distinguer.
    for (const p of SIGNAL_PRESETS) {
      expect(resolvePreset(p, AVAILABLE).length).toBeLessThanOrEqual(8);
    }
  });

  it('ne nomme que des signaux que le firmware publie', () => {
    // Si ce test tombe, c'est soit une faute de frappe dans un prereglage, soit un signal
    // renomme cote firmware sans que l'interface suive.
    for (const p of SIGNAL_PRESETS) {
      expect(resolvePreset(p, AVAILABLE)).toEqual([...p.names]);
    }
  });

  it('ecarte les signaux absents au lieu d echouer', () => {
    // Un firmware anterieur a l'etape 4 ne publie pas les courants centres. Le prereglage
    // doit rendre ce qu'il peut, pas rien.
    const older = AVAILABLE.filter((n) => !n.startsWith('current.i'));
    const got = resolvePreset(diagnostic, older);
    expect(got).not.toHaveLength(0);
    expect(got.every((n) => older.includes(n))).toBe(true);
    expect(resolvePreset(diagnostic, [])).toEqual([]);
  });

  it('garde l ordre du prereglage, qui porte une intention de lecture', () => {
    const got = resolvePreset(diagnostic, [...AVAILABLE].reverse());
    expect(got[0]).toBe('current.ia_count');
  });

  it('plafonne plutot que de se faire refuser la souscription', () => {
    // Le firmware repond ERR_ARG au-dela de seize : mieux vaut tronquer ici que rendre une
    // erreur qu'on ne saurait pas expliquer.
    expect(resolvePreset(diagnostic, AVAILABLE, 2)).toHaveLength(2);
    expect(MAX_SUBSCRIBED).toBe(16);
  });

  it('ne signale un prereglage actif que si la selection en est l image exacte', () => {
    const picked = resolvePreset(diagnostic, AVAILABLE);
    expect(matchingPreset(picked, AVAILABLE)?.id).toBe('diagnostic');
    // Un signal decoche a la main : plus aucun prereglage n'est actif, et il faut que ca
    // se voie — sinon l'affichage ment sur ce qui est reellement souscrit.
    expect(matchingPreset(picked.slice(1), AVAILABLE)).toBeNull();
    expect(matchingPreset([...picked, 'loop.duration_ns'], AVAILABLE)).toBeNull();
    // L'ordre ne compte pas pour la correspondance : ce sont les memes signaux.
    expect(matchingPreset([...picked].reverse(), AVAILABLE)?.id).toBe('diagnostic');
  });
});
