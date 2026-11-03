import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createWorld, expectStatus, type World } from './helpers.js';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

const reauth = async (c: World['as'][keyof World['as']]) => expectStatus(await c.post('/auth/reauth', { pin: w.tenant.pin }), 200).reauthToken as string;
const CRED = 'ASSE 6030 #12345';

/** Readings that pass, for each test type and gas. */
function passing(testType: string, gas: string | null): Record<string, number | boolean> {
  switch (testType) {
    case 'standing_pressure': return { durationHours: 24, leakFound: false };
    case 'cross_connection': return { outletsTested: 3, wrongGasFound: false };
    case 'valve_test': return { valvesControlLabeledOutlets: true };
    case 'alarm_test': return { lowAlarm: true, highAlarm: true };
    case 'piping_particulate': return { particulateMgPerM3: 0.02 };
    case 'piping_purity': return { dewPointF: 20, hydrocarbonDeltaPpm: 0.5 };
    case 'outlet_function': return { labeledCorrectly: true, gasSpecific: true, latchesAndReleases: true };
    case 'outlet_flow': return gas === 'vacuum' ? { vacuumInHg: 18 } : { staticPsig: 52, flowingPsig: 50 };
    case 'concentration': return { percent: gas === 'medical_air' ? 20.9 : 99.6 };
    default: throw new Error(testType);
  }
}

describe('medical gas verification', () => {
  let zoneId: string;
  let o2Outlet: string;

  it('creates a zone and its outlets, rejecting gases the zone does not carry', async () => {
    const zone = expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/medgas-zones`, {
      name: 'OR suite zone 2A', departmentId: w.ids.dept, zoneValveTag: 'ZVB-2A', gases: ['oxygen', 'medical_air', 'vacuum'],
    }), 201);
    zoneId = zone.id;
    expect((await w.as.gc.post(`/medgas-zones/${zoneId}/outlets`, { outlets: [{ label: 'OR-04 N2-1', gas: 'nitrogen' }] })).status).toBe(400);
    const r = expectStatus(await w.as.gc.post(`/medgas-zones/${zoneId}/outlets`, { outlets: [
      { label: 'OR-04 O2-1', gas: 'oxygen', roomId: w.ids.or },
      { label: 'OR-04 MA-1', gas: 'medical_air', roomId: w.ids.or },
      { label: 'OR-04 VAC-1', gas: 'vacuum', roomId: w.ids.or },
      { label: 'OR-04 O2-1', gas: 'oxygen', roomId: w.ids.or },
    ] }), 201);
    expect(r).toMatchObject({ created: 3, skipped: 1 });
    o2Outlet = r.outlets.find((o: { gas: string }) => o.gas === 'oxygen').id;
    const detail = expectStatus(await w.as.cxa.get(`/medgas-zones/${zoneId}`), 200);
    // 2 zone + standing 3 + alarm 3 + particulate 2 + purity 2 + function 3 + flow 3 + concentration 2
    expect(detail.summary.required).toBe(20);
    expect(detail.summary.notTested).toBe(20);
    expect(detail.certification.status).toBe('not_certified');
  });

  it('only the verifier records results, with a credential', async () => {
    const body = { testType: 'valve_test', readings: { valvesControlLabeledOutlets: true }, verifierCredential: CRED };
    expect((await w.as.gc.post(`/medgas-zones/${zoneId}/tests`, body)).status).toBe(403);
    expect((await w.as.cxa.post(`/medgas-zones/${zoneId}/tests`, body)).status).toBe(403);
    expect((await w.as.medgas.post(`/medgas-zones/${zoneId}/tests`, { ...body, verifierCredential: '' })).status).toBe(400);
    expect((await w.as.medgas.post(`/medgas-zones/${zoneId}/tests`, { testType: 'concentration', readings: { percent: 99 }, verifierCredential: CRED })).status).toBe(400);
    expect((await w.as.medgas.post(`/medgas-zones/${zoneId}/tests`, { testType: 'piping_purity', gas: 'vacuum', readings: {}, verifierCredential: CRED })).status).toBe(400);
  });

  it('a failed result opens a critical life safety issue against the room', async () => {
    const r = expectStatus(await w.as.medgas.post(`/medgas-zones/${zoneId}/tests`, {
      testType: 'outlet_flow', outletId: o2Outlet, readings: { staticPsig: 52, flowingPsig: 44 }, verifierCredential: CRED, notes: 'Kinked drop at the boom',
    }), 201);
    expect(r.evaluation.overall).toBe('fail');
    const issue = expectStatus(await w.as.cxa.get(`/issues/${r.issueId}`), 200);
    expect(issue).toMatchObject({ priority: 'critical', life_safety: true, room_id: w.ids.or });
    expect(issue.title).toMatch(/OR suite zone 2A: Outlet pressure and flow failed \(outlet OR-04 O2-1\)/);
    expect(issue.description).toMatch(/Drop of 8.0 psi exceeds 5 psi/);
  });

  it('refuses to certify until every required test passes, then certifies with re-authentication', async () => {
    const tok = await reauth(w.as.medgas);
    const early = await w.as.medgas.post(`/medgas-zones/${zoneId}/certify`, {}, { 'x-reauth-token': tok });
    expect(early.status).toBe(409);
    expect(early.body.title).toMatch(/Not every required test has passed/);

    const detail = expectStatus(await w.as.medgas.get(`/medgas-zones/${zoneId}`), 200);
    for (const item of detail.items) {
      expectStatus(await w.as.medgas.post(`/medgas-zones/${zoneId}/tests`, {
        testType: item.testType, ...(item.outletId ? { outletId: item.outletId } : item.gas ? { gas: item.gas } : {}),
        readings: passing(item.testType, item.gas), verifierCredential: CRED,
      }), 201);
    }
    const after = expectStatus(await w.as.medgas.get(`/medgas-zones/${zoneId}`), 200);
    expect(after.summary).toMatchObject({ required: 20, passed: 20, failed: 0 });
    expect(after.readyToCertify).toBe(true);

    expect((await w.as.cxa.post(`/medgas-zones/${zoneId}/certify`, {}, { 'x-reauth-token': await reauth(w.as.cxa) })).status).toBe(403);
    expect((await w.as.medgas.post(`/medgas-zones/${zoneId}/certify`)).status).toBe(401);
    expectStatus(await w.as.medgas.post(`/medgas-zones/${zoneId}/certify`, {}, { 'x-reauth-token': await reauth(w.as.medgas) }), 201);
    const list = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/medgas-zones`), 200);
    expect(list[0]).toMatchObject({ outletCount: 3, certification: { status: 'certified', by: 'Quinn Med Gas Verifier' } });
    expect((await w.as.medgas.post(`/medgas-zones/${zoneId}/certify`, {}, { 'x-reauth-token': await reauth(w.as.medgas) })).status).toBe(409);
  });

  it('a new outlet or a new result after certification requires recertification', async () => {
    expectStatus(await w.as.gc.post(`/medgas-zones/${zoneId}/outlets`, { outlets: [{ label: 'OR-04 O2-2', gas: 'oxygen', roomId: w.ids.or }] }), 201);
    const z = expectStatus(await w.as.cxa.get(`/medgas-zones/${zoneId}`), 200);
    expect(z.certification.status).toBe('recertification_required');
    expect(z.readyToCertify).toBe(false);
    expect(z.summary.notTested).toBe(3);
  });

  it('keeps results append-only and exposes the catalogue as unverified', async () => {
    const c = new pg.Client({ connectionString: w.adminUrl });
    await c.connect();
    try {
      await expect(c.query(`UPDATE medgas_test SET overall = 'pass' WHERE zone_id = $1`, [zoneId])).rejects.toThrow(/IMMUTABLE/);
    } finally {
      await c.end();
    }
    const cat = expectStatus(await w.as.cxa.get('/medgas/catalog'), 200);
    expect(cat.verified).toBe(false);
    expect(cat.gases.oxygen.pressurePsig).toEqual({ min: 50, max: 55 });
  });
});
