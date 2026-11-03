import { describe, expect, it } from 'vitest';
import {
  applyOverlays,
  computeAch,
  evaluateAtsTest,
  evaluateGeneratorTest,
  evaluateRequirement,
  evaluateRoom,
  pressureRelationshipOf,
  requirementsForSpaceType,
  findSpaceType,
  SPACE_REQUIREMENTS,
  EES_REQUIREMENTS,
  SECTIONS,
  STATE_PROFILES,
  findStateProfile,
  type JurisdictionOverlay,
  type Requirement,
} from '../src/index.js';

// OR-04: 20 ft x 25 ft x 10 ft = 5,000 cu ft. 20 ACH needs 1,667 cfm supply.
const OR_VOLUME = 5000;

describe('computeAch', () => {
  it('converts cfm and volume to air changes per hour', () => {
    expect(computeAch(2000, 5000)).toBe(24);
    expect(computeAch(1667, 5000)).toBe(20);
  });
  it('returns undefined for missing or invalid input', () => {
    expect(computeAch(undefined, 5000)).toBeUndefined();
    expect(computeAch(1000, 0)).toBeUndefined();
  });
});

describe('pressureRelationshipOf', () => {
  it('classifies sign with a neutral band', () => {
    expect(pressureRelationshipOf(0.01)).toBe('positive');
    expect(pressureRelationshipOf(-0.02)).toBe('negative');
    expect(pressureRelationshipOf(0.0005)).toBe('equal');
    expect(pressureRelationshipOf(undefined)).toBeUndefined();
  });
});

describe('evaluateRequirement', () => {
  const gte: Requirement = {
    id: 'r', key: 'k', sectionId: 'sec_ashrae170_2021_t7_1', description: '', parameter: 'total_ach',
    operator: 'gte', valueMin: 20, unit: 'ACH', appliesTo: 'space_type', appliesToId: 'x', severity: 'regulatory', verified: false,
  };
  it('passes at the boundary and fails below it', () => {
    expect(evaluateRequirement(gte, 20).status).toBe('pass');
    expect(evaluateRequirement(gte, 19.9).status).toBe('fail');
  });
  it('never passes a missing value', () => {
    expect(evaluateRequirement(gte, undefined).status).toBe('not_evaluated');
    expect(evaluateRequirement(gte, null).status).toBe('not_evaluated');
    expect(evaluateRequirement(gte, Number.NaN).status).toBe('not_evaluated');
  });
  it('does not evaluate a string against a numeric rule', () => {
    expect(evaluateRequirement(gte, 'twenty').status).toBe('not_evaluated');
  });
  it('handles between, lte, gt and lt', () => {
    const between = { ...gte, operator: 'between' as const, valueMin: 68, valueMax: 75 };
    expect(evaluateRequirement(between, 68).status).toBe('pass');
    expect(evaluateRequirement(between, 75).status).toBe('pass');
    expect(evaluateRequirement(between, 76).status).toBe('fail');
    expect(evaluateRequirement({ ...gte, operator: 'lte', valueMax: 10 }, 10.1).status).toBe('fail');
    expect(evaluateRequirement({ ...gte, operator: 'gt', valueMin: 0 }, 0).status).toBe('fail');
    expect(evaluateRequirement({ ...gte, operator: 'lt', valueMax: 1 }, 0.5).status).toBe('pass');
  });
  it('cites the code section on every result', () => {
    expect(evaluateRequirement(gte, 25).citation).toBe('ASHRAE 170-2021 Table 7-1');
  });
});

describe('evaluateRoom – operating room', () => {
  const good = { supplyCfm: 2000, oaCfm: 400, pressureDiffInWc: 0.01, tempF: 68, rhPct: 45, recircRoomUnits: false };

  it('passes a compliant OR', () => {
    const ev = evaluateRoom({ spaceTypeId: 'or_class_bc', volumeCuft: OR_VOLUME, measurement: good });
    expect(ev.overall).toBe('pass');
    expect(ev.computed).toEqual({ totalAch: 24, oaAch: 4.8 });
    expect(ev.results.every((r) => r.citation.startsWith('ASHRAE 170-2021'))).toBe(true);
  });

  it('fails low air changes and reports which requirement failed', () => {
    const ev = evaluateRoom({ spaceTypeId: 'or_class_bc', volumeCuft: OR_VOLUME, measurement: { ...good, supplyCfm: 1500 } });
    expect(ev.overall).toBe('fail');
    const ach = ev.results.find((r) => r.parameter === 'total_ach')!;
    expect(ach.status).toBe('fail');
    expect(ach.measured).toBe(18);
    expect(ach.required).toBe('≥ 20 ACH');
  });

  it('fails an OR that is negative', () => {
    const ev = evaluateRoom({ spaceTypeId: 'or_class_bc', volumeCuft: OR_VOLUME, measurement: { ...good, pressureDiffInWc: -0.01 } });
    expect(ev.results.find((r) => r.parameter === 'pressure_relationship')!.status).toBe('fail');
  });

  it('fails humidity above 60 %', () => {
    const ev = evaluateRoom({ spaceTypeId: 'or_class_bc', volumeCuft: OR_VOLUME, measurement: { ...good, rhPct: 63 } });
    expect(ev.results.find((r) => r.parameter === 'rh_pct')!.status).toBe('fail');
    expect(ev.lifeSafetyFailure).toBe(false);
  });

  it('is incomplete, not passing, when readings are missing', () => {
    const ev = evaluateRoom({ spaceTypeId: 'or_class_bc', volumeCuft: OR_VOLUME, measurement: { supplyCfm: 2000 } });
    expect(ev.overall).toBe('incomplete');
  });

  it('rejects an unknown space type', () => {
    expect(() => evaluateRoom({ spaceTypeId: 'nope', volumeCuft: 1, measurement: {} })).toThrow(/Unknown space type/);
  });
});

describe('evaluateRoom – AIIR (life safety)', () => {
  const vol = 1200; // 12 ACH = 240 cfm
  const good = { supplyCfm: 260, exhaustCfm: 360, oaCfm: 60, pressureDiffInWc: -0.015, allExhaust: true, recircRoomUnits: false, tempF: 72, rhPct: 40 };

  it('passes a correctly negative isolation room', () => {
    expect(evaluateRoom({ spaceTypeId: 'aiir', volumeCuft: vol, measurement: good }).overall).toBe('pass');
  });

  it('flags a positive AIIR as a life safety failure', () => {
    const ev = evaluateRoom({ spaceTypeId: 'aiir', volumeCuft: vol, measurement: { ...good, pressureDiffInWc: 0.01 } });
    expect(ev.overall).toBe('fail');
    expect(ev.lifeSafetyFailure).toBe(true);
  });

  it('fails a negative AIIR below the 0.01 in. w.c. minimum differential', () => {
    const ev = evaluateRoom({ spaceTypeId: 'aiir', volumeCuft: vol, measurement: { ...good, pressureDiffInWc: -0.005 } });
    const p = ev.results.find((r) => r.parameter === 'pressure_relationship')!;
    expect(p.status).toBe('fail');
    expect(p.reason).toMatch(/below minimum/);
    expect(ev.lifeSafetyFailure).toBe(true);
  });

  it('fails when room air is recirculated rather than all exhausted', () => {
    const ev = evaluateRoom({ spaceTypeId: 'aiir', volumeCuft: vol, measurement: { ...good, allExhaust: false } });
    expect(ev.results.find((r) => r.parameter === 'all_exhaust')!.status).toBe('fail');
  });
});

describe('library integrity', () => {
  it('every requirement cites a known section', () => {
    const ids = new Set(SECTIONS.map((s) => s.id));
    for (const r of [...SPACE_REQUIREMENTS, ...EES_REQUIREMENTS]) expect(ids.has(r.sectionId), r.key).toBe(true);
  });
  it('requirement keys are unique', () => {
    const keys = [...SPACE_REQUIREMENTS, ...EES_REQUIREMENTS].map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('all seeded values are marked unverified until licensed-copy review', () => {
    expect([...SPACE_REQUIREMENTS, ...EES_REQUIREMENTS].every((r) => r.verified === false)).toBe(true);
  });
  it('ships the four launch states', () => {
    expect(STATE_PROFILES.map((s) => s.stateCode).sort()).toEqual(['CA', 'FL', 'NY', 'TX']);
    expect(findStateProfile('ca')?.name).toBe('California');
  });
});

describe('applyOverlays', () => {
  const reqs = requirementsForSpaceType(findSpaceType('or_class_bc')!);
  const base: Omit<JurisdictionOverlay, 'action' | 'requirementKey'> = {
    id: 'ov1', stateCode: 'ZZ', effectiveDate: '2025-01-01', sourceNote: 'test fixture', verified: true,
  };

  it('replaces a requirement value and keeps it unverified if the base was unverified', () => {
    const out = applyOverlays(reqs, [{ ...base, action: 'replace', requirementKey: 'ashrae170.or_class_bc.total_ach', requirement: { valueMin: 25 } }], '2026-01-01');
    const ach = out.find((r) => r.key === 'ashrae170.or_class_bc.total_ach')!;
    expect(ach.valueMin).toBe(25);
    expect(ach.verified).toBe(false);
  });

  it('disables a requirement', () => {
    const out = applyOverlays(reqs, [{ ...base, action: 'disable', requirementKey: 'ashrae170.or_class_bc.rh_pct' }], '2026-01-01');
    expect(out.find((r) => r.parameter === 'rh_pct')).toBeUndefined();
  });

  it('adds a state-only requirement and validates it', () => {
    const add: JurisdictionOverlay = {
      ...base, action: 'add', requirementKey: 'zz.or.max_ach',
      requirement: { id: 'req_zz', sectionId: 'sec_ashrae170_2021_t7_1', parameter: 'total_ach', operator: 'lte', valueMax: 30, appliesTo: 'space_type', appliesToId: 'or_class_bc', severity: 'regulatory', description: 'test' },
    };
    expect(applyOverlays(reqs, [add], '2026-01-01').some((r) => r.key === 'zz.or.max_ach')).toBe(true);
    expect(() => applyOverlays(reqs, [{ ...add, requirement: { valueMax: 1 } }], '2026-01-01')).toThrow(/missing/);
  });

  it('ignores overlays not yet effective', () => {
    const out = applyOverlays(reqs, [{ ...base, effectiveDate: '2030-01-01', action: 'disable', requirementKey: 'ashrae170.or_class_bc.rh_pct' }], '2026-01-01');
    expect(out.some((r) => r.parameter === 'rh_pct')).toBe(true);
  });

  it('changes room evaluation outcome', () => {
    const m = { supplyCfm: 2000, oaCfm: 400, pressureDiffInWc: 0.01, tempF: 70, rhPct: 45, recircRoomUnits: false };
    const ov: JurisdictionOverlay = { ...base, action: 'replace', requirementKey: 'ashrae170.or_class_bc.total_ach', requirement: { valueMin: 25 } };
    expect(evaluateRoom({ spaceTypeId: 'or_class_bc', volumeCuft: OR_VOLUME, measurement: m }).overall).toBe('pass');
    expect(evaluateRoom({ spaceTypeId: 'or_class_bc', volumeCuft: OR_VOLUME, measurement: m, overlays: [ov], asOf: '2026-01-01' }).overall).toBe('fail');
  });
});

describe('EES', () => {
  it('passes an ATS transfer within 10 s, including exactly 10 s', () => {
    expect(evaluateAtsTest({ transferTimeS: 8.2 }).overall).toBe('pass');
    expect(evaluateAtsTest({ transferTimeS: 10 }).overall).toBe('pass');
  });
  it('fails a slow transfer as a life safety failure with NFPA 110 citation', () => {
    const ev = evaluateAtsTest({ transferTimeS: 10.4 });
    expect(ev.overall).toBe('fail');
    expect(ev.lifeSafetyFailure).toBe(true);
    expect(ev.results[0]!.citation).toMatch(/^NFPA 110-2022/);
  });
  it('treats an unrecorded transfer time as incomplete', () => {
    expect(evaluateAtsTest({ transferTimeS: undefined }).overall).toBe('incomplete');
  });
  it('evaluates monthly generator tests by duration and load', () => {
    expect(evaluateGeneratorTest({ testType: 'monthly', durationMin: 30, loadPct: 35 }).overall).toBe('pass');
    expect(evaluateGeneratorTest({ testType: 'monthly', durationMin: 25, loadPct: 35 }).overall).toBe('fail');
    expect(evaluateGeneratorTest({ testType: 'monthly', durationMin: 30, loadPct: 20 }).overall).toBe('fail');
  });
  it('accepts the manufacturer exhaust temperature alternative for monthly load', () => {
    const ev = evaluateGeneratorTest({ testType: 'monthly', durationMin: 30, loadPct: 20, exhaustTempF: 700, manufacturerMinExhaustTempF: 650 });
    expect(ev.overall).toBe('pass');
    expect(ev.results[1]!.reason).toMatch(/exhaust temperature/);
  });
  it('requires 4 hours for the 36-month test', () => {
    expect(evaluateGeneratorTest({ testType: 'triennial', durationMin: 240, loadPct: 30 }).overall).toBe('pass');
    expect(evaluateGeneratorTest({ testType: 'triennial', durationMin: 180, loadPct: 30 }).overall).toBe('fail');
  });
});
