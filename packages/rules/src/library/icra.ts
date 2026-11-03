/**
 * Infection Control Risk Assessment (ICRA) and Interim Life Safety Measures (ILSM).
 *
 * The class matrix and control lists follow the widely used construction ICRA
 * approach (construction activity type × patient risk group). Wording here is
 * OMOSHINE's own. Everything is verified=false until reviewed against the
 * hospital's adopted ICRA policy and the current FGI/ASHE guidance; hospitals
 * commonly tighten these, which projects can do through settings.
 */

export type ConstructionType = 'A' | 'B' | 'C' | 'D';
export type RiskGroup = 'low' | 'medium' | 'high' | 'highest';
export type IcraClass = 'I' | 'II' | 'III' | 'IV';

export const CONSTRUCTION_TYPES: Record<ConstructionType, string> = {
  A: 'Inspection and non-invasive activity (e.g. removing a few ceiling tiles for visual inspection, painting without sanding)',
  B: 'Small-scale, short-duration activity that creates minimal dust (e.g. cable runs, limited access to chases)',
  C: 'Work that generates moderate to high dust or demolition of fixed components, or that cannot be completed in one shift',
  D: 'Major demolition and construction, including consecutive work shifts',
};

export const RISK_GROUPS: Record<RiskGroup, string> = {
  low: 'Office and non-patient areas',
  medium: 'General patient support areas (e.g. outpatient, admissions)',
  high: 'Inpatient units, emergency, imaging, labs, pharmacy',
  highest: 'Surgery, ICU, oncology, transplant, sterile processing, protective environment and isolation rooms',
};

/**
 * Class matrix. Cells the published matrix shows as "III/IV" resolve to IV,
 * the more protective class; a project may only raise a class, never lower it.
 */
const MATRIX: Record<RiskGroup, Record<ConstructionType, IcraClass>> = {
  low: { A: 'I', B: 'II', C: 'II', D: 'IV' },
  medium: { A: 'I', B: 'II', C: 'III', D: 'IV' },
  high: { A: 'I', B: 'II', C: 'IV', D: 'IV' },
  highest: { A: 'II', B: 'IV', C: 'IV', D: 'IV' },
};

export const ICRA_MATRIX_VERIFIED = false;

const ORDER: IcraClass[] = ['I', 'II', 'III', 'IV'];

export function icraClassFor(type: ConstructionType, risk: RiskGroup): IcraClass {
  return MATRIX[risk][type];
}

/** Returns the effective class: the matrix class, raised (never lowered) by an override. */
export function effectiveIcraClass(type: ConstructionType, risk: RiskGroup, override?: IcraClass | null): IcraClass {
  const base = icraClassFor(type, risk);
  if (!override) return base;
  return ORDER.indexOf(override) > ORDER.indexOf(base) ? override : base;
}

export interface IcraControl {
  key: string;
  label: string;
  /** Minimum class at which the control is required during the work. */
  fromClass: IcraClass;
}

/** Daily-log controls. Each later class includes the earlier ones. */
export const ICRA_CONTROLS: IcraControl[] = [
  { key: 'dust_minimized', label: 'Work methods keep dust to a minimum', fromClass: 'I' },
  { key: 'ceiling_tiles_replaced', label: 'Ceiling tiles moved for inspection are replaced', fromClass: 'I' },
  { key: 'active_dust_control', label: 'Active dust control in use (wet methods, local capture)', fromClass: 'II' },
  { key: 'walk_off_mats', label: 'Walk-off mats at work-area exits are clean and in place', fromClass: 'II' },
  { key: 'unused_doors_sealed', label: 'Unused doors and openings sealed', fromClass: 'II' },
  { key: 'hvac_isolated', label: 'HVAC in the work area isolated or protected', fromClass: 'II' },
  { key: 'debris_covered', label: 'Debris contained and covered during transport', fromClass: 'II' },
  { key: 'barriers_intact', label: 'Critical barriers intact, floor to deck, joints sealed', fromClass: 'III' },
  { key: 'hepa_running', label: 'HEPA-filtered negative air units running', fromClass: 'III' },
  { key: 'negative_pressure_confirmed', label: 'Work area negative to adjacent occupied areas', fromClass: 'III' },
  { key: 'anteroom_in_use', label: 'Anteroom in use; workers pass through it', fromClass: 'IV' },
  { key: 'ppe_shoe_covers', label: 'Workers wear shoe covers / coveralls leaving the work area', fromClass: 'IV' },
  { key: 'penetrations_sealed', label: 'Holes, pipes, conduits and punctures sealed', fromClass: 'IV' },
];

export function controlsForClass(cls: IcraClass): IcraControl[] {
  return ICRA_CONTROLS.filter((c) => ORDER.indexOf(c.fromClass) <= ORDER.indexOf(cls));
}

export interface IcraLogInput {
  icraClass: IcraClass;
  /** Control key → observed true/false. Missing keys are not evaluated. */
  controls: Record<string, boolean | undefined>;
  /** Work area minus adjacent occupied area, in. w.c. Negative number = work area is negative. */
  pressureDiffInWc?: number;
  /** Project-set minimum negative differential magnitude (in. w.c.), if the hospital sets one. */
  minNegativePressureInWc?: number | null;
}

export interface IcraLogItemResult { key: string; label: string; status: 'pass' | 'fail' | 'not_evaluated'; reason?: string }

export function evaluateIcraLog(input: IcraLogInput): { results: IcraLogItemResult[]; overall: 'pass' | 'fail' | 'incomplete'; requiresPressureReading: boolean } {
  const required = controlsForClass(input.icraClass);
  const results: IcraLogItemResult[] = required.map((c) => {
    const v = input.controls[c.key];
    if (v === undefined) return { key: c.key, label: c.label, status: 'not_evaluated' };
    return { key: c.key, label: c.label, status: v ? 'pass' : 'fail', ...(v ? {} : { reason: 'Control not in place' }) };
  });
  const requiresPressureReading = ORDER.indexOf(input.icraClass) >= ORDER.indexOf('III');
  if (requiresPressureReading) {
    const p = input.pressureDiffInWc;
    const label = 'Measured differential to adjacent occupied area';
    if (p === undefined) results.push({ key: 'pressure_reading', label, status: 'not_evaluated' });
    else if (p >= 0) results.push({ key: 'pressure_reading', label, status: 'fail', reason: `Work area is not negative (${p} in. w.c.)` });
    else if (input.minNegativePressureInWc && Math.abs(p) < input.minNegativePressureInWc) {
      results.push({ key: 'pressure_reading', label, status: 'fail', reason: `Differential ${Math.abs(p)} in. w.c. below project minimum ${input.minNegativePressureInWc}` });
    } else results.push({ key: 'pressure_reading', label, status: 'pass' });
  }
  const overall = results.some((r) => r.status === 'fail') ? 'fail' : results.some((r) => r.status === 'not_evaluated') ? 'incomplete' : 'pass';
  return { results, overall, requiresPressureReading };
}

// ---------------------------------------------------------------------------
// ILSM
// ---------------------------------------------------------------------------

export type DeficiencyType =
  | 'fire_alarm_impaired'
  | 'sprinkler_impaired'
  | 'egress_compromised'
  | 'fire_barrier_compromised'
  | 'smoke_barrier_compromised'
  | 'construction_hazard';

export const DEFICIENCY_TYPES: Record<DeficiencyType, string> = {
  fire_alarm_impaired: 'Fire alarm or detection system out of service',
  sprinkler_impaired: 'Sprinkler system out of service',
  egress_compromised: 'Exit or means of egress blocked or compromised',
  fire_barrier_compromised: 'Fire-rated barrier breached',
  smoke_barrier_compromised: 'Smoke barrier or smoke compartment breached',
  construction_hazard: 'Construction creating a fire or life safety hazard',
};

export type IlsmMeasure =
  | 'fire_watch'
  | 'notify_fire_department'
  | 'temporary_detection'
  | 'alternative_exits_posted'
  | 'additional_fire_drills'
  | 'additional_extinguishers'
  | 'smoke_tight_partitions'
  | 'increased_hazard_surveillance'
  | 'staff_training'
  | 'remove_combustibles'
  | 'no_smoking_enforced';

export const ILSM_MEASURES: Record<IlsmMeasure, string> = {
  fire_watch: 'Fire watch with documented patrols',
  notify_fire_department: 'Notify the fire department / AHJ of the impairment',
  temporary_detection: 'Provide temporary fire detection or alarm',
  alternative_exits_posted: 'Post and mark alternative exits; inspect daily',
  additional_fire_drills: 'Conduct additional fire drills in affected areas',
  additional_extinguishers: 'Provide additional fire extinguishers',
  smoke_tight_partitions: 'Use smoke-tight, non-combustible temporary partitions',
  increased_hazard_surveillance: 'Increase hazard surveillance of the affected area',
  staff_training: 'Train staff on the deficiency and the measures in place',
  remove_combustibles: 'Remove excess combustibles and limit storage',
  no_smoking_enforced: 'Enforce no smoking in and near the work area',
};

export interface IlsmPolicy {
  /** Fire alarm or sprinkler impairment longer than this (hours in 24) triggers a fire watch. */
  fireWatchAfterHours: number;
  /** Maximum minutes between fire watch patrols. */
  patrolIntervalMin: number;
  /** Measures the hospital applies to each deficiency type (beyond any fire watch trigger). */
  measures: Record<DeficiencyType, IlsmMeasure[]>;
  verified: boolean;
}

/** Default policy: a starting point for the hospital's own ILSM policy, which governs. */
export const DEFAULT_ILSM_POLICY: IlsmPolicy = {
  fireWatchAfterHours: 4,
  patrolIntervalMin: 60,
  measures: {
    fire_alarm_impaired: ['notify_fire_department', 'temporary_detection', 'staff_training', 'increased_hazard_surveillance'],
    sprinkler_impaired: ['notify_fire_department', 'additional_extinguishers', 'staff_training', 'increased_hazard_surveillance'],
    egress_compromised: ['alternative_exits_posted', 'staff_training', 'additional_fire_drills'],
    fire_barrier_compromised: ['smoke_tight_partitions', 'increased_hazard_surveillance', 'remove_combustibles'],
    smoke_barrier_compromised: ['smoke_tight_partitions', 'increased_hazard_surveillance', 'staff_training'],
    construction_hazard: ['remove_combustibles', 'no_smoking_enforced', 'additional_extinguishers', 'increased_hazard_surveillance'],
  },
  verified: false,
};

/** Measures required for a deficiency. A fire watch is added when a fire protection impairment exceeds the policy threshold. */
export function requiredIlsmMeasures(type: DeficiencyType, outOfServiceHours: number, policy: IlsmPolicy = DEFAULT_ILSM_POLICY): IlsmMeasure[] {
  const out = new Set(policy.measures[type]);
  const fireProtection = type === 'fire_alarm_impaired' || type === 'sprinkler_impaired';
  if (fireProtection && outOfServiceHours > policy.fireWatchAfterHours) out.add('fire_watch');
  return [...Object.keys(ILSM_MEASURES)].filter((m) => out.has(m as IlsmMeasure)) as IlsmMeasure[];
}

/**
 * Find gaps in a fire watch: intervals between consecutive patrols (and from
 * the start of the watch, and up to `asOf` while it is active) that exceed the
 * policy interval.
 */
export function fireWatchGaps(
  startedAt: string,
  patrols: string[],
  asOf: string,
  intervalMin: number = DEFAULT_ILSM_POLICY.patrolIntervalMin,
): { from: string; to: string; minutes: number }[] {
  const times = [startedAt, ...[...patrols].sort(), asOf].map((t) => Date.parse(t));
  const gaps: { from: string; to: string; minutes: number }[] = [];
  for (let i = 1; i < times.length; i++) {
    const minutes = Math.round((times[i]! - times[i - 1]!) / 60000);
    if (minutes > intervalMin) gaps.push({ from: new Date(times[i - 1]!).toISOString(), to: new Date(times[i]!).toISOString(), minutes });
  }
  return gaps;
}
