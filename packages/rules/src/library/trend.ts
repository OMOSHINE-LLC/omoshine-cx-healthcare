/**
 * BAS trend analysis. A building automation system exports time-stamped
 * readings per room; we check each reading against the room's requirements
 * (through the same engine as spot measurements) and report the share of
 * time in compliance and every excursion, which a single TAB reading can miss.
 */
import { evaluateRoom } from '../evaluate.js';
import type { JurisdictionOverlay, RoomMeasurement } from '../types.js';

export type TrendPoint = 'pressure_in_wc' | 'temp_f' | 'rh_pct' | 'supply_cfm' | 'exhaust_cfm' | 'oa_cfm';

/** Trend point → measurement field and the requirement parameter it is judged by. */
export const TREND_POINTS: Record<TrendPoint, { field: keyof RoomMeasurement; parameter: string; label: string }> = {
  pressure_in_wc: { field: 'pressureDiffInWc', parameter: 'pressure_relationship', label: 'Pressure differential (in. w.c.)' },
  temp_f: { field: 'tempF', parameter: 'temp_f', label: 'Temperature (°F)' },
  rh_pct: { field: 'rhPct', parameter: 'rh_pct', label: 'Relative humidity (%)' },
  supply_cfm: { field: 'supplyCfm', parameter: 'total_ach', label: 'Supply airflow (cfm)' },
  exhaust_cfm: { field: 'exhaustCfm', parameter: 'total_ach', label: 'Exhaust airflow (cfm)' },
  oa_cfm: { field: 'oaCfm', parameter: 'oa_ach', label: 'Outdoor airflow (cfm)' },
};

export interface TrendSample { t: string; value: number }
export interface Excursion { from: string; to: string; minutes: number; worst: number }
export interface PointSummary {
  point: TrendPoint; label: string; samples: number; min: number; max: number; median: number;
  /** Share of the trended time the point met its requirement (null when the space type has no requirement for it). */
  pctOfTimeCompliant: number | null;
  excursions: Excursion[];
  longestExcursionMin: number;
  /** Gaps in the trend longer than the expected logging interval. */
  dataGaps: { from: string; to: string; minutes: number }[];
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Summarise one point for one room. Each sample is taken to hold until the next
 * one (the last sample counts for one logging interval). A sample's compliance is
 * decided by evaluateRoom with only that reading, so overlays apply.
 */
export function summarizeTrendPoint(input: {
  point: TrendPoint; samples: TrendSample[]; spaceTypeId: string; volumeCuft: number;
  overlays?: JurisdictionOverlay[]; intervalMin?: number;
}): PointSummary {
  const spec = TREND_POINTS[input.point];
  const interval = input.intervalMin ?? 15;
  const s = [...input.samples].filter((x) => Number.isFinite(x.value)).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const values = s.map((x) => x.value);
  const verdict = (v: number): boolean | null => {
    const ev = evaluateRoom({ spaceTypeId: input.spaceTypeId, volumeCuft: input.volumeCuft, measurement: { [spec.field]: v } as RoomMeasurement, overlays: input.overlays });
    const r = ev.results.find((x) => x.parameter === spec.parameter);
    return !r || r.status === 'not_evaluated' ? null : r.status === 'pass';
  };
  let okMs = 0, judgedMs = 0;
  const excursions: Excursion[] = [];
  const dataGaps: PointSummary['dataGaps'] = [];
  let open: { from: number; worst: number } | null = null;
  const worse = (a: number, b: number) => (Math.abs(b) > Math.abs(a) ? b : a);
  for (let i = 0; i < s.length; i++) {
    const t = Date.parse(s[i]!.t);
    const next = i + 1 < s.length ? Date.parse(s[i + 1]!.t) : t + interval * 60_000;
    const span = next - t;
    if (span > interval * 60_000 * 2) dataGaps.push({ from: s[i]!.t, to: new Date(next).toISOString(), minutes: Math.round(span / 60_000) });
    const ok = verdict(s[i]!.value);
    if (ok === null) continue;
    judgedMs += span;
    if (ok) {
      okMs += span;
      if (open) { excursions.push({ from: new Date(open.from).toISOString(), to: new Date(t).toISOString(), minutes: Math.round((t - open.from) / 60_000), worst: open.worst }); open = null; }
    } else if (!open) open = { from: t, worst: s[i]!.value };
    else open.worst = worse(open.worst, s[i]!.value);
  }
  if (open && s.length) {
    const end = Date.parse(s[s.length - 1]!.t) + interval * 60_000;
    excursions.push({ from: new Date(open.from).toISOString(), to: new Date(end).toISOString(), minutes: Math.round((end - open.from) / 60_000), worst: open.worst });
  }
  return {
    point: input.point, label: spec.label, samples: s.length,
    min: values.length ? Math.min(...values) : NaN, max: values.length ? Math.max(...values) : NaN, median: values.length ? median(values) : NaN,
    pctOfTimeCompliant: judgedMs ? Math.round((okMs / judgedMs) * 1000) / 10 : null,
    excursions, longestExcursionMin: excursions.reduce((m, e) => Math.max(m, e.minutes), 0), dataGaps,
  };
}
