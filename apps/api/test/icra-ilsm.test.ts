import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createWorld, expectStatus, type World } from './helpers.js';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

const reauth = async (c: World['as'][keyof World['as']]) => expectStatus(await c.post('/auth/reauth', { pin: w.tenant.pin }), 200).reauthToken as string;

const CLASS_IV_ALL = {
  dust_minimized: true, ceiling_tiles_replaced: true, active_dust_control: true, walk_off_mats: true, unused_doors_sealed: true,
  hvac_isolated: true, debris_covered: true, barriers_intact: true, hepa_running: true, negative_pressure_confirmed: true,
  anteroom_in_use: true, ppe_shoe_covers: true, penetrations_sealed: true,
};

describe('ICRA zones', () => {
  let zoneId: string;

  it('computes the ICRA class from construction type and patient risk', async () => {
    const z = expectStatus(await w.as.gc.post(`/projects/${w.ids.project}/icra-zones`, {
      name: 'Level 2 OR suite demolition', departmentId: w.ids.dept, constructionType: 'D', riskGroup: 'highest',
      barrierType: 'Hard wall, floor to deck, with anteroom', adjacentAreas: 'OR-01 to OR-03 (occupied), sterile core',
    }), 201);
    expect(z.icra_class).toBe('IV');
    expect(z.controls).toHaveLength(13);
    expect(z.approval.status).toBe('pending');
    zoneId = z.id;
  });

  it('refuses to lower the class below the matrix', async () => {
    const z = expectStatus(await w.as.gc.post(`/projects/${w.ids.project}/icra-zones`, {
      name: 'Corridor ceiling inspection', constructionType: 'D', riskGroup: 'low', classOverride: 'I',
    }), 201);
    expect(z.icra_class).toBe('IV');
  });

  it('only Infection Prevention can approve the permit, with re-authentication', async () => {
    expect((await w.as.ip.post(`/icra-zones/${zoneId}/approve`)).status).toBe(401);
    expect((await w.as.cxa.post(`/icra-zones/${zoneId}/approve`, {}, { 'x-reauth-token': await reauth(w.as.cxa) })).status).toBe(403);
    expectStatus(await w.as.ip.post(`/icra-zones/${zoneId}/approve`, {}, { 'x-reauth-token': await reauth(w.as.ip) }), 201);
    const z = expectStatus(await w.as.cxa.get(`/icra-zones/${zoneId}`), 200);
    expect(z.approval).toMatchObject({ status: 'approved', by: 'Robin Infection Prevention' });
    expect((await w.as.ip.post(`/icra-zones/${zoneId}/approve`, {}, { 'x-reauth-token': await reauth(w.as.ip) })).status).toBe(409);
  });

  it('a change to the zone requires Infection Prevention to approve again', async () => {
    const z = expectStatus(await w.as.gc.patch(`/icra-zones/${zoneId}`, { barrierType: 'Hard wall with anteroom and HEPA exhaust' }), 200);
    expect(z.approval.status).toBe('reapproval_required');
    expectStatus(await w.as.ip.post(`/icra-zones/${zoneId}/approve`, {}, { 'x-reauth-token': await reauth(w.as.ip) }), 201);
    expect(expectStatus(await w.as.cxa.get(`/icra-zones/${zoneId}`), 200).approval.status).toBe('approved');
  });

  it('records a passing daily log', async () => {
    const r = expectStatus(await w.as.gc.post(`/icra-zones/${zoneId}/logs`, { controls: CLASS_IV_ALL, pressureDiffInWc: -0.02 }), 201);
    expect(r.evaluation.overall).toBe('pass');
    expect(r.issueId).toBeNull();
  });

  it('a failed log opens an issue automatically', async () => {
    const r = expectStatus(await w.as.gc.post(`/icra-zones/${zoneId}/logs`, {
      controls: { ...CLASS_IV_ALL, barriers_intact: false }, pressureDiffInWc: 0.002, correctiveAction: 'Barrier resealed at 10:15; HEPA unit relocated',
    }), 201);
    expect(r.evaluation.overall).toBe('fail');
    const issue = expectStatus(await w.as.cxa.get(`/issues/${r.issueId}`), 200);
    expect(issue.title).toMatch(/ICRA Level 2 OR suite demolition: daily inspection failed \(Class IV\)/);
    expect(issue.description).toMatch(/Critical barriers intact/);
    expect(issue.description).toMatch(/not negative/);
    expect(issue.description).toMatch(/Corrective action: Barrier resealed/);
  });

  it('applies the project minimum negative pressure when set', async () => {
    expectStatus(await w.as.cxa.patch(`/icra-zones/${zoneId}`, { minNegativePressureInWc: 0.01 }), 200);
    const r = expectStatus(await w.as.gc.post(`/icra-zones/${zoneId}/logs`, { controls: CLASS_IV_ALL, pressureDiffInWc: -0.004 }), 201);
    expect(r.evaluation.overall).toBe('fail');
  });

  it('lists zones with today’s status and a 30-day history', async () => {
    const zones = expectStatus(await w.as.ip.get(`/projects/${w.ids.project}/icra-zones`), 200);
    const z = zones.find((x: { id: string }) => x.id === zoneId);
    expect(z.today).toBe('fail');
    expect(z.history).toHaveLength(30);
    expect(z.history.at(-1).status).toBe('fail');
    const other = zones.find((x: { id: string }) => x.id !== zoneId);
    expect(other.today).toBe('missing');
  });

  it('enforces permissions and keeps logs append-only', async () => {
    expect((await w.as.clinical.post(`/icra-zones/${zoneId}/logs`, { controls: CLASS_IV_ALL })).status).toBe(403);
    expect((await w.as.ahj.post(`/projects/${w.ids.project}/icra-zones`, { name: 'x', constructionType: 'A', riskGroup: 'low' })).status).toBe(403);
    const c = new pg.Client({ connectionString: w.adminUrl });
    await c.connect();
    try {
      await expect(c.query(`UPDATE icra_log SET overall = 'pass' WHERE zone_id = $1`, [zoneId])).rejects.toThrow(/IMMUTABLE/);
    } finally {
      await c.end();
    }
  });

  it('a closed zone takes no more logs', async () => {
    expectStatus(await w.as.cxa.patch(`/icra-zones/${zoneId}`, { active: false }), 200);
    expect((await w.as.gc.post(`/icra-zones/${zoneId}/logs`, { controls: CLASS_IV_ALL, pressureDiffInWc: -0.02 })).status).toBe(409);
  });
});

describe('ILSM and fire watch', () => {
  let alarmId: string;
  let egressId: string;

  it('assesses a fire alarm impairment and requires a fire watch beyond 4 hours', async () => {
    const a = expectStatus(await w.as.safety.post(`/projects/${w.ids.project}/ilsm-assessments`, {
      deficiencyType: 'fire_alarm_impaired', description: 'Level 2 west detection loop disabled for device replacement',
      location: 'Level 2 west wing', expectedOutOfServiceHours: 12, identifiedAt: new Date(Date.now() - 3 * 3600e3).toISOString(),
    }), 201);
    expect(a.required_measures).toContain('fire_watch');
    expect(a.required_measures).toContain('notify_fire_department');
    alarmId = a.id;
    const short = expectStatus(await w.as.safety.post(`/projects/${w.ids.project}/ilsm-assessments`, {
      deficiencyType: 'egress_compromised', description: 'Stair B exit blocked by scaffold', location: 'Stair B', expectedOutOfServiceHours: 2,
    }), 201);
    expect(short.required_measures).not.toContain('fire_watch');
    egressId = short.id;
  });

  it('logs fire watch patrols and reports gaps over the patrol interval', async () => {
    const t0 = Date.now() - 3 * 3600e3;
    for (const minutes of [50, 100]) {
      expectStatus(await w.as.gc.post(`/ilsm-assessments/${alarmId}/fire-watch`, {
        patrolledAt: new Date(t0 + minutes * 60e3).toISOString(), area: 'Level 2 west', allClear: true,
      }), 201);
    }
    const list = expectStatus(await w.as.safety.get(`/projects/${w.ids.project}/ilsm-assessments`), 200);
    const a = list.find((x: { id: string }) => x.id === alarmId);
    expect(a.patrols).toHaveLength(2);
    // Last patrol at +100 min; now is +180 min → one 80-minute gap.
    expect(a.gaps).toHaveLength(1);
    expect(a.gaps[0].minutes).toBeGreaterThanOrEqual(79);
  });

  it('requires findings when a patrol is not all clear, and refuses patrols where no fire watch is required', async () => {
    expect((await w.as.gc.post(`/ilsm-assessments/${alarmId}/fire-watch`, { area: 'L2', allClear: false })).status).toBe(400);
    expect((await w.as.gc.post(`/ilsm-assessments/${egressId}/fire-watch`, { area: 'Stair B', allClear: true })).status).toBe(400);
    expect((await w.as.clinical.post(`/ilsm-assessments/${alarmId}/fire-watch`, { area: 'L2', allClear: true })).status).toBe(403);
  });

  it('cannot be resolved until every required measure is documented, then locks', async () => {
    const r = await w.as.safety.patch(`/ilsm-assessments/${egressId}`, { status: 'resolved' });
    expect(r.status).toBe(400);
    expect(r.body.title).toMatch(/alternative_exits_posted/);
    const a = expectStatus(await w.as.safety.get(`/projects/${w.ids.project}/ilsm-assessments`), 200).find((x: { id: string }) => x.id === egressId);
    const done = expectStatus(await w.as.safety.patch(`/ilsm-assessments/${egressId}`, { implementedMeasures: a.required_measures, status: 'resolved' }), 200);
    expect(done.status).toBe('resolved');
    expect((await w.as.safety.patch(`/ilsm-assessments/${egressId}`, { implementedMeasures: [] })).status).toBe(423);
  });

  it('exposes the measure catalogue', async () => {
    const cat = expectStatus(await w.as.cxa.get('/ilsm/catalog'), 200);
    expect(cat.policy.patrolIntervalMin).toBe(60);
    expect(Object.keys(cat.deficiencyTypes)).toContain('sprinkler_impaired');
  });
});
