import { findSpaceType, requirementsForSpaceType } from './library/ashrae170.js';
import { EES_REQUIREMENTS } from './library/ees.js';
import { citationFor } from './library/standards.js';
import type {
  EvaluationResult,
  JurisdictionOverlay,
  Requirement,
  ResultStatus,
  RoomMeasurement,
} from './types.js';

/** Bumped whenever evaluation logic or seeded values change; stored with each result. */
export const ENGINE_VERSION = 'rules-2026.11.0';

/** Tolerance below which a pressure differential is treated as neutral (in. w.c.). */
export const NEUTRAL_PRESSURE_BAND_IN_WC = 0.001;

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

/**
 * Apply state/AHJ overlays to a requirement set. Order matters: overlays apply
 * in the given order, so a later overlay wins. Only overlays effective on or
 * before `asOf` are applied.
 */
export function applyOverlays(
  requirements: Requirement[],
  overlays: JurisdictionOverlay[],
  asOf: string = new Date().toISOString().slice(0, 10),
): Requirement[] {
  let out = requirements.map((r) => ({ ...r }));
  for (const o of overlays) {
    if (o.effectiveDate > asOf) continue;
    if (o.action === 'disable') {
      out = out.filter((r) => r.key !== o.requirementKey);
    } else if (o.action === 'replace') {
      out = out.map((r) =>
        r.key === o.requirementKey
          ? { ...r, ...o.requirement, key: r.key, verified: o.verified && r.verified }
          : r,
      );
    } else if (o.action === 'add') {
      if (!o.requirement) throw new Error(`Overlay ${o.id} (add) has no requirement`);
      const added = { ...o.requirement, key: o.requirementKey } as Requirement;
      for (const field of ['id', 'sectionId', 'parameter', 'operator', 'appliesTo', 'appliesToId', 'severity', 'description'] as const) {
        if (added[field] === undefined) throw new Error(`Overlay ${o.id} (add) missing ${field}`);
      }
      out = out.filter((r) => r.key !== o.requirementKey).concat({ ...added, verified: o.verified });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Single requirement
// ---------------------------------------------------------------------------

export function describeRequired(req: Requirement): string {
  const u = req.unit ? ` ${req.unit}` : '';
  switch (req.operator) {
    case 'gte': return `≥ ${req.valueMin}${u}`;
    case 'gt': return `> ${req.valueMin}${u}`;
    case 'lte': return `≤ ${req.valueMax}${u}`;
    case 'lt': return `< ${req.valueMax}${u}`;
    case 'between': return `${req.valueMin}–${req.valueMax}${u}`;
    case 'eq':
    case 'in': {
      const v = (req.values ?? []).join(' or ');
      return req.valueMin !== undefined ? `${v}, ≥ ${req.valueMin}${u}` : v;
    }
  }
}

function result(req: Requirement, status: ResultStatus, measured: EvaluationResult['measured'], reason?: string): EvaluationResult {
  return {
    requirementKey: req.key,
    requirementId: req.id,
    parameter: req.parameter,
    status,
    measured,
    required: describeRequired(req),
    unit: req.unit,
    severity: req.severity,
    citation: citationFor(req.sectionId),
    ...(reason ? { reason } : {}),
  };
}

/**
 * Evaluate a single numeric or categorical value against a requirement.
 * Missing values are `not_evaluated`, never `pass`.
 */
export function evaluateRequirement(req: Requirement, measured: number | string | boolean | null | undefined): EvaluationResult {
  if (measured === undefined || measured === null || (typeof measured === 'number' && Number.isNaN(measured))) {
    return result(req, 'not_evaluated', null, 'No measurement recorded');
  }
  switch (req.operator) {
    case 'gte':
    case 'gt':
    case 'lte':
    case 'lt':
    case 'between': {
      if (typeof measured !== 'number') return result(req, 'not_evaluated', measured, 'Expected a number');
      const min = req.valueMin;
      const max = req.valueMax;
      let ok = true;
      if (req.operator === 'gte' || req.operator === 'between') ok &&= min === undefined || measured >= min;
      if (req.operator === 'gt') ok &&= min === undefined || measured > min;
      if (req.operator === 'lte' || req.operator === 'between') ok &&= max === undefined || measured <= max;
      if (req.operator === 'lt') ok &&= max === undefined || measured < max;
      return result(req, ok ? 'pass' : 'fail', measured, ok ? undefined : `Measured ${measured}${req.unit ? ' ' + req.unit : ''} outside ${describeRequired(req)}`);
    }
    case 'eq':
    case 'in': {
      const v = String(measured);
      const ok = (req.values ?? []).includes(v);
      return result(req, ok ? 'pass' : 'fail', measured, ok ? undefined : `Measured ${v}, required ${describeRequired(req)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Rooms (ASHRAE 170)
// ---------------------------------------------------------------------------

/** Air changes per hour from airflow (cfm) and room volume (cu ft). */
export function computeAch(cfm: number | undefined, volumeCuft: number | undefined): number | undefined {
  if (cfm === undefined || volumeCuft === undefined || volumeCuft <= 0) return undefined;
  return Math.round(((cfm * 60) / volumeCuft) * 10) / 10;
}

export function pressureRelationshipOf(diffInWc: number | undefined): 'positive' | 'negative' | 'equal' | undefined {
  if (diffInWc === undefined) return undefined;
  if (Math.abs(diffInWc) < NEUTRAL_PRESSURE_BAND_IN_WC) return 'equal';
  return diffInWc > 0 ? 'positive' : 'negative';
}

export type OverallStatus = 'pass' | 'fail' | 'incomplete';

export interface RoomEvaluation {
  spaceTypeId: string;
  engineVersion: string;
  results: EvaluationResult[];
  overall: OverallStatus;
  lifeSafetyFailure: boolean;
  computed: { totalAch?: number; oaAch?: number };
}

export function overallStatus(results: EvaluationResult[]): OverallStatus {
  if (results.some((r) => r.status === 'fail')) return 'fail';
  if (results.length === 0 || results.some((r) => r.status === 'not_evaluated')) return 'incomplete';
  return 'pass';
}

/**
 * Compare a room measurement to its space type's requirements.
 * Total ACH uses supply airflow; for rooms with no supply recorded (e.g. pure
 * exhaust spaces) the exhaust airflow is used instead.
 */
export function evaluateRoom(input: {
  spaceTypeId: string;
  volumeCuft: number;
  measurement: RoomMeasurement;
  overlays?: JurisdictionOverlay[];
  asOf?: string;
}): RoomEvaluation {
  const st = findSpaceType(input.spaceTypeId);
  if (!st) throw new Error(`Unknown space type: ${input.spaceTypeId}`);
  const reqs = applyOverlays(requirementsForSpaceType(st), input.overlays ?? [], input.asOf);
  const m = input.measurement;
  const totalAch = computeAch(m.supplyCfm ?? m.exhaustCfm, input.volumeCuft);
  const oaAch = computeAch(m.oaCfm, input.volumeCuft);

  const results = reqs.map((req) => {
    switch (req.parameter) {
      case 'total_ach': return evaluateRequirement(req, totalAch);
      case 'oa_ach': return evaluateRequirement(req, oaAch);
      case 'rh_pct': return evaluateRequirement(req, m.rhPct);
      case 'temp_f': return evaluateRequirement(req, m.tempF);
      case 'all_exhaust': return evaluateRequirement(req, m.allExhaust === undefined ? undefined : String(m.allExhaust));
      case 'no_recirc_room_units':
        return evaluateRequirement(req, m.recircRoomUnits === undefined ? undefined : String(!m.recircRoomUnits));
      case 'pressure_relationship': {
        const rel = pressureRelationshipOf(m.pressureDiffInWc);
        const r = evaluateRequirement(req, rel);
        if (r.status === 'pass' && req.valueMin !== undefined && m.pressureDiffInWc !== undefined) {
          const mag = Math.abs(m.pressureDiffInWc);
          if (mag < req.valueMin) {
            return { ...r, status: 'fail' as const, measured: m.pressureDiffInWc, reason: `Differential ${mag} in. w.c. below minimum ${req.valueMin}` };
          }
        }
        return { ...r, measured: m.pressureDiffInWc ?? null };
      }
      default:
        return evaluateRequirement(req, undefined);
    }
  });

  return {
    spaceTypeId: st.id,
    engineVersion: ENGINE_VERSION,
    results,
    overall: overallStatus(results),
    lifeSafetyFailure: results.some((r) => r.status === 'fail' && r.severity === 'life_safety'),
    computed: { totalAch, oaAch },
  };
}

// ---------------------------------------------------------------------------
// EES (NFPA 99 / NFPA 110)
// ---------------------------------------------------------------------------

function eesReq(key: string): Requirement {
  const r = EES_REQUIREMENTS.find((x) => x.key === key);
  if (!r) throw new Error(`Missing EES requirement ${key}`);
  return r;
}

export function evaluateAtsTest(input: { transferTimeS: number | undefined; overlays?: JurisdictionOverlay[] }): {
  results: EvaluationResult[];
  overall: OverallStatus;
  lifeSafetyFailure: boolean;
} {
  const reqs = applyOverlays([eesReq('nfpa110.level1.type10.transfer_time')], input.overlays ?? []);
  const results = reqs.map((r) => evaluateRequirement(r, input.transferTimeS));
  return {
    results,
    overall: overallStatus(results),
    lifeSafetyFailure: results.some((r) => r.status === 'fail' && r.severity === 'life_safety'),
  };
}

export type GeneratorTestType = 'monthly' | 'triennial';

export function evaluateGeneratorTest(input: {
  testType: GeneratorTestType;
  durationMin?: number;
  loadPct?: number;
  exhaustTempF?: number;
  manufacturerMinExhaustTempF?: number;
}): { results: EvaluationResult[]; overall: OverallStatus } {
  const prefix = input.testType === 'monthly' ? 'nfpa110.monthly' : 'nfpa110.triennial';
  const duration = evaluateRequirement(eesReq(`${prefix}.duration`), input.durationMin);
  let load = evaluateRequirement(eesReq(`${prefix}.load_pct`), input.loadPct);

  // Monthly alternative: reaching the manufacturer's minimum exhaust temperature satisfies loading.
  if (
    input.testType === 'monthly' &&
    load.status !== 'pass' &&
    input.exhaustTempF !== undefined &&
    input.manufacturerMinExhaustTempF !== undefined &&
    input.exhaustTempF >= input.manufacturerMinExhaustTempF
  ) {
    load = { ...load, status: 'pass', reason: `Met by exhaust temperature ${input.exhaustTempF} °F ≥ manufacturer minimum ${input.manufacturerMinExhaustTempF} °F` };
  }
  const results = [duration, load];
  return { results, overall: overallStatus(results) };
}
