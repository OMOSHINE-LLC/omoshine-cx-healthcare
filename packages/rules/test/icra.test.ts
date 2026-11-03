import { describe, expect, it } from 'vitest';
import {
  controlsForClass,
  effectiveIcraClass,
  evaluateIcraLog,
  fireWatchGaps,
  icraClassFor,
  requiredIlsmMeasures,
  ICRA_CONTROLS,
  DEFAULT_ILSM_POLICY,
} from '../src/index.js';

describe('ICRA class matrix', () => {
  it('maps construction type and patient risk to a class', () => {
    expect(icraClassFor('A', 'low')).toBe('I');
    expect(icraClassFor('B', 'medium')).toBe('II');
    expect(icraClassFor('C', 'medium')).toBe('III');
    expect(icraClassFor('D', 'low')).toBe('IV');
    expect(icraClassFor('A', 'highest')).toBe('II');
  });
  it('resolves "III/IV" cells to the more protective class IV', () => {
    expect(icraClassFor('C', 'high')).toBe('IV');
    expect(icraClassFor('B', 'highest')).toBe('IV');
  });
  it('lets a project raise the class but never lower it', () => {
    expect(effectiveIcraClass('A', 'low', 'III')).toBe('III');
    expect(effectiveIcraClass('D', 'highest', 'I')).toBe('IV');
    expect(effectiveIcraClass('B', 'medium', null)).toBe('II');
  });
});

describe('ICRA controls', () => {
  it('each class includes the controls of lower classes', () => {
    const counts = (['I', 'II', 'III', 'IV'] as const).map((c) => controlsForClass(c).length);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(controlsForClass('IV')).toHaveLength(ICRA_CONTROLS.length);
    expect(controlsForClass('II').some((c) => c.key === 'barriers_intact')).toBe(false);
    expect(controlsForClass('III').some((c) => c.key === 'barriers_intact')).toBe(true);
  });
});

describe('evaluateIcraLog', () => {
  const allTrue = (cls: 'I' | 'II' | 'III' | 'IV') => Object.fromEntries(controlsForClass(cls).map((c) => [c.key, true]));

  it('passes a complete class II log without a pressure reading', () => {
    const ev = evaluateIcraLog({ icraClass: 'II', controls: allTrue('II') });
    expect(ev.overall).toBe('pass');
    expect(ev.requiresPressureReading).toBe(false);
  });
  it('requires a negative pressure reading from class III', () => {
    expect(evaluateIcraLog({ icraClass: 'III', controls: allTrue('III') }).overall).toBe('incomplete');
    expect(evaluateIcraLog({ icraClass: 'III', controls: allTrue('III'), pressureDiffInWc: -0.02 }).overall).toBe('pass');
    const pos = evaluateIcraLog({ icraClass: 'IV', controls: allTrue('IV'), pressureDiffInWc: 0.005 });
    expect(pos.overall).toBe('fail');
    expect(pos.results.find((r) => r.key === 'pressure_reading')!.reason).toMatch(/not negative/);
    expect(evaluateIcraLog({ icraClass: 'IV', controls: allTrue('IV'), pressureDiffInWc: 0 }).overall).toBe('fail');
  });
  it('applies a project minimum differential when one is set', () => {
    const ev = evaluateIcraLog({ icraClass: 'IV', controls: allTrue('IV'), pressureDiffInWc: -0.005, minNegativePressureInWc: 0.01 });
    expect(ev.overall).toBe('fail');
    expect(evaluateIcraLog({ icraClass: 'IV', controls: allTrue('IV'), pressureDiffInWc: -0.012, minNegativePressureInWc: 0.01 }).overall).toBe('pass');
  });
  it('fails when a required control is not in place and ignores controls above the class', () => {
    const ev = evaluateIcraLog({ icraClass: 'III', controls: { ...allTrue('III'), barriers_intact: false, anteroom_in_use: false }, pressureDiffInWc: -0.02 });
    expect(ev.overall).toBe('fail');
    expect(ev.results.filter((r) => r.status === 'fail').map((r) => r.key)).toEqual(['barriers_intact']);
  });
  it('marks missing answers as incomplete, never pass', () => {
    expect(evaluateIcraLog({ icraClass: 'I', controls: { dust_minimized: true } }).overall).toBe('incomplete');
  });
});

describe('ILSM', () => {
  it('requires a fire watch only when fire protection is impaired beyond the threshold', () => {
    expect(requiredIlsmMeasures('fire_alarm_impaired', 3)).not.toContain('fire_watch');
    expect(requiredIlsmMeasures('fire_alarm_impaired', 4.5)).toContain('fire_watch');
    expect(requiredIlsmMeasures('sprinkler_impaired', 10)).toContain('fire_watch');
    expect(requiredIlsmMeasures('egress_compromised', 48)).not.toContain('fire_watch');
  });
  it('returns the policy measures for the deficiency', () => {
    expect(requiredIlsmMeasures('egress_compromised', 1)).toEqual(expect.arrayContaining(['alternative_exits_posted', 'staff_training']));
  });
  it('honours a stricter hospital policy', () => {
    const strict = { ...DEFAULT_ILSM_POLICY, fireWatchAfterHours: 0 };
    expect(requiredIlsmMeasures('fire_alarm_impaired', 1, strict)).toContain('fire_watch');
  });
  it('finds gaps between fire watch patrols, including an overdue current patrol', () => {
    const gaps = fireWatchGaps('2026-11-03T08:00:00Z', ['2026-11-03T08:55:00Z', '2026-11-03T10:30:00Z'], '2026-11-03T11:00:00Z', 60);
    expect(gaps).toEqual([{ from: '2026-11-03T08:55:00.000Z', to: '2026-11-03T10:30:00.000Z', minutes: 95 }]);
    expect(fireWatchGaps('2026-11-03T08:00:00Z', [], '2026-11-03T09:30:00Z', 60)).toHaveLength(1);
    expect(fireWatchGaps('2026-11-03T08:00:00Z', ['2026-11-03T08:50:00Z'], '2026-11-03T09:40:00Z', 60)).toHaveLength(0);
  });
});
