import { describe, expect, it } from 'vitest';
import { activationTemplate, phaseGates, type GateInput } from '../src/index.js';

const ready: GateInput = {
  rooms: { total: 4, pass: 4, fail: 0, untested: 0 },
  tests: { total: 3, signed: 3, failed: 0 },
  medgasZones: { total: 1, certified: 1 },
  lifeSafetyItems: { total: 5, current: 5, failed: 0, overdue: 0, neverInspected: 0 },
  openLifeSafetyIssues: 0,
  checklist: { required: 14, resolved: 14 },
};

describe('activation checklist template', () => {
  it('adds the state agency items for the launch states and a generic item elsewhere', () => {
    const ca = activationTemplate('ca');
    expect(ca.map((i) => i.key)).toContain('state_construction_final');
    expect(ca.find((i) => i.key === 'state_construction_final')!.label).toMatch(/HCAI/);
    expect(activationTemplate('FL').find((i) => i.key === 'state_construction_final')!.label).toMatch(/AHCA/);
    const oh = activationTemplate('OH');
    expect(oh.map((i) => i.key)).not.toContain('state_construction_final');
    expect(oh.map((i) => i.key)).toContain('state_licensing');
    expect(new Set(ca.map((i) => i.key)).size).toBe(ca.length);
  });
});

describe('phase gates', () => {
  it('is ready when every gate passes', () => {
    const r = phaseGates(ready);
    expect(r.ready).toBe(true);
    expect(r.gates.map((g) => g.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
  });
  it('gates that do not apply do not block, but a phase with no rooms cannot open', () => {
    const r = phaseGates({ ...ready, tests: { total: 0, signed: 0, failed: 0 }, medgasZones: { total: 0, certified: 0 }, lifeSafetyItems: { total: 0, current: 0, failed: 0, overdue: 0, neverInspected: 0 } });
    expect(r.ready).toBe(true);
    expect(r.gates.filter((g) => g.status === 'not_applicable')).toHaveLength(3);
    expect(phaseGates({ ...ready, rooms: { total: 0, pass: 0, fail: 0, untested: 0 } }).ready).toBe(false);
  });
  it('explains each failure', () => {
    const r = phaseGates({
      ...ready,
      rooms: { total: 4, pass: 2, fail: 1, untested: 1 },
      lifeSafetyItems: { total: 5, current: 2, failed: 1, overdue: 0, neverInspected: 2 },
      openLifeSafetyIssues: 1,
      checklist: { required: 14, resolved: 9 },
    });
    expect(r.ready).toBe(false);
    const by = Object.fromEntries(r.gates.map((g) => [g.key, g]));
    expect(by.rooms!.detail).toBe('2 of 4 rooms pass; 1 failing; 1 without a passing measurement set');
    expect(by.life_safety_items!.detail).toBe('2 of 5 items passing; 1 failed; 2 never inspected');
    expect(by.life_safety_issues!.detail).toBe('1 open life safety issue');
    expect(by.checklist!.detail).toBe('9 of 14 required items done or not applicable');
  });
});
