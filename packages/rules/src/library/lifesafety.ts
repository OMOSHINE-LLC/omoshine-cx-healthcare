/**
 * Life safety inspection library: fire and smoke dampers (NFPA 80 / NFPA 105),
 * fire and smoke doors (NFPA 80 / NFPA 101), fire alarm devices (NFPA 72), and
 * the Statement of Conditions plan-for-improvement items.
 *
 * Wording is OMOSHINE's own. Frequencies and checklist items are verified=false
 * until confirmed against the editions the project adopts (CMS enforces NFPA 101
 * and NFPA 99 2012, which reference their own NFPA 80, 72 and 105 editions);
 * hospitals often set stricter intervals, which the policy allows.
 */

export type LifeSafetyKind =
  | 'fire_damper' | 'smoke_damper' | 'combination_damper'
  | 'fire_door' | 'smoke_door'
  | 'smoke_detector' | 'heat_detector' | 'duct_detector' | 'manual_pull_station' | 'notification_appliance'
  | 'waterflow_switch' | 'tamper_switch';

export interface LifeSafetyKindDef {
  label: string;
  group: 'damper' | 'door' | 'fire_alarm';
  standard: string;
  /** Inspection items; every one must be "yes" to pass. */
  items: { key: string; label: string }[];
}

const damperCommon = [
  { key: 'access_door_ok', label: 'Access door present, operable and labeled' },
  { key: 'no_obstruction', label: 'No obstruction in the damper path' },
  { key: 'full_closure', label: 'Damper closed fully when released or actuated' },
  { key: 'reset_open', label: 'Damper reset to the fully open position' },
  { key: 'no_damage', label: 'Blades, frame, sleeve and retaining angles undamaged; no corrosion' },
];

export const LIFE_SAFETY_KINDS: Record<LifeSafetyKind, LifeSafetyKindDef> = {
  fire_damper: { label: 'Fire damper', group: 'damper', standard: 'NFPA 80', items: [
    { key: 'fusible_link_ok', label: 'Fusible link (or heat-responsive device) present, correct rating, not painted or damaged' },
    ...damperCommon,
  ] },
  smoke_damper: { label: 'Smoke damper', group: 'damper', standard: 'NFPA 105', items: [
    { key: 'actuator_ok', label: 'Actuator operated the damper from the detection or control signal' },
    ...damperCommon,
  ] },
  combination_damper: { label: 'Combination fire/smoke damper', group: 'damper', standard: 'NFPA 80 / NFPA 105', items: [
    { key: 'fusible_link_ok', label: 'Heat-responsive device present and correct rating' },
    { key: 'actuator_ok', label: 'Actuator operated the damper from the detection or control signal' },
    ...damperCommon,
  ] },
  fire_door: { label: 'Fire door assembly', group: 'door', standard: 'NFPA 80', items: [
    { key: 'labels_legible', label: 'Door and frame labels present and legible' },
    { key: 'no_holes_or_breaks', label: 'No open holes or breaks in door or frame surfaces' },
    { key: 'glazing_intact', label: 'Glazing, vision light frames and glazing beads intact and fastened' },
    { key: 'frame_hardware_secure', label: 'Door, frame, hinges, hardware and noncombustible threshold secure, aligned and undamaged' },
    { key: 'no_missing_parts', label: 'No parts missing or broken' },
    { key: 'clearances_ok', label: 'Clearances within limits (edges and bottom)' },
    { key: 'self_closing', label: 'Self-closing device closes the door fully from the open position' },
    { key: 'coordinator_ok', label: 'Coordinator makes the inactive leaf close before the active leaf (pairs)' },
    { key: 'latches', label: 'Positive latching hardware secures the door when closed' },
    { key: 'no_auxiliary_hardware', label: 'No auxiliary hardware that interferes with operation' },
    { key: 'no_field_modifications', label: 'No field modifications that void the label' },
    { key: 'gasketing_ok', label: 'Gasketing and edge seals present and intact where required' },
    { key: 'signage_ok', label: 'Signage affixed only as permitted' },
  ] },
  smoke_door: { label: 'Smoke barrier door', group: 'door', standard: 'NFPA 101 / NFPA 105', items: [
    { key: 'self_closing', label: 'Self-closing or automatic-closing; closes fully' },
    { key: 'latches_or_rabbet', label: 'Latches, or meets the permitted rabbet / astragal arrangement' },
    { key: 'gaps_ok', label: 'No gaps that would pass smoke beyond the permitted clearances' },
    { key: 'hold_open_releases', label: 'Hold-open device releases on alarm' },
    { key: 'no_damage', label: 'Door, frame and seals undamaged' },
  ] },
  smoke_detector: { label: 'Smoke detector', group: 'fire_alarm', standard: 'NFPA 72', items: [
    { key: 'alarm_received', label: 'Device initiated an alarm at the control unit' },
    { key: 'correct_address', label: 'Alarm reported the correct device address and location' },
    { key: 'sensitivity_ok', label: 'Sensitivity within the listed range (when tested)' },
  ] },
  heat_detector: { label: 'Heat detector', group: 'fire_alarm', standard: 'NFPA 72', items: [
    { key: 'alarm_received', label: 'Device initiated an alarm at the control unit' },
    { key: 'correct_address', label: 'Alarm reported the correct device address and location' },
  ] },
  duct_detector: { label: 'Duct smoke detector', group: 'fire_alarm', standard: 'NFPA 72 / NFPA 90A', items: [
    { key: 'alarm_or_supervisory', label: 'Device initiated the programmed alarm or supervisory signal' },
    { key: 'fan_shutdown', label: 'Air handler shut down (or dampers closed) as designed' },
    { key: 'airflow_ok', label: 'Sampling tube airflow within the listed range' },
  ] },
  manual_pull_station: { label: 'Manual pull station', group: 'fire_alarm', standard: 'NFPA 72', items: [
    { key: 'alarm_received', label: 'Device initiated an alarm at the control unit' },
    { key: 'unobstructed', label: 'Accessible and unobstructed' },
  ] },
  notification_appliance: { label: 'Notification appliance', group: 'fire_alarm', standard: 'NFPA 72', items: [
    { key: 'audible_ok', label: 'Audible output operated (and met the design level where measured)' },
    { key: 'visible_ok', label: 'Visible output flashed at the correct rate and synchronized' },
  ] },
  waterflow_switch: { label: 'Waterflow switch', group: 'fire_alarm', standard: 'NFPA 72 / NFPA 25', items: [
    { key: 'alarm_received', label: 'Alarm received within the allowed time after flow' },
    { key: 'correct_address', label: 'Alarm reported the correct zone' },
  ] },
  tamper_switch: { label: 'Valve supervisory (tamper) switch', group: 'fire_alarm', standard: 'NFPA 72 / NFPA 25', items: [
    { key: 'supervisory_received', label: 'Supervisory signal received when the valve was operated' },
    { key: 'restored', label: 'Signal restored when the valve returned to normal' },
  ] },
};

export interface LifeSafetyPolicy {
  /** Months between inspections after the first. */
  intervalMonths: Record<LifeSafetyKind, number>;
  /** Dampers: first test within this many months of installation or acceptance. */
  damperFirstTestMonths: number;
  /** Days before the due date that an item shows as "due soon". */
  dueSoonDays: number;
  verified: boolean;
}

/** Hospital defaults: dampers every 6 years (the hospital exception), doors and most devices annually. */
export const DEFAULT_LIFE_SAFETY_POLICY: LifeSafetyPolicy = {
  intervalMonths: {
    fire_damper: 72, smoke_damper: 72, combination_damper: 72,
    fire_door: 12, smoke_door: 12,
    smoke_detector: 12, heat_detector: 12, duct_detector: 12, manual_pull_station: 12, notification_appliance: 12,
    waterflow_switch: 6, tamper_switch: 6,
  },
  damperFirstTestMonths: 12,
  dueSoonDays: 30,
  verified: false,
};

export function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

export type DueStatus = 'current' | 'due_soon' | 'overdue' | 'never_inspected' | 'failed';

/**
 * When the next inspection is due and where the item stands. A failed latest
 * inspection stays "failed" until a passing one is recorded.
 */
export function lifeSafetyDue(input: {
  kind: LifeSafetyKind; installedOn?: string | null; lastPassedOn?: string | null; lastResult?: 'pass' | 'fail' | 'incomplete' | null;
  asOf: string; policy?: LifeSafetyPolicy;
}): { status: DueStatus; nextDue: string | null } {
  const policy = input.policy ?? DEFAULT_LIFE_SAFETY_POLICY;
  const isDamper = LIFE_SAFETY_KINDS[input.kind].group === 'damper';
  let nextDue: string | null = null;
  if (input.lastPassedOn) nextDue = addMonths(input.lastPassedOn, policy.intervalMonths[input.kind]);
  else if (isDamper && input.installedOn) nextDue = addMonths(input.installedOn, policy.damperFirstTestMonths);
  else if (input.installedOn) nextDue = addMonths(input.installedOn, policy.intervalMonths[input.kind]);
  if (input.lastResult === 'fail') return { status: 'failed', nextDue };
  if (!nextDue) return { status: 'never_inspected', nextDue: null };
  const asOf = input.asOf.slice(0, 10);
  if (nextDue < asOf) return { status: 'overdue', nextDue };
  const soon = new Date(Date.parse(asOf) + policy.dueSoonDays * 864e5).toISOString().slice(0, 10);
  if (nextDue <= soon) return { status: 'due_soon', nextDue };
  return { status: input.lastPassedOn ? 'current' : 'never_inspected', nextDue };
}

export function evaluateLifeSafetyInspection(kind: LifeSafetyKind, answers: Record<string, boolean | 'na' | undefined>) {
  const def = LIFE_SAFETY_KINDS[kind];
  const results = def.items.map((it) => {
    const a = answers[it.key];
    return { key: it.key, label: it.label, status: a === undefined ? 'not_evaluated' as const : a === 'na' || a ? 'pass' as const : 'fail' as const, notApplicable: a === 'na' };
  });
  const overall = results.some((r) => r.status === 'fail') ? 'fail' as const : results.some((r) => r.status === 'not_evaluated') ? 'incomplete' as const : 'pass' as const;
  return { results, overall };
}

/** Statement of Conditions: a plan-for-improvement item is overdue once its planned completion date passes. */
export function pfiStatus(item: { status: 'open' | 'resolved'; plannedCompletion: string }, asOf: string): 'resolved' | 'overdue' | 'open' {
  if (item.status === 'resolved') return 'resolved';
  return item.plannedCompletion < asOf.slice(0, 10) ? 'overdue' : 'open';
}
