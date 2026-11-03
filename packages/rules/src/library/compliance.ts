/**
 * Recurring compliance tasks after occupancy, and owner training.
 *
 * Intervals reflect common hospital practice for the editions CMS enforces
 * (NFPA 99/101-2012, which reference NFPA 110 and NFPA 72) and the facility's
 * water management program. Wording is OMOSHINE's own. Everything is
 * verified=false until OMOSHINE's reviewer confirms it; hospitals may set
 * stricter intervals per task.
 */

export type IntervalUnit = 'day' | 'week' | 'month';
export interface Interval { every: number; unit: IntervalUnit }

export type ComplianceTarget = 'asset' | 'room' | 'medgas_zone' | 'project';

export interface ComplianceTaskDef {
  label: string;
  category: 'ees' | 'life_safety' | 'water' | 'medical_gas' | 'ventilation';
  standard: string;
  interval: Interval;
  /** Days of tolerance after the due date before the task is overdue. */
  graceDays: number;
  target: ComplianceTarget;
  /** What the person records; every item must be "yes" to pass. */
  checks: { key: string; label: string }[];
  /** Which records the task is generated for. */
  appliesTo?: { assetTypes?: string[]; spaceTypes?: string[]; withGasZones?: boolean; projectWide?: boolean };
}

export const COMPLIANCE_TASKS: Record<string, ComplianceTaskDef> = {
  gen_monthly: {
    label: 'Generator monthly load test', category: 'ees', standard: 'NFPA 110', interval: { every: 1, unit: 'month' }, graceDays: 10, target: 'asset',
    checks: [
      { key: 'ran_30_min', label: 'Ran under load for at least 30 minutes' },
      { key: 'load_or_exhaust_ok', label: 'Load at least 30% of nameplate, or exhaust temperature at or above the manufacturer minimum' },
      { key: 'no_alarms', label: 'No alarms or abnormal readings' },
    ],
    appliesTo: { assetTypes: ['generator'] },
  },
  gen_triennial: {
    label: 'Generator 4-hour load test', category: 'ees', standard: 'NFPA 110', interval: { every: 36, unit: 'month' }, graceDays: 30, target: 'asset',
    checks: [
      { key: 'ran_4_hours', label: 'Ran for at least 4 hours' },
      { key: 'load_ok', label: 'Load at least 30% of nameplate throughout' },
      { key: 'no_alarms', label: 'No alarms or abnormal readings' },
    ],
    appliesTo: { assetTypes: ['generator'] },
  },
  ats_monthly: {
    label: 'Transfer switch monthly test', category: 'ees', standard: 'NFPA 110', interval: { every: 1, unit: 'month' }, graceDays: 10, target: 'asset',
    checks: [
      { key: 'transferred', label: 'Transferred to emergency and back to normal' },
      { key: 'within_10s', label: 'Life safety and critical branches restored within 10 seconds' },
    ],
    appliesTo: { assetTypes: ['ats'] },
  },
  egress_lighting_monthly: {
    label: 'Battery egress lighting 30-second test', category: 'life_safety', standard: 'NFPA 101', interval: { every: 1, unit: 'month' }, graceDays: 10, target: 'project',
    checks: [{ key: 'all_lit_30s', label: 'Every battery unit stayed lit for 30 seconds' }],
    appliesTo: { projectWide: true },
  },
  egress_lighting_annual: {
    label: 'Battery egress lighting 90-minute test', category: 'life_safety', standard: 'NFPA 101', interval: { every: 12, unit: 'month' }, graceDays: 30, target: 'project',
    checks: [{ key: 'all_lit_90min', label: 'Every battery unit stayed lit for 90 minutes' }],
    appliesTo: { projectWide: true },
  },
  water_flush: {
    label: 'Flush low-use water outlets', category: 'water', standard: 'Water management program', interval: { every: 1, unit: 'week' }, graceDays: 2, target: 'project',
    checks: [{ key: 'flushed', label: 'Low-use outlets on the program list flushed for the program duration' }],
    appliesTo: { projectWide: true },
  },
  water_temp_monthly: {
    label: 'Hot and cold water temperature checks', category: 'water', standard: 'Water management program', interval: { every: 1, unit: 'month' }, graceDays: 7, target: 'project',
    checks: [
      { key: 'hot_in_range', label: 'Hot water at sentinel outlets within the program range' },
      { key: 'cold_in_range', label: 'Cold water at sentinel outlets within the program range' },
    ],
    appliesTo: { projectWide: true },
  },
  aiir_pressure_daily: {
    label: 'Isolation room pressure check while occupied', category: 'ventilation', standard: 'ASHRAE 170 / infection prevention policy', interval: { every: 1, unit: 'day' }, graceDays: 0, target: 'room',
    checks: [{ key: 'negative_confirmed', label: 'Room confirmed negative (monitor or visual indicator) and door closed' }],
    appliesTo: { spaceTypes: ['aiir'] },
  },
  pe_pressure_daily: {
    label: 'Protective environment pressure check while occupied', category: 'ventilation', standard: 'ASHRAE 170 / infection prevention policy', interval: { every: 1, unit: 'day' }, graceDays: 0, target: 'room',
    checks: [{ key: 'positive_confirmed', label: 'Room confirmed positive (monitor or visual indicator) and door closed' }],
    appliesTo: { spaceTypes: ['pe_room'] },
  },
  medgas_alarm_annual: {
    label: 'Medical gas alarm and valve check', category: 'medical_gas', standard: 'NFPA 99', interval: { every: 12, unit: 'month' }, graceDays: 30, target: 'medgas_zone',
    checks: [
      { key: 'area_alarm_ok', label: 'Area alarm signals tested and annunciated' },
      { key: 'valves_labeled', label: 'Zone valves accessible, labeled and identified' },
    ],
    appliesTo: { withGasZones: true },
  },
};

export const COMPLIANCE_VERIFIED = false;

export function addInterval(iso: string, i: Interval): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (i.unit === 'day') d.setUTCDate(d.getUTCDate() + i.every);
  else if (i.unit === 'week') d.setUTCDate(d.getUTCDate() + 7 * i.every);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + i.every);
    d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  }
  return d.toISOString().slice(0, 10);
}

export type TaskStatus = 'current' | 'due' | 'overdue' | 'failed';

/**
 * Next due date and status. A task starts due on its start date. It is "due" from the due date
 * through the grace period, then overdue. A failed latest result stays failed until a pass.
 */
export function complianceStatus(input: { interval: Interval; graceDays: number; startOn: string; lastDoneOn?: string | null; lastResult?: 'pass' | 'fail' | null; asOf: string }): { status: TaskStatus; nextDue: string } {
  const nextDue = input.lastDoneOn ? addInterval(input.lastDoneOn, input.interval) : input.startOn.slice(0, 10);
  if (input.lastResult === 'fail') return { status: 'failed', nextDue: input.asOf.slice(0, 10) };
  const asOf = input.asOf.slice(0, 10);
  if (asOf < nextDue) return { status: 'current', nextDue };
  const limit = new Date(Date.parse(nextDue) + input.graceDays * 864e5).toISOString().slice(0, 10);
  return { status: asOf <= limit ? 'due' : 'overdue', nextDue };
}

/** Dates a task falls due in a window, for a calendar view. */
export function occurrences(nextDue: string, interval: Interval, from: string, to: string, max = 400): string[] {
  const out: string[] = [];
  let d = nextDue;
  while (d < from && out.length < max) d = addInterval(d, interval);
  while (d <= to && out.length < max) { out.push(d); d = addInterval(d, interval); }
  return out;
}

// --- Owner training ---------------------------------------------------------------------

export type Audience = 'facilities' | 'clinical' | 'infection_prevention' | 'safety' | 'it' | 'clinical_engineering';
export const AUDIENCES: Record<Audience, string> = {
  facilities: 'Facilities and engineering', clinical: 'Clinical staff', infection_prevention: 'Infection prevention',
  safety: 'Safety and emergency management', it: 'IT and communications', clinical_engineering: 'Clinical engineering',
};

/** Who needs training on a system, by discipline. Owners may add topics per project. */
export function requiredAudiences(discipline: string, systemType: string): Audience[] {
  const t = systemType.toLowerCase();
  const out: Audience[] = ['facilities'];
  if (discipline === 'electrical' || t.startsWith('ees')) out.push('safety');
  if (t === 'hvac' || discipline === 'mechanical') out.push('infection_prevention');
  if (discipline === 'medical_gas') out.push('clinical', 'safety');
  if (discipline === 'fire_alarm' || discipline === 'fire_protection') out.push('safety', 'clinical');
  if (['nurse_call', 'rtls', 'pneumatic_tube'].includes(t) || discipline === 'communications') out.push('clinical', 'it');
  if (t === 'imaging' || discipline === 'medical_equipment') out.push('clinical_engineering', 'clinical');
  return [...new Set(out)];
}
