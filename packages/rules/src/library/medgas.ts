/**
 * Medical gas and vacuum system verification (NFPA 99 Chapter 5, Category 1 systems).
 *
 * The test list follows the verification sequence an independent ASSE 6030
 * verifier performs before a piped system is put into use. Wording is
 * OMOSHINE's own. Every limit below is verified=false until confirmed against
 * the licensed edition the project adopts (CMS enforces NFPA 99-2012); the
 * consultant review workbook lists each value.
 */

export type MedGas = 'oxygen' | 'medical_air' | 'nitrous_oxide' | 'carbon_dioxide' | 'nitrogen' | 'instrument_air' | 'vacuum';

export interface GasSpec {
  label: string;
  kind: 'positive' | 'vacuum';
  /** Operating pressure band at the outlet, psig (positive-pressure gases). */
  pressurePsig?: { min: number; max: number };
  /** Minimum vacuum at the inlet under test flow, in. Hg (vacuum). */
  minVacuumInHg?: number;
  /** Test flow for the outlet flow test, standard litres per minute. */
  testFlowSlpm: number;
  /** Maximum pressure drop from static to flowing at the test flow, psi (positive gases). */
  maxFlowDropPsi?: number;
  /** Concentration limits for the gas named in `analyte`, percent by volume. */
  concentration?: { analyte: string; minPct?: number; maxPct?: number };
}

export const MED_GASES: Record<MedGas, GasSpec> = {
  oxygen: { label: 'Oxygen', kind: 'positive', pressurePsig: { min: 50, max: 55 }, testFlowSlpm: 100, maxFlowDropPsi: 5, concentration: { analyte: 'oxygen', minPct: 99 } },
  medical_air: { label: 'Medical air', kind: 'positive', pressurePsig: { min: 50, max: 55 }, testFlowSlpm: 100, maxFlowDropPsi: 5, concentration: { analyte: 'oxygen', minPct: 19.5, maxPct: 23.5 } },
  nitrous_oxide: { label: 'Nitrous oxide', kind: 'positive', pressurePsig: { min: 50, max: 55 }, testFlowSlpm: 100, maxFlowDropPsi: 5, concentration: { analyte: 'nitrous oxide', minPct: 99 } },
  carbon_dioxide: { label: 'Carbon dioxide', kind: 'positive', pressurePsig: { min: 50, max: 55 }, testFlowSlpm: 100, maxFlowDropPsi: 5, concentration: { analyte: 'carbon dioxide', minPct: 99 } },
  nitrogen: { label: 'Nitrogen', kind: 'positive', pressurePsig: { min: 160, max: 185 }, testFlowSlpm: 140, maxFlowDropPsi: 5, concentration: { analyte: 'nitrogen', minPct: 99 } },
  instrument_air: { label: 'Instrument air', kind: 'positive', pressurePsig: { min: 160, max: 185 }, testFlowSlpm: 140, maxFlowDropPsi: 5, concentration: { analyte: 'oxygen', minPct: 19.5, maxPct: 23.5 } },
  vacuum: { label: 'Medical-surgical vacuum', kind: 'vacuum', minVacuumInHg: 12, testFlowSlpm: 85 },
};

/** Purity limits applied to every positive-pressure gas in the piping purity and particulate tests. */
export const PIPING_LIMITS = {
  maxDewPointF: 54,
  maxHydrocarbonDeltaPpm: 5,
  maxParticulateMgPerM3: 0.1,
  minStandingHours: 24,
};

export const MEDGAS_LIMITS_VERIFIED = false;

export type MedGasTestType =
  | 'standing_pressure'
  | 'cross_connection'
  | 'valve_test'
  | 'alarm_test'
  | 'piping_particulate'
  | 'piping_purity'
  | 'outlet_function'
  | 'outlet_flow'
  | 'concentration';

export interface MedGasTestDef {
  key: MedGasTestType;
  label: string;
  /** zone: once per zone; gas: once per gas in the zone; outlet: once per outlet. */
  per: 'zone' | 'gas' | 'outlet';
  /** Applies only to positive-pressure gases. */
  positiveOnly?: boolean;
  fields: { key: string; label: string; type: 'number' | 'boolean'; unit?: string }[];
}

/** In the order a verifier normally performs them. */
export const MEDGAS_TESTS: MedGasTestDef[] = [
  { key: 'standing_pressure', label: 'Standing pressure test', per: 'gas', fields: [
    { key: 'durationHours', label: 'Test duration', type: 'number', unit: 'h' },
    { key: 'leakFound', label: 'Pressure loss attributable to a leak', type: 'boolean' },
  ] },
  { key: 'cross_connection', label: 'Cross-connection test', per: 'zone', fields: [
    { key: 'outletsTested', label: 'Outlets and inlets tested', type: 'number' },
    { key: 'wrongGasFound', label: 'Any outlet delivered a gas other than the test gas', type: 'boolean' },
  ] },
  { key: 'valve_test', label: 'Zone valve test', per: 'zone', fields: [
    { key: 'valvesControlLabeledOutlets', label: 'Every zone valve shuts off only the outlets it is labeled for', type: 'boolean' },
  ] },
  { key: 'alarm_test', label: 'Area alarm test', per: 'gas', fields: [
    { key: 'lowAlarm', label: 'Low pressure (low vacuum) alarm activates', type: 'boolean' },
    { key: 'highAlarm', label: 'High pressure alarm activates (positive gases)', type: 'boolean' },
  ] },
  { key: 'piping_particulate', label: 'Piping particulate test', per: 'gas', positiveOnly: true, fields: [
    { key: 'particulateMgPerM3', label: 'Particulate', type: 'number', unit: 'mg/m³' },
  ] },
  { key: 'piping_purity', label: 'Piping purity test', per: 'gas', positiveOnly: true, fields: [
    { key: 'dewPointF', label: 'Dew point', type: 'number', unit: '°F' },
    { key: 'hydrocarbonDeltaPpm', label: 'Total hydrocarbons above source', type: 'number', unit: 'ppm' },
  ] },
  { key: 'outlet_function', label: 'Outlet function and labeling', per: 'outlet', fields: [
    { key: 'labeledCorrectly', label: 'Outlet labeled and color coded for its gas', type: 'boolean' },
    { key: 'gasSpecific', label: 'Connector is gas-specific; wrong-gas adapters do not fit', type: 'boolean' },
    { key: 'latchesAndReleases', label: 'Adapter latches, holds and releases', type: 'boolean' },
  ] },
  { key: 'outlet_flow', label: 'Outlet pressure and flow', per: 'outlet', fields: [
    { key: 'staticPsig', label: 'Static pressure', type: 'number', unit: 'psig' },
    { key: 'flowingPsig', label: 'Pressure at test flow', type: 'number', unit: 'psig' },
    { key: 'vacuumInHg', label: 'Vacuum at test flow (vacuum inlets)', type: 'number', unit: 'in. Hg' },
  ] },
  { key: 'concentration', label: 'Gas concentration', per: 'outlet', positiveOnly: true, fields: [
    { key: 'percent', label: 'Measured concentration', type: 'number', unit: '%' },
  ] },
];

export function findMedGasTest(key: string): MedGasTestDef | undefined {
  return MEDGAS_TESTS.find((t) => t.key === key);
}

export interface MedGasOutletRef { id: string; label: string; gas: MedGas }

/** One test the zone needs before it can be certified. */
export interface RequiredMedGasTest { key: string; testType: MedGasTestType; gas: MedGas | null; outletId: string | null; label: string }

export const requirementKey = (testType: string, gas: string | null, outletId: string | null) => [testType, gas ?? '-', outletId ?? '-'].join(':');

/** Every test a zone needs, given its gases and its outlets. */
export function requiredMedGasTests(gases: MedGas[], outlets: MedGasOutletRef[]): RequiredMedGasTest[] {
  const out: RequiredMedGasTest[] = [];
  for (const t of MEDGAS_TESTS) {
    if (t.per === 'zone') out.push({ key: requirementKey(t.key, null, null), testType: t.key, gas: null, outletId: null, label: t.label });
    if (t.per === 'gas') {
      for (const g of gases) {
        if (t.positiveOnly && MED_GASES[g].kind !== 'positive') continue;
        out.push({ key: requirementKey(t.key, g, null), testType: t.key, gas: g, outletId: null, label: `${t.label}: ${MED_GASES[g].label}` });
      }
    }
    if (t.per === 'outlet') {
      for (const o of outlets) {
        if (t.positiveOnly && MED_GASES[o.gas].kind !== 'positive') continue;
        out.push({ key: requirementKey(t.key, o.gas, o.id), testType: t.key, gas: o.gas, outletId: o.id, label: `${t.label}: ${o.label}` });
      }
    }
  }
  return out;
}

export interface MedGasCheck { key: string; label: string; status: 'pass' | 'fail' | 'not_evaluated'; reason?: string }

export interface MedGasTestInput {
  testType: MedGasTestType;
  gas?: MedGas | null;
  readings: Record<string, number | boolean | undefined>;
  /** Number of outlets in the zone; the cross-connection test must cover all of them. */
  zoneOutletCount?: number;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

function check(key: string, label: string, ok: boolean | undefined, reason: string): MedGasCheck {
  if (ok === undefined) return { key, label, status: 'not_evaluated' };
  return ok ? { key, label, status: 'pass' } : { key, label, status: 'fail', reason };
}

/** Evaluate one verification test. Pure; the limits come from this library. */
export function evaluateMedGasTest(input: MedGasTestInput): { checks: MedGasCheck[]; overall: 'pass' | 'fail' | 'incomplete' } {
  const r = input.readings;
  const spec = input.gas ? MED_GASES[input.gas] : undefined;
  const checks: MedGasCheck[] = [];
  switch (input.testType) {
    case 'standing_pressure': {
      const h = num(r.durationHours);
      checks.push(check('duration', 'Held for the full test period', h === undefined ? undefined : h >= PIPING_LIMITS.minStandingHours, `Held ${h} h; at least ${PIPING_LIMITS.minStandingHours} h required`));
      const leak = bool(r.leakFound);
      checks.push(check('no_leak', 'No pressure loss from leaks', leak === undefined ? undefined : !leak, 'Pressure loss attributable to a leak'));
      break;
    }
    case 'cross_connection': {
      const n = num(r.outletsTested);
      const need = input.zoneOutletCount ?? 0;
      checks.push(check('coverage', 'Every outlet and inlet tested', n === undefined ? undefined : n >= need, `${n} of ${need} outlets tested`));
      const wrong = bool(r.wrongGasFound);
      checks.push(check('no_cross_connection', 'No cross-connection found', wrong === undefined ? undefined : !wrong, 'An outlet delivered a gas other than the test gas'));
      break;
    }
    case 'valve_test':
      checks.push(check('valves', 'Zone valves control only their labeled outlets', bool(r.valvesControlLabeledOutlets), 'A zone valve does not match its label'));
      break;
    case 'alarm_test':
      checks.push(check('low_alarm', spec?.kind === 'vacuum' ? 'Low vacuum alarm' : 'Low pressure alarm', bool(r.lowAlarm), 'Alarm did not activate'));
      if (spec?.kind !== 'vacuum') checks.push(check('high_alarm', 'High pressure alarm', bool(r.highAlarm), 'Alarm did not activate'));
      break;
    case 'piping_particulate': {
      const p = num(r.particulateMgPerM3);
      checks.push(check('particulate', 'Particulate', p === undefined ? undefined : p <= PIPING_LIMITS.maxParticulateMgPerM3, `${p} mg/m³ exceeds ${PIPING_LIMITS.maxParticulateMgPerM3} mg/m³`));
      break;
    }
    case 'piping_purity': {
      const d = num(r.dewPointF);
      checks.push(check('dew_point', 'Dew point', d === undefined ? undefined : d <= PIPING_LIMITS.maxDewPointF, `Dew point ${d} °F above ${PIPING_LIMITS.maxDewPointF} °F`));
      const hc = num(r.hydrocarbonDeltaPpm);
      checks.push(check('hydrocarbons', 'Hydrocarbons versus source', hc === undefined ? undefined : hc <= PIPING_LIMITS.maxHydrocarbonDeltaPpm, `${hc} ppm above source exceeds ${PIPING_LIMITS.maxHydrocarbonDeltaPpm} ppm`));
      break;
    }
    case 'outlet_function':
      checks.push(check('labeled', 'Labeled and color coded', bool(r.labeledCorrectly), 'Label or color code wrong'));
      checks.push(check('gas_specific', 'Gas-specific connector', bool(r.gasSpecific), 'Connector accepts a wrong-gas adapter'));
      checks.push(check('latch', 'Latches and releases', bool(r.latchesAndReleases), 'Adapter does not latch or release'));
      break;
    case 'outlet_flow': {
      if (!spec) break;
      if (spec.kind === 'vacuum') {
        const v = num(r.vacuumInHg);
        checks.push(check('vacuum', `Vacuum at ${spec.testFlowSlpm} SLPM`, v === undefined ? undefined : v >= spec.minVacuumInHg!, `${v} in. Hg below ${spec.minVacuumInHg} in. Hg`));
      } else {
        const s = num(r.staticPsig);
        const f = num(r.flowingPsig);
        const band = spec.pressurePsig!;
        checks.push(check('static', 'Static pressure in range', s === undefined ? undefined : s >= band.min && s <= band.max, `${s} psig outside ${band.min}–${band.max} psig`));
        const drop = s !== undefined && f !== undefined ? s - f : undefined;
        checks.push(check('flow_drop', `Pressure drop at ${spec.testFlowSlpm} SLPM`, drop === undefined ? undefined : drop <= spec.maxFlowDropPsi!, `Drop of ${drop?.toFixed(1)} psi exceeds ${spec.maxFlowDropPsi} psi`));
      }
      break;
    }
    case 'concentration': {
      const c = spec?.concentration;
      const pct = num(r.percent);
      if (!c) break;
      const ok = pct === undefined ? undefined : (c.minPct === undefined || pct >= c.minPct) && (c.maxPct === undefined || pct <= c.maxPct);
      const range = c.maxPct !== undefined ? `${c.minPct}–${c.maxPct}%` : `at least ${c.minPct}%`;
      checks.push(check('concentration', `${c.analyte[0]!.toUpperCase()}${c.analyte.slice(1)} concentration`, ok, `${pct}% ${c.analyte}; required ${range}`));
      break;
    }
  }
  const overall = checks.some((c) => c.status === 'fail') ? 'fail'
    : checks.length === 0 || checks.some((c) => c.status === 'not_evaluated') ? 'incomplete' : 'pass';
  return { checks, overall };
}

export interface MedGasResultRef { testType: string; gas: string | null; outletId: string | null; overall: 'pass' | 'fail' | 'incomplete'; testedAt: string }

/** Latest result for each required test, and whether the zone is ready for the verifier to certify. */
export function medGasZoneStatus(required: RequiredMedGasTest[], results: MedGasResultRef[]) {
  const latest = new Map<string, MedGasResultRef>();
  for (const r of results) {
    const k = requirementKey(r.testType, r.gas, r.outletId);
    const prev = latest.get(k);
    if (!prev || prev.testedAt <= r.testedAt) latest.set(k, r);
  }
  const items = required.map((q) => ({ ...q, latest: latest.get(q.key) ?? null, status: latest.get(q.key)?.overall ?? 'not_tested' }));
  const count = (s: string) => items.filter((i) => i.status === s).length;
  const passed = count('pass');
  return {
    items,
    summary: { required: items.length, passed, failed: count('fail'), incomplete: count('incomplete'), notTested: count('not_tested') },
    readyToCertify: items.length > 0 && passed === items.length,
  };
}
