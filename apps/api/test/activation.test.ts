import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIFE_SAFETY_KINDS } from '@omoshine/rules';
import { createWorld, expectStatus, type World } from './helpers.js';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

const reauth = async (c: World['as'][keyof World['as']]) => expectStatus(await c.post('/auth/reauth', { pin: w.tenant.pin }), 200).reauthToken as string;
const GOOD_OR = { source: 'tab', supplyCfm: 2000, oaCfm: 400, pressureDiffInWc: 0.01, tempF: 68, rhPct: 45, recircRoomUnits: false };
const GOOD_AIIR = { source: 'tab', supplyCfm: 260, exhaustCfm: 360, oaCfm: 60, pressureDiffInWc: -0.01, allExhaust: true, recircRoomUnits: false, tempF: 72, rhPct: 40 };
const gate = (s: { gates: { key: string; status: string; detail: string }[] }, key: string) => s.gates.find((g) => g.key === key)!;

describe('phased occupancy and activation', () => {
  it('a new phase gets the state activation checklist', async () => {
    const s = expectStatus(await w.as.clinical.get(`/phases/${w.ids.phase}/activation`), 200);
    expect(s.phase.status).toBe('planned');
    expect(s.items.map((i: { key: string }) => i.key)).toContain('state_construction_final');
    expect(s.items.find((i: { key: string }) => i.key === 'state_construction_final').label).toMatch(/HCAI/);
    expect(s.ready).toBe(false);
    expect(gate(s, 'rooms').detail).toBe('0 of 2 rooms pass; 2 without a passing measurement set');
    expect(gate(s, 'tests').status).toBe('not_applicable');
    expect(s.templateVerified).toBe(false);
    // Initialising again creates nothing new.
    expect(expectStatus(await w.as.cxa.post(`/phases/${w.ids.phase}/activation/init`, {}), 200)).toEqual({ created: 0 });
  });

  it('checklist items need evidence or a reason, and only activation roles can change them', async () => {
    const s = expectStatus(await w.as.cxa.get(`/phases/${w.ids.phase}/activation`), 200);
    const item = s.items.find((i: { key: string }) => i.key === 'water_flush');
    expect((await w.as.gc.patch(`/activation-items/${item.id}`, { status: 'done', evidence: 'Report WM-12' })).status).toBe(403);
    expect((await w.as.ip.patch(`/activation-items/${item.id}`, { status: 'done' })).status).toBe(400);
    const done = expectStatus(await w.as.ip.patch(`/activation-items/${item.id}`, { status: 'done', evidence: 'Flushed 2026-10-30; Legionella culture negative (lab report WM-12)' }), 200);
    expect(done.status).toBe('done');
    const reopened = expectStatus(await w.as.ip.patch(`/activation-items/${item.id}`, { status: 'open' }), 200);
    expect(reopened).toMatchObject({ status: 'open', evidence: null, completed_by: null });
    const custom = expectStatus(await w.as.clinical.post(`/phases/${w.ids.phase}/activation-items`, { label: 'Pharmacy automated dispensing cabinets loaded', category: 'clinical' }), 201);
    expect(custom).toMatchObject({ key: 'custom_1', source: 'custom', required: true });
  });

  it('refuses to sign ready while gates fail, and explains why', async () => {
    const tok = await reauth(w.as.cxa);
    expect((await w.as.cxa.post(`/phases/${w.ids.phase}/signoff`, { kind: 'ready' })).status).toBe(401);
    const r = await w.as.cxa.post(`/phases/${w.ids.phase}/signoff`, { kind: 'ready' }, { 'x-reauth-token': tok });
    expect(r.status).toBe(409);
    expect(r.body.title).toMatch(/Every room meets its ventilation requirements/);
    expect(r.body.title).toMatch(/Activation checklist complete/);
    expect((await w.as.gc.post(`/phases/${w.ids.phase}/signoff`, { kind: 'ready' }, { 'x-reauth-token': await reauth(w.as.gc) })).status).toBe(403);
  });

  it('life safety items and open life safety issues in the phase block it', async () => {
    expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/ls-items`, { items: [{ kind: 'fire_door', tag: 'D-ACT-1', roomId: w.ids.or }] }), 201);
    let s = expectStatus(await w.as.cxa.get(`/phases/${w.ids.phase}/activation`), 200);
    expect(gate(s, 'life_safety_items')).toMatchObject({ status: 'fail', detail: '0 of 1 item passing; 1 never inspected' });
    const door = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/ls-items`), 200).items[0];
    const yes = Object.fromEntries(LIFE_SAFETY_KINDS.fire_door.items.map((i) => [i.key, true]));
    const failed = expectStatus(await w.as.cxa.post(`/ls-items/${door.id}/inspections`, { answers: { ...yes, latches: false } }), 201);
    s = expectStatus(await w.as.cxa.get(`/phases/${w.ids.phase}/activation`), 200);
    expect(gate(s, 'life_safety_issues')).toMatchObject({ status: 'fail', detail: '1 open life safety issue' });
    expectStatus(await w.as.cxa.post(`/ls-items/${door.id}/inspections`, { answers: yes }), 201);
    expectStatus(await w.as.cxa.patch(`/issues/${failed.issueId}`, { status: 'closed', resolution: 'Strike adjusted; latch verified' }), 200);
    s = expectStatus(await w.as.cxa.get(`/phases/${w.ids.phase}/activation`), 200);
    expect(gate(s, 'life_safety_items').status).toBe('pass');
    expect(gate(s, 'life_safety_issues').status).toBe('pass');
  });

  it('signs ready once every gate passes, then the owner records occupancy and the phase locks', async () => {
    expectStatus(await w.as.tab.post(`/rooms/${w.ids.or}/measurements`, GOOD_OR), 201);
    expectStatus(await w.as.tab.post(`/rooms/${w.ids.aiir}/measurements`, GOOD_AIIR), 201);
    let s = expectStatus(await w.as.cxa.get(`/phases/${w.ids.phase}/activation`), 200);
    expect(gate(s, 'rooms').status).toBe('pass');
    for (const i of s.items.filter((x: { status: string }) => x.status === 'open')) {
      expectStatus(await w.as.cxa.patch(`/activation-items/${i.id}`, i.required ? { status: 'done', evidence: `Evidence on file for ${i.key}` } : { status: 'na', evidence: 'Not used on this project' }), 200);
    }
    s = expectStatus(await w.as.cxa.get(`/phases/${w.ids.phase}/activation`), 200);
    expect(s.ready).toBe(true);

    // Occupancy needs the ready sign-off first, and only the owner records it.
    expect((await w.as.admin.post(`/phases/${w.ids.phase}/signoff`, { kind: 'occupied' }, { 'x-reauth-token': await reauth(w.as.admin) })).status).toBe(409);
    const ready = expectStatus(await w.as.cxa.post(`/phases/${w.ids.phase}/signoff`, { kind: 'ready' }, { 'x-reauth-token': await reauth(w.as.cxa) }), 201);
    expect(ready.signature).toMatchObject({ record_type: 'phase', signer_role: 'cxa', meaning: 'approved' });
    expect(ready.signoff.snapshot_sha256).toBe(ready.signature.record_sha256);
    expect((await w.as.cxa.post(`/phases/${w.ids.phase}/signoff`, { kind: 'occupied' }, { 'x-reauth-token': await reauth(w.as.cxa) })).status).toBe(403);
    const future = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    expect((await w.as.admin.post(`/phases/${w.ids.phase}/signoff`, { kind: 'occupied', occupiedOn: future }, { 'x-reauth-token': await reauth(w.as.admin) })).status).toBe(400);
    const occ = expectStatus(await w.as.admin.post(`/phases/${w.ids.phase}/signoff`, { kind: 'occupied' }, { 'x-reauth-token': await reauth(w.as.admin) }), 201);
    expect(occ.signature.signer_role).toBe('owner');

    const list = expectStatus(await w.as.clinical.get(`/projects/${w.ids.project}/activation`), 200);
    expect(list[0]).toMatchObject({ status: 'occupied', ready: true, occupiedOn: new Date().toISOString().slice(0, 10) });
    const item = s.items[0];
    expect((await w.as.cxa.patch(`/activation-items/${item.id}`, { status: 'open' })).status).toBe(423);
    expect((await w.as.cxa.post(`/phases/${w.ids.phase}/activation-items`, { label: 'Late item', category: 'it' })).status).toBe(423);
    expect((await w.as.admin.post(`/phases/${w.ids.phase}/signoff`, { kind: 'occupied' }, { 'x-reauth-token': await reauth(w.as.admin) })).status).toBe(409);
  });

  it('produces a branded activation report with the gates, checklist, sign-offs and footer', async () => {
    const res = await w.as.ahj.get(`/phases/${w.ids.phase}/activation/report`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Evidence gates/);
    expect(res.text).toMatch(/Activation checklist/);
    expect(res.text).toMatch(/Ready to occupy/);
    expect(res.text).toMatch(/Occupied on/);
    expect(res.text).toContain('Generated by OMOSHINE CX Planner – OMOSHINE LLC');
  });
});
