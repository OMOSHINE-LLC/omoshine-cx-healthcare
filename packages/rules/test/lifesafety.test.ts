import { describe, expect, it } from 'vitest';
import { DEFAULT_LIFE_SAFETY_POLICY, LIFE_SAFETY_KINDS, addMonths, evaluateLifeSafetyInspection, lifeSafetyDue, pfiStatus } from '../src/index.js';

describe('life safety due dates', () => {
  it('dampers: first test within a year of installation, then every 6 years by default', () => {
    expect(lifeSafetyDue({ kind: 'fire_damper', installedOn: '2026-03-01', asOf: '2026-11-03' })).toEqual({ status: 'never_inspected', nextDue: '2027-03-01' });
    expect(lifeSafetyDue({ kind: 'fire_damper', installedOn: '2025-03-01', asOf: '2026-11-03' })).toEqual({ status: 'overdue', nextDue: '2026-03-01' });
    expect(lifeSafetyDue({ kind: 'combination_damper', lastPassedOn: '2024-01-15', lastResult: 'pass', asOf: '2026-11-03' })).toEqual({ status: 'current', nextDue: '2030-01-15' });
  });
  it('doors annually, waterflow switches every 6 months, with a due-soon window', () => {
    expect(lifeSafetyDue({ kind: 'fire_door', lastPassedOn: '2025-11-20', lastResult: 'pass', asOf: '2026-11-03' })).toEqual({ status: 'due_soon', nextDue: '2026-11-20' });
    expect(lifeSafetyDue({ kind: 'waterflow_switch', lastPassedOn: '2026-04-01', lastResult: 'pass', asOf: '2026-11-03' }).status).toBe('overdue');
  });
  it('a failed latest inspection stays failed until a pass is recorded', () => {
    expect(lifeSafetyDue({ kind: 'smoke_detector', lastPassedOn: '2026-06-01', lastResult: 'fail', asOf: '2026-11-03' }).status).toBe('failed');
  });
  it('honours a stricter hospital policy', () => {
    const policy = { ...DEFAULT_LIFE_SAFETY_POLICY, intervalMonths: { ...DEFAULT_LIFE_SAFETY_POLICY.intervalMonths, fire_damper: 48 } };
    expect(lifeSafetyDue({ kind: 'fire_damper', lastPassedOn: '2022-06-01', lastResult: 'pass', asOf: '2026-11-03', policy }).status).toBe('overdue');
    expect(DEFAULT_LIFE_SAFETY_POLICY.verified).toBe(false);
  });
  it('adds months without spilling past month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
  });
});

describe('inspections and plan-for-improvement items', () => {
  it('fails on any "no", allows not-applicable items, and reports missing answers as incomplete', () => {
    const all = Object.fromEntries(LIFE_SAFETY_KINDS.fire_door.items.map((i) => [i.key, true]));
    expect(evaluateLifeSafetyInspection('fire_door', all).overall).toBe('pass');
    expect(evaluateLifeSafetyInspection('fire_door', { ...all, coordinator_ok: 'na' }).overall).toBe('pass');
    expect(evaluateLifeSafetyInspection('fire_door', { ...all, latches: false }).overall).toBe('fail');
    expect(evaluateLifeSafetyInspection('fire_door', { latches: true }).overall).toBe('incomplete');
    expect(LIFE_SAFETY_KINDS.fire_door.items).toHaveLength(13);
  });
  it('flags plan-for-improvement items past their planned completion', () => {
    expect(pfiStatus({ status: 'open', plannedCompletion: '2026-10-01' }, '2026-11-03')).toBe('overdue');
    expect(pfiStatus({ status: 'open', plannedCompletion: '2027-01-01' }, '2026-11-03')).toBe('open');
    expect(pfiStatus({ status: 'resolved', plannedCompletion: '2026-10-01' }, '2026-11-03')).toBe('resolved');
  });
});
