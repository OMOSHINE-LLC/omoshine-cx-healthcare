import { describe, expect, it } from 'vitest';
import { median, summarizeTrendPoint } from '../src/index.js';

const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 0, min)).toISOString();

describe('BAS trend analysis', () => {
  it('reports time in compliance and each excursion for an isolation room (must stay negative by at least 0.01)', () => {
    // 15-minute samples: 4 good, 2 positive (excursion of 30 min), 2 good.
    const values = [-0.02, -0.02, -0.015, -0.02, 0.003, 0.001, -0.02, -0.02];
    const r = summarizeTrendPoint({ point: 'pressure_in_wc', spaceTypeId: 'aiir', volumeCuft: 1200, samples: values.map((v, i) => ({ t: at(i * 15), value: v })) });
    expect(r.samples).toBe(8);
    expect(r.pctOfTimeCompliant).toBe(75);
    expect(r.excursions).toHaveLength(1);
    expect(r.excursions[0]).toMatchObject({ from: at(60), to: at(90), minutes: 30, worst: 0.003 });
    expect(r.longestExcursionMin).toBe(30);
    expect(r.max).toBe(0.003);
  });

  it('counts a too-small differential as an excursion, and an excursion that runs to the end', () => {
    const values = [-0.02, -0.004, -0.003];
    const r = summarizeTrendPoint({ point: 'pressure_in_wc', spaceTypeId: 'aiir', volumeCuft: 1200, samples: values.map((v, i) => ({ t: at(i * 15), value: v })) });
    expect(r.excursions).toEqual([{ from: at(15), to: at(45), minutes: 30, worst: -0.004 }]);
  });

  it('checks humidity against the space type limit and flags gaps in the trend', () => {
    const samples = [{ t: at(0), value: 45 }, { t: at(15), value: 62 }, { t: at(90), value: 50 }];
    const r = summarizeTrendPoint({ point: 'rh_pct', spaceTypeId: 'or_class_bc', volumeCuft: 5000, samples });
    expect(r.excursions).toHaveLength(1);
    expect(r.excursions[0]!.minutes).toBe(75);
    expect(r.dataGaps).toEqual([{ from: at(15), to: at(90), minutes: 75 }]);
  });

  it('returns null compliance when the space type has no requirement for the point', () => {
    const r = summarizeTrendPoint({ point: 'pressure_in_wc', spaceTypeId: 'patient_room', volumeCuft: 1500, samples: [{ t: at(0), value: 0.01 }] });
    expect(r.pctOfTimeCompliant).toBeNull();
    expect(median([3, 1, 2, 10])).toBe(2.5);
  });
});
