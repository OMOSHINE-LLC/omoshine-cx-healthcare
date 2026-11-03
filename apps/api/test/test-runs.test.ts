import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, expectStatus, type World } from './helpers.js';

let w: World;
let aiirTemplate: { id: string; items: { id: string; seq: number; requirement_key: string | null; response_type: string }[] };
let pfcTemplateId: string;

beforeAll(async () => {
  w = await createWorld();
  const templates = expectStatus(await w.as.cxa.get('/templates'), 200) as { id: string; name: string }[];
  const aiir = templates.find((t) => t.name.includes('Airborne infection isolation'))!;
  pfcTemplateId = templates.find((t) => t.name.includes('Air handling unit'))!.id;
  aiirTemplate = expectStatus(await w.as.cxa.get(`/templates/${aiir.id}`), 200);
});
afterAll(() => w.close());

async function reauth(client = w.as.cxa) {
  return expectStatus(await client.post('/auth/reauth', { pin: w.tenant.pin }), 200).reauthToken as string;
}

async function completedAiirRun(achValue: number) {
  const run = expectStatus(await w.as.cxa.post('/test-runs', { templateId: aiirTemplate.id, targetType: 'room', targetId: w.ids.aiir }), 201);
  for (const item of aiirTemplate.items) {
    const value = item.response_type === 'number' ? (item.requirement_key?.endsWith('total_ach') ? achValue : 3) : 'pass';
    expectStatus(await w.as.cxa.put(`/test-runs/${run.id}/responses/${item.id}`, { value }), 200);
  }
  return run.id as string;
}

describe('template library', () => {
  it('ships published global templates with code-linked items', () => {
    expect(aiirTemplate.items.length).toBeGreaterThan(3);
    expect(aiirTemplate.items.some((i) => i.requirement_key === 'ashrae170.aiir.total_ach')).toBe(true);
  });
});

describe('functional performance test lifecycle', () => {
  it('evaluates numeric responses against the cited code requirement', async () => {
    const run = expectStatus(await w.as.cxa.post('/test-runs', { templateId: aiirTemplate.id, targetType: 'room', targetId: w.ids.aiir }), 201);
    const achItem = aiirTemplate.items.find((i) => i.requirement_key === 'ashrae170.aiir.total_ach')!;
    const low = expectStatus(await w.as.cxa.put(`/test-runs/${run.id}/responses/${achItem.id}`, { value: 10 }), 200);
    expect(low.status).toBe('fail');
    expect(low.evaluation.citation).toBe('ASHRAE 170-2021 Table 7-1');
    const ok = expectStatus(await w.as.cxa.put(`/test-runs/${run.id}/responses/${achItem.id}`, { value: 14 }), 200);
    expect(ok.status).toBe('pass');
  });

  it('will not submit with required items unanswered', async () => {
    const run = expectStatus(await w.as.cxa.post('/test-runs', { templateId: pfcTemplateId, targetType: 'system', targetId: w.ids.ahu }), 201);
    const r = await w.as.cxa.post(`/test-runs/${run.id}/submit`);
    expect(r.status).toBe(400);
    expect(r.body.title).toMatch(/unanswered/);
  });

  it('submits, requires re-authentication to sign, then locks the record', async () => {
    const id = await completedAiirRun(10);
    const submitted = expectStatus(await w.as.cxa.post(`/test-runs/${id}/submit`), 200);
    expect(submitted.result).toBe('fail');

    expect((await w.as.cxa.post(`/test-runs/${id}/signatures`, { meaning: 'performed' })).status).toBe(401);
    expect((await w.as.cxa.post('/auth/reauth', { pin: '9999' })).status).toBe(401);
    expect((await w.as.cxa.post(`/test-runs/${id}/signatures`, { meaning: 'performed' }, { 'x-reauth-token': 'garbage' })).status).toBe(401);

    const token = await reauth();
    const sig = expectStatus(await w.as.cxa.post(`/test-runs/${id}/signatures`, { meaning: 'performed' }, { 'x-reauth-token': token }), 201);
    expect(sig.record_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sig.signer_role).toBe('cxa');

    const detail = expectStatus(await w.as.cxa.get(`/test-runs/${id}`), 200);
    expect(detail.run.status).toBe('signed');

    const item = aiirTemplate.items[0]!;
    expect((await w.as.cxa.put(`/test-runs/${id}/responses/${item.id}`, { value: 'pass' })).status).toBe(423);
  });

  it('a re-auth token issued to one user cannot be used by another', async () => {
    const id = await completedAiirRun(14);
    expectStatus(await w.as.cxa.post(`/test-runs/${id}/submit`), 200);
    const cxaToken = await reauth(w.as.cxa);
    expect((await w.as.gc.post(`/test-runs/${id}/signatures`, { meaning: 'witnessed' }, { 'x-reauth-token': cxaToken })).status).toBe(401);
  });

  it('enforces which signature meanings each role may apply', async () => {
    const id = await completedAiirRun(14);
    expectStatus(await w.as.cxa.post(`/test-runs/${id}/submit`), 200);
    expect((await w.as.gc.post(`/test-runs/${id}/signatures`, { meaning: 'approved' }, { 'x-reauth-token': await reauth(w.as.gc) })).status).toBe(403);
    expectStatus(await w.as.gc.post(`/test-runs/${id}/signatures`, { meaning: 'witnessed' }, { 'x-reauth-token': await reauth(w.as.gc) }), 201);
    // AHJ signs acceptance on an already-signed record.
    expectStatus(await w.as.ahj.post(`/test-runs/${id}/signatures`, { meaning: 'ahj_accepted' }, { 'x-reauth-token': await reauth(w.as.ahj) }), 201);
    // The same person cannot apply the same meaning twice.
    expect((await w.as.ahj.post(`/test-runs/${id}/signatures`, { meaning: 'ahj_accepted' }, { 'x-reauth-token': await reauth(w.as.ahj) })).status).toBe(409);
    const v = expectStatus(await w.as.ahj.get(`/test-runs/${id}/verify`), 200);
    expect(v.valid).toBe(true);
    expect(v.signatures).toHaveLength(2);
  });

  it('corrections create a superseding run; the signed original is preserved', async () => {
    const id = await completedAiirRun(10);
    expectStatus(await w.as.cxa.post(`/test-runs/${id}/submit`), 200);
    expectStatus(await w.as.cxa.post(`/test-runs/${id}/signatures`, { meaning: 'performed' }, { 'x-reauth-token': await reauth() }), 201);
    const fresh = expectStatus(await w.as.cxa.post(`/test-runs/${id}/supersede`, { reason: 'Rebalanced exhaust fan; retest' }), 201);
    expect(fresh.supersedes).toBe(id);
    const old = expectStatus(await w.as.cxa.get(`/test-runs/${id}`), 200);
    expect(old.run.status).toBe('superseded');
    expect(old.run.superseded_by).toBe(fresh.id);
    expect(old.responses.length).toBe(aiirTemplate.items.length);
    // Signatures on the superseded run still verify against its unchanged content.
    expect(expectStatus(await w.as.cxa.get(`/test-runs/${id}/verify`), 200).valid).toBe(true);
    // Superseding twice is refused.
    expect((await w.as.cxa.post(`/test-runs/${id}/supersede`, { reason: 'again' })).status).toBe(409);
  });

  it('the database refuses to edit a signed run directly', async () => {
    const { default: pg } = await import('pg');
    const id = await completedAiirRun(14);
    expectStatus(await w.as.cxa.post(`/test-runs/${id}/submit`), 200);
    expectStatus(await w.as.cxa.post(`/test-runs/${id}/signatures`, { meaning: 'performed' }, { 'x-reauth-token': await reauth() }), 201);
    const c = new pg.Client({ connectionString: w.adminUrl });
    await c.connect();
    try {
      await expect(c.query(`UPDATE test_run SET result = 'pass' WHERE id = $1`, [id])).rejects.toThrow(/IMMUTABLE/);
      await expect(c.query(`DELETE FROM test_response WHERE test_run_id = $1`, [id])).rejects.toThrow(/IMMUTABLE/);
    } finally {
      await c.end();
    }
  });

  it('lists runs with target labels and records every step in the audit log', async () => {
    const runs = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/test-runs`), 200);
    expect(runs.some((r: { target_label: string }) => r.target_label === 'ISO-12 Isolation 12')).toBe(true);
    const audit = expectStatus(await w.as.cxa.get('/audit?entityType=test_run&limit=500'), 200) as { action: string }[];
    const actions = new Set(audit.map((a) => a.action));
    for (const a of ['test_run.start', 'test_response.record', 'test_run.submit', 'test_run.sign', 'test_run.supersede']) expect(actions).toContain(a);
  });
});
