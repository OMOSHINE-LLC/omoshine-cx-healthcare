/**
 * Phased occupancy and activation.
 *
 * A phase (a set of departments and rooms opened together) is ready to occupy
 * when its evidence gates pass and its activation checklist is complete. The
 * gates read existing records; the checklist covers what the platform cannot
 * measure (approvals, licensing visits, cleaning, stocking, staff orientation).
 *
 * Wording is OMOSHINE's own. State items name the agency from the state profile
 * and are verified=false until OMOSHINE's code reviewer confirms each state's
 * pre-occupancy process.
 */

export type ActivationCategory = 'regulatory' | 'life_safety' | 'infection_control' | 'facilities' | 'clinical' | 'it';

export interface ActivationTemplateItem {
  key: string;
  label: string;
  category: ActivationCategory;
  /** Required items must be done (or marked not applicable with a reason) before the phase can be signed ready. */
  required: boolean;
}

const COMMON: ActivationTemplateItem[] = [
  { key: 'ahj_final', label: 'Building official / AHJ final inspection passed and temporary or final certificate of occupancy received', category: 'regulatory', required: true },
  { key: 'fire_marshal', label: 'Fire marshal acceptance of fire alarm, sprinkler and smoke control for the phase', category: 'life_safety', required: true },
  { key: 'accreditor_notice', label: 'Accrediting organization notified of the new or changed space as its policy requires', category: 'regulatory', required: true },
  { key: 'egress_signage', label: 'Exit routes, signage and evacuation plans updated for the phase boundary', category: 'life_safety', required: true },
  { key: 'icra_closeout', label: 'ICRA barriers removed and terminal construction cleaning complete, approved by Infection Prevention', category: 'infection_control', required: true },
  { key: 'water_flush', label: 'Water system flushed and sampled per the water management program; results reviewed', category: 'infection_control', required: true },
  { key: 'air_balance_final', label: 'Final air balance report accepted for the phase', category: 'facilities', required: true },
  { key: 'cmms_loaded', label: 'Equipment loaded into the CMMS with preventive maintenance schedules', category: 'facilities', required: false },
  { key: 'om_training', label: 'Facilities staff trained on new systems (sign-in sheets on file)', category: 'facilities', required: true },
  { key: 'clinical_orientation', label: 'Clinical staff orientation and day-in-the-life simulations complete', category: 'clinical', required: true },
  { key: 'supplies_equipment', label: 'Medical equipment installed, inspected by clinical engineering, and supplies stocked', category: 'clinical', required: true },
  { key: 'nurse_call_it', label: 'Nurse call, network, phones and clinical applications tested end to end', category: 'it', required: true },
  { key: 'move_plan', label: 'Move plan and patient transfer sequence approved', category: 'clinical', required: false },
];

const STATE: Record<string, ActivationTemplateItem[]> = {
  CA: [
    { key: 'state_construction_final', label: 'HCAI construction final: all project documents closed and occupancy approval issued', category: 'regulatory', required: true },
    { key: 'state_licensing', label: 'CDPH licensing survey or approval for the added or changed beds and services', category: 'regulatory', required: true },
  ],
  NY: [
    { key: 'state_construction_final', label: 'NYSDOH construction approval conditions met and pre-opening documentation submitted', category: 'regulatory', required: true },
    { key: 'state_licensing', label: 'NYSDOH pre-opening survey or approval to operate the new space', category: 'regulatory', required: true },
  ],
  FL: [
    { key: 'state_construction_final', label: 'AHCA Office of Plans and Construction final survey passed', category: 'regulatory', required: true },
    { key: 'state_licensing', label: 'AHCA licensure updated for the added or changed beds and services', category: 'regulatory', required: true },
  ],
  TX: [
    { key: 'state_construction_final', label: 'HHSC architectural / life safety code inspection passed', category: 'regulatory', required: true },
    { key: 'state_licensing', label: 'HHSC licensing approval for the added or changed beds and services', category: 'regulatory', required: true },
  ],
};

export const ACTIVATION_TEMPLATE_VERIFIED = false;

/** Default activation checklist for a phase in the given state. Other states get the common items plus a generic state item. */
export function activationTemplate(stateCode: string): ActivationTemplateItem[] {
  const state = STATE[stateCode.toUpperCase()] ?? [
    { key: 'state_licensing', label: 'State licensing agency approval for the new or changed space', category: 'regulatory', required: true },
  ];
  return [...COMMON.slice(0, 3), ...state, ...COMMON.slice(3)];
}

export type GateKey = 'rooms' | 'tests' | 'medgas' | 'life_safety_items' | 'life_safety_issues' | 'checklist';
export type GateStatus = 'pass' | 'fail' | 'not_applicable';

export interface GateInput {
  rooms: { total: number; pass: number; fail: number; untested: number };
  tests: { total: number; signed: number; failed: number };
  medgasZones: { total: number; certified: number };
  lifeSafetyItems: { total: number; current: number; failed: number; overdue: number; neverInspected: number };
  openLifeSafetyIssues: number;
  checklist: { required: number; resolved: number };
}

export interface Gate { key: GateKey; label: string; status: GateStatus; detail: string }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Evidence gates for occupying a phase. Every gate must pass (or not apply)
 * before the phase can be signed ready. Rooms must have measurements: a phase
 * with no rooms cannot be occupied.
 */
export function phaseGates(g: GateInput): { gates: Gate[]; ready: boolean } {
  const gates: Gate[] = [];
  const r = g.rooms;
  gates.push({
    key: 'rooms', label: 'Every room meets its ventilation requirements',
    status: r.total > 0 && r.pass === r.total ? 'pass' : 'fail',
    detail: r.total === 0 ? 'No rooms are assigned to this phase' : `${r.pass} of ${plural(r.total, 'room')} pass${r.fail ? `; ${r.fail} failing` : ''}${r.untested ? `; ${r.untested} without a passing measurement set` : ''}`,
  });
  const t = g.tests;
  gates.push({
    key: 'tests', label: 'Functional tests signed with no failures',
    status: t.total === 0 ? 'not_applicable' : t.signed === t.total && t.failed === 0 ? 'pass' : 'fail',
    detail: t.total === 0 ? 'No tests scoped to this phase' : `${t.signed} of ${plural(t.total, 'test')} signed${t.failed ? `; ${t.failed} failed` : ''}`,
  });
  const m = g.medgasZones;
  gates.push({
    key: 'medgas', label: 'Medical gas zones certified',
    status: m.total === 0 ? 'not_applicable' : m.certified === m.total ? 'pass' : 'fail',
    detail: m.total === 0 ? 'No medical gas zones in this phase' : `${m.certified} of ${plural(m.total, 'zone')} certified`,
  });
  const l = g.lifeSafetyItems;
  const lsOk = l.total - l.failed - l.overdue - l.neverInspected;
  gates.push({
    key: 'life_safety_items', label: 'Dampers, doors and fire alarm devices inspected and passing',
    status: l.total === 0 ? 'not_applicable' : lsOk === l.total ? 'pass' : 'fail',
    detail: l.total === 0 ? 'No life safety items in this phase' : `${lsOk} of ${plural(l.total, 'item')} passing${l.failed ? `; ${l.failed} failed` : ''}${l.overdue ? `; ${l.overdue} overdue` : ''}${l.neverInspected ? `; ${l.neverInspected} never inspected` : ''}`,
  });
  gates.push({
    key: 'life_safety_issues', label: 'No open life safety issues',
    status: g.openLifeSafetyIssues === 0 ? 'pass' : 'fail',
    detail: g.openLifeSafetyIssues === 0 ? 'None open' : `${plural(g.openLifeSafetyIssues, 'open life safety issue')}`,
  });
  const c = g.checklist;
  gates.push({
    key: 'checklist', label: 'Activation checklist complete',
    status: c.resolved === c.required ? 'pass' : 'fail',
    detail: `${c.resolved} of ${plural(c.required, 'required item')} done or not applicable`,
  });
  return { gates, ready: gates.every((x) => x.status !== 'fail') };
}
