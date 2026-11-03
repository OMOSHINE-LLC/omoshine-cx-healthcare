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

async function call(token: string, method: 'POST' | 'PUT', url: string, payload: unknown) {
  const r = await app.inject({ method, url: `/api/v1${url}`, payload: payload as object, headers: { authorization: `Bearer ${token}` } });
  if (r.statusCode >= 300) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.json();
}
async function login(email: string) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/dev-login', payload: { email, pin: t.pin } });
  return r.json().token as string;
}

const admin = await login(t.users.admin.email);
const project = await call(admin, 'POST', '/projects', { name: 'West Tower Surgical Expansion', facilityName: 'Riverside Medical Center', stateCode: 'CA', creatorRole: 'owner' });
for (const [k, role] of [['cxa', 'cxa'], ['gc', 'gc'], ['tab', 'tab'], ['ahj', 'ahj'], ['clinical', 'clinical_rep']] as const) {
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

console.log('\nDemo seeded. Sign in at http://localhost:5173 with PIN 2468 as:');
for (const [k, u] of Object.entries(t.users)) console.log(`  ${k.padEnd(9)} ${u.email}`);
await app.close();
await db.end();
