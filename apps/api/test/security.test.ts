import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createWorld, expectStatus, type World } from './helpers.js';

let w: World;
let other: World;

beforeAll(async () => {
  w = await createWorld();
  other = await createWorld();
});
afterAll(async () => {
  await w.close();
  await other.close();
});

describe('authentication', () => {
  it('rejects requests without a session', async () => {
    expect((await w.anon.get(`/projects/${w.ids.project}`)).status).toBe(401);
  });
  it('rejects a bad PIN', async () => {
    expect((await w.anon.post('/auth/dev-login', { email: w.tenant.users.cxa.email, pin: '0000' })).status).toBe(401);
  });
  it('rejects a forged token', async () => {
    const r = await w.anon.req('GET', '/api/v1/me', undefined, { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad' });
    expect(r.status).toBe(401);
  });
  it('serves health and logo without auth', async () => {
    expect((await w.anon.get('/api/v1/health')).status).toBe(200);
    const logo = await w.app.inject({ method: 'GET', url: '/brand/logo.png' });
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
  });
});

describe('tenant isolation', () => {
  it('a user from another tenant cannot see the project', async () => {
    const r = await other.as.admin.get(`/projects/${w.ids.project}`);
    expect([403, 404]).toContain(r.status);
    const list = expectStatus(await other.as.admin.get('/projects'), 200);
    expect(list.map((p: { id: string }) => p.id)).not.toContain(w.ids.project);
  });

  it('row-level security hides other tenants even from raw SQL on the app role', async () => {
    const c = new pg.Client({ connectionString: w.appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [other.tenant.tenantId]);
      const r = await c.query('SELECT id FROM project WHERE id = $1', [w.ids.project]);
      expect(r.rowCount).toBe(0);
      await c.query('ROLLBACK');
      // No tenant set at all: nothing is visible.
      const none = await c.query('SELECT count(*)::int AS n FROM room');
      expect(none.rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('cannot create rows in another tenant', async () => {
    const r = await other.as.cxa.post(`/departments/${w.ids.dept}/rooms`, { number: 'X', name: 'X', spaceTypeId: 'patient_room', volumeCuft: 1000 });
    expect(r.status).toBe(404);
  });
});

describe('role-based access', () => {
  it('a user with no assignment on the project is forbidden', async () => {
    expect((await w.as.outsider.get(`/projects/${w.ids.project}`)).status).toBe(403);
  });
  it('a clinical rep can read but cannot record measurements', async () => {
    expect((await w.as.clinical.get(`/rooms/${w.ids.or}/data-sheet`)).status).toBe(200);
    expect((await w.as.clinical.post(`/rooms/${w.ids.or}/measurements`, { supplyCfm: 2000 })).status).toBe(403);
  });
  it('the AHJ is read-and-sign only', async () => {
    expect((await w.as.ahj.get(`/projects/${w.ids.project}/readiness`)).status).toBe(200);
    expect((await w.as.ahj.post(`/projects/${w.ids.project}/issues`, { title: 'Inspector issue' })).status).toBe(403);
    expect((await w.as.ahj.post(`/projects/${w.ids.project}/buildings`, { name: 'Nope' })).status).toBe(403);
  });
  it('only tenant admins create projects', async () => {
    expect((await w.as.cxa.post('/projects', { name: 'P', facilityName: 'F', stateCode: 'TX' })).status).toBe(403);
  });
  it('scoped assignments apply only within their scope', async () => {
    // Give the outsider TAB rights on the Surgical Services department only.
    expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/role-assignments`, {
      userId: w.tenant.users.outsider.id, role: 'tab', scopeType: 'department', scopeId: w.ids.dept,
    }), 201);
    expect((await w.as.outsider.post(`/rooms/${w.ids.or}/measurements`, { supplyCfm: 2100 })).status).toBe(201);
    // ...but not project-wide actions.
    expect((await w.as.outsider.get(`/projects/${w.ids.project}/readiness`)).status).toBe(403);
  });
});

describe('immutable records and audit trail', () => {
  it('the app role cannot update or delete append-only tables', async () => {
    expectStatus(await w.as.tab.post(`/rooms/${w.ids.or}/measurements`, { supplyCfm: 2000 }), 201);
    const c = new pg.Client({ connectionString: w.appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [w.tenant.tenantId]);
      await expect(c.query(`UPDATE room_measurement SET overall = 'pass'`)).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [w.tenant.tenantId]);
      await expect(c.query('DELETE FROM audit_log')).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('triggers block mutation even for the database owner', async () => {
    const c = new pg.Client({ connectionString: w.adminUrl });
    await c.connect();
    try {
      await expect(c.query(`UPDATE room_measurement SET overall = 'pass' WHERE tenant_id = $1`, [w.tenant.tenantId])).rejects.toThrow(/IMMUTABLE/);
    } finally {
      await c.end();
    }
  });

  it('the audit chain verifies, and detects tampering', async () => {
    const ok = expectStatus(await w.as.admin.get('/audit/verify'), 200);
    expect(ok.ok).toBe(true);
    expect(ok.entries).toBeGreaterThan(10);

    // Simulate an attacker with owner access who bypasses the trigger.
    const c = new pg.Client({ connectionString: w.adminUrl });
    await c.connect();
    try {
      await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only');
      await c.query(`UPDATE audit_log SET data = '{"tampered":true}' WHERE seq = (SELECT seq FROM audit_log WHERE tenant_id = $1 ORDER BY seq OFFSET 3 LIMIT 1)`, [w.tenant.tenantId]);
      await c.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only');
    } finally {
      await c.end();
    }
    const bad = expectStatus(await w.as.admin.get('/audit/verify'), 200);
    expect(bad.ok).toBe(false);
    expect(bad.brokenAt).toBeDefined();
    // The other tenant's chain is unaffected.
    expect(expectStatus(await other.as.admin.get('/audit/verify'), 200).ok).toBe(true);
  });

  it('audit verification is limited to tenant admins', async () => {
    expect((await w.as.cxa.get('/audit/verify')).status).toBe(403);
  });
});
