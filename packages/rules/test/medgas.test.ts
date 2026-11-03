import { describe, expect, it } from 'vitest';
import { MEDGAS_LIMITS_VERIFIED, evaluateMedGasTest, medGasZoneStatus, requiredMedGasTests, requirementKey } from '../src/index.js';

const outlets = [
  { id: 'o1', label: 'OR-01 O2-1', gas: 'oxygen' as const },
  { id: 'o2', label: 'OR-01 VAC-1', gas: 'vacuum' as const },
];

describe('medical gas required tests', () => {
  it('builds zone, gas and outlet tests, skipping purity and concentration for vacuum', () => {
    const req = requiredMedGasTests(['oxygen', 'vacuum'], outlets);
    const keys = req.map((r) => r.key);
    expect(keys).toContain('cross_connection:-:-');
    expect(keys).toContain('standing_pressure:vacuum:-');
    expect(keys).toContain('piping_purity:oxygen:-');
    expect(keys).not.toContain('piping_purity:vacuum:-');
    expect(keys).toContain('concentration:oxygen:o1');
    expect(keys).not.toContain('concentration:vacuum:o2');
    expect(keys).toContain('outlet_flow:vacuum:o2');
    // 2 zone + (2 standing + 2 alarm + 1 particulate + 1 purity) + (2 function + 2 flow + 1 concentration)
    expect(req).toHaveLength(13);
  });
  it('seeds every limit as unverified', () => {
    expect(MEDGAS_LIMITS_VERIFIED).toBe(false);
  });
});

describe('evaluateMedGasTest', () => {
  it('checks oxygen static pressure and flow drop', () => {
    expect(evaluateMedGasTest({ testType: 'outlet_flow', gas: 'oxygen', readings: { staticPsig: 52, flowingPsig: 49 } }).overall).toBe('pass');
    const drop = evaluateMedGasTest({ testType: 'outlet_flow', gas: 'oxygen', readings: { staticPsig: 52, flowingPsig: 45 } });
    expect(drop.overall).toBe('fail');
    expect(drop.checks.find((c) => c.key === 'flow_drop')?.reason).toMatch(/7.0 psi exceeds 5/);
    expect(evaluateMedGasTest({ testType: 'outlet_flow', gas: 'oxygen', readings: { staticPsig: 58, flowingPsig: 56 } }).overall).toBe('fail');
  });
  it('uses the nitrogen pressure band', () => {
    expect(evaluateMedGasTest({ testType: 'outlet_flow', gas: 'nitrogen', readings: { staticPsig: 170, flowingPsig: 167 } }).overall).toBe('pass');
    expect(evaluateMedGasTest({ testType: 'outlet_flow', gas: 'nitrogen', readings: { staticPsig: 52, flowingPsig: 50 } }).overall).toBe('fail');
  });
  it('checks vacuum at test flow', () => {
    expect(evaluateMedGasTest({ testType: 'outlet_flow', gas: 'vacuum', readings: { vacuumInHg: 19 } }).overall).toBe('pass');
    expect(evaluateMedGasTest({ testType: 'outlet_flow', gas: 'vacuum', readings: { vacuumInHg: 10 } }).overall).toBe('fail');
  });
  it('checks concentration ranges, including medical air', () => {
    expect(evaluateMedGasTest({ testType: 'concentration', gas: 'oxygen', readings: { percent: 99.5 } }).overall).toBe('pass');
    expect(evaluateMedGasTest({ testType: 'concentration', gas: 'oxygen', readings: { percent: 98 } }).overall).toBe('fail');
    expect(evaluateMedGasTest({ testType: 'concentration', gas: 'medical_air', readings: { percent: 20.9 } }).overall).toBe('pass');
    expect(evaluateMedGasTest({ testType: 'concentration', gas: 'medical_air', readings: { percent: 99 } }).overall).toBe('fail');
  });
  it('requires the cross-connection test to cover every outlet', () => {
    expect(evaluateMedGasTest({ testType: 'cross_connection', readings: { outletsTested: 12, wrongGasFound: false }, zoneOutletCount: 12 }).overall).toBe('pass');
    expect(evaluateMedGasTest({ testType: 'cross_connection', readings: { outletsTested: 10, wrongGasFound: false }, zoneOutletCount: 12 }).overall).toBe('fail');
    expect(evaluateMedGasTest({ testType: 'cross_connection', readings: { outletsTested: 12, wrongGasFound: true }, zoneOutletCount: 12 }).overall).toBe('fail');
  });
  it('only asks vacuum for the low alarm, and reports missing readings as incomplete', () => {
    expect(evaluateMedGasTest({ testType: 'alarm_test', gas: 'vacuum', readings: { lowAlarm: true } }).overall).toBe('pass');
    expect(evaluateMedGasTest({ testType: 'alarm_test', gas: 'oxygen', readings: { lowAlarm: true } }).overall).toBe('incomplete');
    expect(evaluateMedGasTest({ testType: 'standing_pressure', gas: 'oxygen', readings: { durationHours: 12, leakFound: false } }).overall).toBe('fail');
    expect(evaluateMedGasTest({ testType: 'piping_purity', gas: 'oxygen', readings: { dewPointF: 30, hydrocarbonDeltaPpm: 1 } }).overall).toBe('pass');
  });
});

describe('medGasZoneStatus', () => {
  it('takes the latest result per test and is ready only when all pass', () => {
    const req = requiredMedGasTests(['vacuum'], [outlets[1]!]);
    const all = req.map((q) => ({ testType: q.testType, gas: q.gas, outletId: q.outletId, overall: 'pass' as const, testedAt: '2026-11-02T10:00:00Z' }));
    expect(medGasZoneStatus(req, all).readyToCertify).toBe(true);
    const retestFail = [...all, { testType: 'outlet_flow', gas: 'vacuum', outletId: 'o2', overall: 'fail' as const, testedAt: '2026-11-03T10:00:00Z' }];
    const s = medGasZoneStatus(req, retestFail);
    expect(s.readyToCertify).toBe(false);
    expect(s.summary.failed).toBe(1);
    expect(s.items.find((i) => i.key === requirementKey('outlet_flow', 'vacuum', 'o2'))?.status).toBe('fail');
    expect(medGasZoneStatus(req, []).summary.notTested).toBe(req.length);
  });
});
