import { describe, expect, it } from 'vitest';
import { SPECIALTY_SYSTEMS, SPECIALTY_TEMPLATES, SPECIALTY_VERIFIED, interfaceReadiness, isSpecialtyType, requiredAudiences, requiredTurnoverKinds } from '../src/index.js';

describe('specialty systems', () => {
  it('covers nurse call, pneumatic tube, RTLS and imaging with unique interface keys', () => {
    expect(Object.keys(SPECIALTY_SYSTEMS).sort()).toEqual(['imaging', 'nurse_call', 'pneumatic_tube', 'rtls']);
    for (const s of Object.values(SPECIALTY_SYSTEMS)) {
      const keys = s.interfaces.map((i) => i.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(s.templates.map((t) => t.kind).sort()).toEqual(['fpt', 'pfc']);
    }
    expect(SPECIALTY_VERIFIED).toBe(false);
    expect(isSpecialtyType('rtls')).toBe(true);
    expect(isSpecialtyType('hvac')).toBe(false);
  });

  it('flags interfaces to fire alarm, egress and code calls as life safety', () => {
    const ls = (t: keyof typeof SPECIALTY_SYSTEMS) => SPECIALTY_SYSTEMS[t].interfaces.filter((i) => i.lifeSafety).map((i) => i.key);
    expect(ls('pneumatic_tube')).toEqual(['fire_alarm']);
    expect(ls('rtls')).toEqual(['door_locks']);
    expect(ls('nurse_call')).toContain('code_blue');
    expect(ls('imaging')).toEqual(['mri_quench', 'warning_lights']);
  });

  it('templates have unique names and every system type matches', () => {
    const names = SPECIALTY_TEMPLATES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(SPECIALTY_TEMPLATES.every((t) => isSpecialtyType(t.systemType))).toBe(true);
  });

  it('is ready only when every interface passed most recently', () => {
    expect(interfaceReadiness('pneumatic_tube', { fire_alarm: 'pass', ees: 'pass' })).toEqual({ total: 3, passed: 2, failed: 0, untested: 1, ready: false });
    expect(interfaceReadiness('pneumatic_tube', { fire_alarm: 'fail', ees: 'pass', lab_pharmacy: 'pass' }).failed).toBe(1);
    expect(interfaceReadiness('pneumatic_tube', { fire_alarm: 'pass', ees: 'pass', lab_pharmacy: 'pass' }).ready).toBe(true);
  });

  it('feeds turnover documents and training audiences', () => {
    expect(requiredTurnoverKinds('medical_equipment')).toContain('certificate');
    expect(requiredTurnoverKinds('conveying')).toContain('spare_parts');
    expect(requiredAudiences('communications', 'nurse_call')).toEqual(expect.arrayContaining(['clinical', 'it']));
    expect(requiredAudiences('medical_equipment', 'imaging')).toEqual(expect.arrayContaining(['clinical_engineering']));
  });
});
