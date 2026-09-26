/**
 * Réponses d'état de la vue Control. Les lignes sont celles que la carte a rendues le
 * 2026-09-26 pendant les essais des étapes 10 et 11.
 */

import { describe, expect, it } from 'vitest';

import { parseCl, parseFoc, parseKv, parseOl, parseSl } from '../controlStatus.js';

describe('réponses d état de la vue Control', () => {
  it('refuse ce qui n est pas une réponse OK', () => {
    expect(parseKv('ERR CMD')).toBeNull();
    expect(parseCl('ERR CMD')).toBeNull();
    expect(parseFoc('OK')).toBeNull();
  });

  it('lit CL? et calcule la part de saturation', () => {
    const s = parseCl(
      'OK active=0 id_ref_ma=0 iq_ref_ma=50 id_avg_ma=0 iq_avg_ma=19 vd_mv=-11 vq_mv=842 ' +
        'sat_ticks=4918 ticks=5999 left_ms=0 kp_mv_a=3455 ki_v_as=11309',
    )!;
    expect(s.active).toBe(false);
    expect(s.iqRefMa).toBe(50);
    expect(s.vqMv).toBe(842);
    expect(s.satRatio).toBeCloseTo(4918 / 5999);
    expect(s.kpMvA).toBe(3455);
  });

  it('ne fabrique pas de saturation avant le premier passage', () => {
    const s = parseCl('OK active=0 id_ref_ma=100 iq_ref_ma=0 sat_ticks=0 ticks=0')!;
    expect(s.satRatio).toBeNull();
  });

  it('lit SL? en rad/s', () => {
    const s = parseSl(
      'OK active=0 ref_mrad_s=15000 vel_mrad_s=15210 vel_avg_mrad_s=14931 iq_ref_ma=-12 ' +
        'iq_sat_ticks=164 ticks=29999 left_ms=0 kp_ua_rad_s=20734 ki_ua_rad=977090',
    )!;
    expect(s.refRadS).toBe(15);
    expect(s.velAvgRadS).toBeCloseTo(14.931);
    expect(s.iqSatRatio).toBeCloseTo(164 / 29999);
    expect(s.kpMaRadS).toBeCloseTo(20.734);
  });

  it('lit OL? en hertz', () => {
    const s = parseOl('OK active=1 amp_pm=40 hz_target_milli=10000 hz_milli=4200 theta_mrad=1234 left_ms=2500')!;
    expect(s.active).toBe(true);
    expect(s.hzTarget).toBe(10);
    expect(s.hz).toBeCloseTo(4.2);
    expect(s.leftMs).toBe(2500);
  });

  it('lit FOC? en degrés, et laisse inconnu ce qui manque', () => {
    const s = parseFoc('OK valid=1 cfg=1 theta_e_mrad=3142 id_ma=8 iq_ma=-10')!;
    expect(s.valid).toBe(true);
    expect(s.thetaDeg).toBeCloseTo(180, 0);
    expect(s.iqMa).toBe(-10);
    expect(parseFoc('OK valid=0')!.idMa).toBeNull();
  });
});
