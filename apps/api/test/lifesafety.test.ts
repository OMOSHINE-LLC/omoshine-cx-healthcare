import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { LIFE_SAFETY_KINDS, addMonths } from '@omoshine/rules';
import { createWorld, expectStatus, type World } from './helpers.js';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

const today = () => new Date().toISOString().slice(0, 10);
const allYes = (kind: keyof typeof LIFE_SAFETY_KINDS) => Object.fromEntries(LIFE_SAFETY_KINDS[kind].items.map((i) => [i.key, true]));

describe('life safety inventory and inspections', () => {
  let doorId: string;
  let damperId: string;

  it('adds a batch of items, skipping tags that already exist', async () => {
    const r = expectStatus(await w.as.gc.post(`/projects/${w.ids.project}/ls-items`, { items: [
      { kind: 'fire_door', tag: 'D-2-101', roomId: w.ids.or, location: 'OR-04 corridor door', ratingMinutes: 90 },
      { kind: 'fire_damper', tag: 'FD-2-01', location: 'Above OR-04 ceiling', installedOn: addMonths(today(), -14) },
      { kind: 'smoke_detector', tag: 'SD-2-001', roomId: w.ids.aiir },
      { kind: 'fire_door', tag: 'D-2-101', location: 'duplicate' },
    ] }), 201);
    expect(r).toEqual({ created: 3, skipped: 1 });
    expect((await w.as.clinical.post(`/projects/${w.ids.project}/ls-items`, { items: [{ kind: 'fire_door', tag: 'D-X' }] })).status).toBe(403);
    expect((await w.as.gc.post(`/projects/${w.ids.project}/ls-items`, { items: [{ kind: 'fire_door', tag: 'D-Y', ratingMinutes: 30 }] })).status).toBe(400);

    const list = expectStatus(await w.as.clinical.get(`/projects/${w.ids.project}/ls-items`), 200);
    expect(list.items).toHaveLength(3);
    expect(list.summary.damper).toMatchObject({ total: 1, overdue: 1 });
    expect(list.summary.door).toMatchObject({ total: 1, never_inspected: 1 });
    doorId = list.items.find((i: { tag: string }) => i.tag === 'D-2-101').id;
    damperId = list.items.find((i: { tag: string }) => i.tag === 'FD-2-01').id;
    const dampers = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/ls-items?group=damper`), 200);
    expect(dampers.items.map((i: { tag: string }) => i.tag)).toEqual(['FD-2-01']);
  });

  it('a passing inspection sets the next due date', async () => {
    expect((await w.as.clinical.post(`/ls-items/${doorId}/inspections`, { answers: allYes('fire_door') })).status).toBe(403);
    expect((await w.as.gc.post(`/ls-items/${doorId}/inspections`, { performedOn: addMonths(today(), 1), answers: allYes('fire_door') })).status).toBe(400);
    const r = expectStatus(await w.as.gc.post(`/ls-items/${doorId}/inspections`, {
      answers: { ...allYes('fire_door'), coordinator_ok: 'na' }, inspectorCredential: 'Fire door inspector #77',
    }), 201);
    expect(r.evaluation.overall).toBe('pass');
    expect(r.issueId).toBeNull();
    expect(r.item).toMatchObject({ dueStatus: 'current', nextDue: addMonths(today(), 12) });
  });

  it('a failing inspection opens a high-priority life safety issue and marks the item failed', async () => {
    const r = expectStatus(await w.as.cxa.post(`/ls-items/${damperId}/inspections`, {
      answers: { ...allYes('fire_damper'), full_closure: false }, notes: 'Blade bound on the sleeve',
    }), 201);
    expect(r.evaluation.overall).toBe('fail');
    expect(r.item.dueStatus).toBe('failed');
    const issue = expectStatus(await w.as.cxa.get(`/issues/${r.issueId}`), 200);
    expect(issue).toMatchObject({ priority: 'high', life_safety: true });
    expect(issue.title).toBe('Fire damper FD-2-01 failed inspection');
    expect(issue.description).toMatch(/Damper closed fully/);
    expect(issue.description).toMatch(/Blade bound on the sleeve/);

    const fixed = expectStatus(await w.as.cxa.post(`/ls-items/${damperId}/inspections`, { answers: allYes('fire_damper') }), 201);
    expect(fixed.item).toMatchObject({ dueStatus: 'current', nextDue: addMonths(today(), 72) });
    const detail = expectStatus(await w.as.cxa.get(`/ls-items/${damperId}`), 200);
    expect(detail.inspections).toHaveLength(2);
    expect(detail.checklist).toHaveLength(LIFE_SAFETY_KINDS.fire_damper.items.length);
  });

  it('inspections are append-only and retired items cannot be inspected', async () => {
    const db = new pg.Client({ connectionString: w.appUrl });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [w.tenant.tenantId]);
      await expect(db.query('UPDATE ls_inspection SET overall = $1', ['pass'])).rejects.toThrow();
      await db.query('ROLLBACK');
    } finally {
      await db.end();
    }
    const sd = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/ls-items?group=fire_alarm`), 200).items[0];
    expectStatus(await w.as.safety.patch(`/ls-items/${sd.id}`, { active: false }), 200);
    expect((await w.as.cxa.post(`/ls-items/${sd.id}/inspections`, { answers: allYes('smoke_detector') })).status).toBe(409);
  });
});

describe('Statement of Conditions plan for improvement', () => {
  let pfiId: string;

  it('numbers items, flags overdue ones, and limits who can manage them', async () => {
    const body = { deficiency: 'Penetrations in 1-hour smoke barrier above corridor ceiling', codeReference: 'NFPA 101 8.5.6', location: 'Level 2 corridor 2C', plannedCompletion: '2026-01-15' };
    expect((await w.as.gc.post(`/projects/${w.ids.project}/pfi`, body)).status).toBe(403);
    const a = expectStatus(await w.as.safety.post(`/projects/${w.ids.project}/pfi`, body), 201);
    const b = expectStatus(await w.as.safety.post(`/projects/${w.ids.project}/pfi`, { ...body, deficiency: 'Damper FD-2-01 access door missing', plannedCompletion: addMonths(today(), 3) }), 201);
    expect([a.number, b.number]).toEqual([1, 2]);
    pfiId = a.id;
    const list = expectStatus(await w.as.clinical.get(`/projects/${w.ids.project}/pfi`), 200);
    expect(list.map((x: { number: number; pfiStatus: string }) => [x.number, x.pfiStatus])).toEqual([[1, 'overdue'], [2, 'open']]);
  });

  it('resolving needs a description, and resolved items are locked', async () => {
    expect((await w.as.safety.patch(`/pfi/${pfiId}`, { status: 'resolved' })).status).toBe(400);
    const r = expectStatus(await w.as.safety.patch(`/pfi/${pfiId}`, { status: 'resolved', resolution: 'Firestopped with listed system; photos attached' }), 200);
    expect(r.status).toBe('resolved');
    expect((await w.as.safety.patch(`/pfi/${pfiId}`, { plannedCompletion: '2027-01-01' })).status).toBe(423);
  });

  it('produces a branded report with the life safety sections and the OMOSHINE footer', async () => {
    const res = await w.as.ahj.get(`/projects/${w.ids.project}/life-safety/report`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Fire and smoke dampers/);
    expect(res.text).toMatch(/Fire and smoke doors/);
    expect(res.text).toMatch(/D-2-101/);
    expect(res.text).toMatch(/plan for improvement/);
    expect(res.text).toMatch(/Firestopped with listed system/);
    expect(res.text).toContain('Generated by OMOSHINE CX Planner – OMOSHINE LLC');
  });
});
