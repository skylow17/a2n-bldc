/**
 * Lecture des réponses d'état de la vue Control — `OL?`, `CL?`, `FOC?` (`docs/protocol.md`
 * §9). Des fonctions pures, testées à part : la vue n'a qu'à afficher.
 *
 * Le format console est `OK clé=valeur …`, entiers seulement. Un champ absent donne `null`
 * plutôt que zéro : un firmware plus ancien ne publie pas tout, et afficher 0 pour une
 * valeur inconnue serait affirmer une mesure qui n'existe pas.
 */

export function parseKv(reply: string): Map<string, number> | null {
  if (!reply.startsWith('OK')) return null;
  const out = new Map<string, number>();
  for (const tok of reply.slice(2).trim().split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq <= 0) continue;
    const v = Number(tok.slice(eq + 1));
    if (Number.isFinite(v)) out.set(tok.slice(0, eq), v);
  }
  return out;
}

const get = (m: Map<string, number>, k: string): number | null => m.get(k) ?? null;

export interface OlStatus {
  active: boolean;
  ampPm: number | null;
  hzTarget: number | null;
  hz: number | null;
  leftMs: number | null;
}

export function parseOl(reply: string): OlStatus | null {
  const m = parseKv(reply);
  if (m === null || !m.has('active')) return null;
  const milli = (k: string): number | null => {
    const v = get(m, k);
    return v === null ? null : v / 1000;
  };
  return {
    active: m.get('active') === 1,
    ampPm: get(m, 'amp_pm'),
    hzTarget: milli('hz_target_milli'),
    hz: milli('hz_milli'),
    leftMs: get(m, 'left_ms'),
  };
}

export interface ClStatus {
  active: boolean;
  idRefMa: number | null;
  iqRefMa: number | null;
  idAvgMa: number | null;
  iqAvgMa: number | null;
  vdMv: number | null;
  vqMv: number | null;
  /** Part des passages où la limite de tension a mordu, 0..1 ; `null` avant tout passage. */
  satRatio: number | null;
  leftMs: number | null;
  kpMvA: number | null;
  kiVAs: number | null;
}

export function parseCl(reply: string): ClStatus | null {
  const m = parseKv(reply);
  if (m === null || !m.has('active')) return null;
  const ticks = get(m, 'ticks');
  const sat = get(m, 'sat_ticks');
  return {
    active: m.get('active') === 1,
    idRefMa: get(m, 'id_ref_ma'),
    iqRefMa: get(m, 'iq_ref_ma'),
    idAvgMa: get(m, 'id_avg_ma'),
    iqAvgMa: get(m, 'iq_avg_ma'),
    vdMv: get(m, 'vd_mv'),
    vqMv: get(m, 'vq_mv'),
    satRatio: ticks !== null && sat !== null && ticks > 0 ? sat / ticks : null,
    leftMs: get(m, 'left_ms'),
    kpMvA: get(m, 'kp_mv_a'),
    kiVAs: get(m, 'ki_v_as'),
  };
}

export interface FocStatus {
  valid: boolean;
  cfg: boolean;
  thetaDeg: number | null;
  idMa: number | null;
  iqMa: number | null;
}

export function parseFoc(reply: string): FocStatus | null {
  const m = parseKv(reply);
  if (m === null || !m.has('valid')) return null;
  const th = get(m, 'theta_e_mrad');
  return {
    valid: m.get('valid') === 1,
    cfg: m.get('cfg') === 1,
    thetaDeg: th === null ? null : (th / 1000) * (180 / Math.PI),
    idMa: get(m, 'id_ma'),
    iqMa: get(m, 'iq_ma'),
  };
}
