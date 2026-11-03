/**
 * Seed a demo tenant and project for local development:
 *   npm run migrate -w @omoshine/api && npm run seed -w @omoshine/api
 * Prints the demo logins. Never run against production.
 */
import { buildApp } from './app.js';
import { config } from './config.js';
import { createPool } from './db.js';
import { seedTenant } from './fixtures.js';

const db = createPool();
const app = await buildApp({ db });
const t = await seedTenant(config.adminDatabaseUrl, `demo${Date.now().toString(36)}`, '2468');

async function call(token: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) {
  const r = await app.inject({ method, url: `/api/v1${url}`, ...(payload === undefined ? {} : { payload: payload as object }), headers: { authorization: `Bearer ${token}` } });
  if (r.statusCode >= 300) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.json();
}
async function login(email: string) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/dev-login', payload: { email, pin: t.pin } });
  return r.json().token as string;
}

const admin = await login(t.users.admin.email);
const project = await call(admin, 'POST', '/projects', { name: 'West Tower Surgical Expansion', facilityName: 'Riverside Medical Center', stateCode: 'CA', creatorRole: 'owner' });
for (const [k, role] of [['cxa', 'cxa'], ['gc', 'gc'], ['tab', 'tab'], ['ahj', 'ahj'], ['clinical', 'clinical_rep'], ['ip', 'infection_prevention'], ['safety', 'safety_officer'], ['medgas', 'medgas_verifier']] as const) {
  await call(admin, 'POST', `/projects/${project.id}/role-assignments`, { userId: t.users[k].id, role });
}
const cxa = await login(t.users.cxa.email);
const b = await call(cxa, 'POST', `/projects/${project.id}/buildings`, { name: 'West Tower' });
const ph1 = await call(cxa, 'POST', `/projects/${project.id}/phases`, { name: 'Phase 1 – Surgery', sequence: 1, targetOccupancyDate: '2027-03-01' });
const ph2 = await call(cxa, 'POST', `/projects/${project.id}/phases`, { name: 'Phase 2 – Inpatient', sequence: 2, targetOccupancyDate: '2027-09-01' });
const l2 = await call(cxa, 'POST', `/buildings/${b.id}/floors`, { name: 'Level 2', level: 2 });
const l4 = await call(cxa, 'POST', `/buildings/${b.id}/floors`, { name: 'Level 4', level: 4 });
const surg = await call(cxa, 'POST', `/floors/${l2.id}/departments`, { name: 'Surgical Services', phaseId: ph1.id });
const spd = await call(cxa, 'POST', `/floors/${l2.id}/departments`, { name: 'Sterile Processing', phaseId: ph1.id });
const medsurg = await call(cxa, 'POST', `/floors/${l4.id}/departments`, { name: 'Med/Surg 4 West', phaseId: ph2.id });

const rooms: Record<string, { id: string }> = {};
for (const [dept, number, name, st, vol] of [
  [surg, 'OR-01', 'Operating Room 1', 'or_class_bc', 5200], [surg, 'OR-02', 'Operating Room 2', 'or_class_bc', 5200],
  [surg, 'OR-03', 'Operating Room 3', 'or_class_bc', 5000], [surg, 'OR-04', 'Operating Room 4 (Hybrid)', 'or_class_bc', 7200],
  [spd, 'SPD-101', 'Decontamination', 'spd_decon', 3600], [spd, 'SPD-102', 'Clean Workroom', 'spd_clean_work', 4200],
  [medsurg, '4W-12', 'Isolation 12', 'aiir', 1200], [medsurg, '4W-14', 'Patient Room 14', 'patient_room', 1500],
  [medsurg, '4W-20', 'Protective Environment 20', 'pe_room', 1300],
] as const) {
  rooms[number] = await call(cxa, 'POST', `/departments/${dept.id}/rooms`, { number, name, spaceTypeId: st, volumeCuft: vol });
}

const tab = await login(t.users.tab.email);
const csv = [
  'room_number,supply_cfm,exhaust_cfm,oa_cfm,pressure_in_wc,temp_f,rh_pct,all_exhaust,recirc_room_units',
  'OR-01,2200,,450,0.012,66,45,,no',
  'OR-02,2100,,440,0.010,68,48,,no',
  'OR-03,1500,,400,0.009,68,63,,no',
  'OR-04,3000,,600,0.011,67,50,,no',
  'SPD-101,500,700,130,-0.015,66,45,yes,no',
  'SPD-102,330,,150,0.008,70,40,,no',
  '4W-12,260,360,60,0.004,72,40,yes,no',
  '4W-14,120,,55,,72,45,,',
].join('\n');
await call(tab, 'POST', `/projects/${project.id}/imports/tab`, { csv });

const ees = await call(cxa, 'POST', `/projects/${project.id}/systems`, { name: 'Essential Electrical System', discipline: 'electrical', systemType: 'ees_type1' });
await call(cxa, 'POST', `/projects/${project.id}/systems`, { name: 'AHU-1 Surgery', systemType: 'hvac' });
for (const [tag, branch, panel] of [['ATS-LS-1', 'life_safety', 'LS-2A'], ['ATS-CR-1', 'critical', 'CR-2A'], ['ATS-CR-2', 'critical', 'CR-4A'], ['ATS-EQ-1', 'equipment', 'EQ-2A']]) {
  const a = await call(cxa, 'POST', `/systems/${ees.id}/assets`, { tag, assetType: 'ats', attributes: { branch, served_panel: panel } });
  if (tag !== 'ATS-EQ-1') await call(cxa, 'POST', `/assets/${a.id}/ats-tests`, { transferTimeS: tag === 'ATS-CR-2' ? 11.4 : 7.8 });
}
const gen = await call(cxa, 'POST', `/systems/${ees.id}/assets`, { tag: 'GEN-1', assetType: 'generator', attributes: { rating_kw: 2000, mfr_min_exhaust_temp_f: 650 } });
await call(cxa, 'POST', `/assets/${gen.id}/generator-tests`, { testType: 'monthly', durationMin: 35, loadPct: 38 });

await call(cxa, 'POST', `/projects/${project.id}/issues`, { title: 'OR-03 below 20 ACH and humidity above 60%', roomId: rooms['OR-03']!.id, requirementKey: 'ashrae170.or_class_bc.total_ach', ballInCourtOrgId: t.orgs.tab, priority: 'high' });
await call(cxa, 'POST', `/projects/${project.id}/issues`, { title: '4W-12 isolation room reading positive', roomId: rooms['4W-12']!.id, requirementKey: 'ashrae170.aiir.pressure_relationship', lifeSafety: true, ballInCourtOrgId: t.orgs.gc });
await call(cxa, 'POST', `/projects/${project.id}/issues`, { title: 'ATS-CR-2 transfer 11.4 s exceeds 10 s', systemId: ees.id, lifeSafety: true, ballInCourtOrgId: t.orgs.elec });

// Phase 2: ICRA, ILSM and medical gas.
const gc = await login(t.users.gc.email);
const icraZone = await call(gc, 'POST', `/projects/${project.id}/icra-zones`, {
  name: 'Level 2 OR suite renovation', departmentId: surg.id, constructionType: 'D', riskGroup: 'highest',
  barrierType: 'Hard wall, floor to deck, with anteroom', adjacentAreas: 'OR-01 and OR-02 (occupied), sterile core',
});
await call(gc, 'POST', `/icra-zones/${icraZone.id}/logs`, {
  controls: Object.fromEntries(icraZone.controls.map((c: { key: string }) => [c.key, true])), pressureDiffInWc: -0.02,
});
const safety = await login(t.users.safety.email);
await call(safety, 'POST', `/projects/${project.id}/ilsm-assessments`, {
  deficiencyType: 'fire_alarm_impaired', description: 'Level 2 west detection loop disabled for device replacement',
  location: 'Level 2 west wing', expectedOutOfServiceHours: 12,
});
const mg = await call(cxa, 'POST', `/projects/${project.id}/medgas-zones`, { name: 'OR suite zone 2A', departmentId: surg.id, zoneValveTag: 'ZVB-2A', gases: ['oxygen', 'medical_air', 'vacuum'] });
await call(gc, 'POST', `/medgas-zones/${mg.id}/outlets`, { outlets: ['OR-01', 'OR-02'].flatMap((r) => [
  { label: `${r} O2-1`, gas: 'oxygen', roomId: rooms[r]!.id }, { label: `${r} MA-1`, gas: 'medical_air', roomId: rooms[r]!.id },
  { label: `${r} VAC-1`, gas: 'vacuum', roomId: rooms[r]!.id },
]) });
const verifier = await login(t.users.medgas.email);
const cred = { verifierCredential: 'ASSE 6030 #DEMO-001' };
await call(verifier, 'POST', `/medgas-zones/${mg.id}/tests`, { testType: 'cross_connection', readings: { outletsTested: 6, wrongGasFound: false }, ...cred });
for (const gas of ['oxygen', 'medical_air', 'vacuum']) {
  await call(verifier, 'POST', `/medgas-zones/${mg.id}/tests`, { testType: 'standing_pressure', gas, readings: { durationHours: 24, leakFound: false }, ...cred });
}
await call(verifier, 'POST', `/medgas-zones/${mg.id}/tests`, { testType: 'piping_purity', gas: 'oxygen', readings: { dewPointF: 61, hydrocarbonDeltaPpm: 1 }, notes: 'Moisture in branch; purge and retest', ...cred });

// Life safety: a few dampers, doors and devices, one failed door, and a PFI item.
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };
await call(cxa, 'POST', `/projects/${project.id}/ls-items`, { items: [
  { kind: 'fire_damper', tag: 'FD-2-01', location: 'Above corridor 2C ceiling, grid C/4', installedOn: yearsAgo(2) },
  { kind: 'combination_damper', tag: 'FSD-2-02', location: 'Smoke barrier at corridor 2D', installedOn: yearsAgo(0) },
  { kind: 'fire_door', tag: 'D-2-101', roomId: rooms['OR-01']!.id, location: 'Corridor door to OR-01', ratingMinutes: 90 },
  { kind: 'smoke_door', tag: 'D-2-150', location: 'Cross-corridor smoke barrier doors 2C', ratingMinutes: 20 },
  { kind: 'smoke_detector', tag: 'SD-2-001', location: 'Corridor 2C' },
  { kind: 'waterflow_switch', tag: 'WF-2', location: 'Riser 2, Level 2 floor control' },
] });
const lsList = await call(cxa, 'GET', `/projects/${project.id}/ls-items`);
const lsTag = (tag: string) => lsList.items.find((i: { tag: string }) => i.tag === tag).id;
const catalog = await call(cxa, 'GET', '/life-safety/catalog');
const yes = (kind: string) => Object.fromEntries(catalog.kinds[kind].items.map((i: { key: string }) => [i.key, true]));
await call(cxa, 'POST', `/ls-items/${lsTag('SD-2-001')}/inspections`, { answers: yes('smoke_detector') });
await call(gc, 'POST', `/ls-items/${lsTag('D-2-101')}/inspections`, { answers: { ...yes('fire_door'), latches: false }, notes: 'Latch bolt does not engage the strike' });
await call(safety, 'POST', `/projects/${project.id}/pfi`, { deficiency: 'Unsealed penetrations in 1-hour smoke barrier above corridor 2C ceiling', codeReference: 'NFPA 101 8.5.6', location: 'Level 2, corridor 2C', plannedCompletion: new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10) });

// Activation: some of Phase 1's checklist is done.
const act = await call(cxa, 'GET', `/phases/${ph1.id}/activation`);
const actItem = (key: string) => act.items.find((i: { key: string }) => i.key === key).id;
await call(cxa, 'PATCH', `/activation-items/${actItem('accreditor_notice')}`, { status: 'done', evidence: 'Notification letter sent to accreditor; confirmation on file' });
await call(cxa, 'PATCH', `/activation-items/${actItem('air_balance_final')}`, { status: 'done', evidence: 'TAB final report rev 2 accepted by CxA' });
await call(cxa, 'PATCH', `/activation-items/${actItem('move_plan')}`, { status: 'na', evidence: 'New service line; no patients transfer from existing units' });

console.log('\nDemo seeded. Sign in at http://localhost:5173 with PIN 2468 as:');
for (const [k, u] of Object.entries(t.users)) console.log(`  ${k.padEnd(9)} ${u.email}`);
await app.close();
await db.end();
