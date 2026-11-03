import { describe, expect, it } from 'vitest';
import { COMPLIANCE_TASKS, addInterval, complianceStatus, occurrences, requiredAudiences } from '../src/index.js';

describe('compliance calendar', () => {
  it('adds day, week and month intervals', () => {
    expect(addInterval('2026-01-31', { every: 1, unit: 'month' })).toBe('2026-02-28');
    expect(addInterval('2026-11-03', { every: 1, unit: 'week' })).toBe('2026-11-10');
    expect(addInterval('2026-12-31', { every: 1, unit: 'day' })).toBe('2027-01-01');
    expect(addInterval('2026-11-03', { every: 36, unit: 'month' })).toBe('2029-11-03');
  });
  it('is due from the due date through the grace period, then overdue', () => {
    const t = COMPLIANCE_TASKS.gen_monthly!;
    const base = { interval: t.interval, graceDays: t.graceDays, startOn: '2026-01-01' };
    expect(complianceStatus({ ...base, lastDoneOn: '2026-10-20', lastResult: 'pass', asOf: '2026-11-03' })).toEqual({ status: 'current', nextDue: '2026-11-20' });
    expect(complianceStatus({ ...base, lastDoneOn: '2026-10-01', lastResult: 'pass', asOf: '2026-11-03' })).toEqual({ status: 'due', nextDue: '2026-11-01' });
    expect(complianceStatus({ ...base, lastDoneOn: '2026-09-01', lastResult: 'pass', asOf: '2026-11-03' }).status).toBe('overdue');
    expect(complianceStatus({ ...base, asOf: '2025-12-15' })).toEqual({ status: 'current', nextDue: '2026-01-01' });
    expect(complianceStatus({ ...base, lastDoneOn: '2026-10-30', lastResult: 'fail', asOf: '2026-11-03' }).status).toBe('failed');
    const daily = COMPLIANCE_TASKS.aiir_pressure_daily!;
    expect(complianceStatus({ interval: daily.interval, graceDays: 0, startOn: '2026-01-01', lastDoneOn: '2026-11-01', lastResult: 'pass', asOf: '2026-11-03' }).status).toBe('overdue');
  });
  it('lists occurrences in a window', () => {
    expect(occurrences('2026-10-15', { every: 1, unit: 'week' }, '2026-11-01', '2026-11-30')).toEqual(['2026-11-05', '2026-11-12', '2026-11-19', '2026-11-26']);
  });
  it('names who needs training on each kind of system', () => {
    expect(requiredAudiences('mechanical', 'hvac')).toEqual(['facilities', 'infection_prevention']);
    expect(requiredAudiences('medical_gas', 'medgas')).toEqual(['facilities', 'clinical', 'safety']);
    expect(requiredAudiences('communications', 'nurse_call')).toEqual(['facilities', 'clinical', 'it']);
  });
});
