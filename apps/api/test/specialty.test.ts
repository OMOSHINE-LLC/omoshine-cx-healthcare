import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, expectStatus, type World } from './helpers.js';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

describe('specialty systems', () => {
  let tube: string;
  let nurseCall: string;

  it('publishes templates for each specialty type', async () => {
    const templates = expectStatus(await w.as.cxa.get('/templates'), 200) as { name: string; applies_to_system_type: string; published: boolean; item_count: number }[];
    for (const type of ['nurse_call', 'pneumatic_tube', 'rtls', 'imaging']) {
      const mine = templates.filter((t) => t.applies_to_system_type === type);
      expect(mine).toHaveLength(2);
      expect(mine.every((t) => t.published && t.item_count > 2)).toBe(true);
    }
    const cat = expectStatus(await w.as.clinical.get('/specialty/catalog'), 200);
    expect(cat.verified).toBe(false);
    expect(cat.systems.rtls.interfaces.map((i: { key: string }) => i.key)).toContain('door_locks');
  });

  it('adds specialty systems with the right discipline', async () => {
    expect((await w.as.clinical.post(`/projects/${w.ids.project}/specialty-systems`, { type: 'nurse_call', name: 'Nurse call 4 West' })).status).toBe(403);
    expect((await w.as.cxa.post(`/projects/${w.ids.project}/specialty-systems`, { type: 'elevator', name: 'Elevators' })).status).toBe(400);
    const nc = expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/specialty-systems`, { type: 'nurse_call', name: 'Nurse call 4 West' }), 201);
    expect(nc.discipline).toBe('communications');
    nurseCall = nc.id;
    expect((await w.as.cxa.post(`/projects/${w.ids.project}/specialty-systems`, { type: 'nurse_call', name: 'nurse call 4 west' })).status).toBe(409);
    tube = expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/specialty-systems`, { type: 'pneumatic_tube', name: 'Pneumatic tube' }), 201).id;
    const s = expectStatus(await w.as.ahj.get(`/projects/${w.ids.project}/specialty`), 200);
    expect(s.systems.map((x: { name: string }) => x.name)).toEqual(['Nurse call 4 West', 'Pneumatic tube']);
    expect(s.summary).toEqual({ systems: 2, interfaces: 8, passed: 0, failed: 0 });
    expect(s.systems[1].templates.map((t: { kind: string }) => t.kind)).toEqual(['fpt', 'pfc']);
    // Turnover and training pick up the new disciplines.
    const t = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/turnover`), 200);
    expect(t.systems.find((x: { id: string }) => x.id === tube).matrix.map((m: { kind: string }) => m.kind)).toContain('spare_parts');
  });

  it('records interface tests; a failed life safety interface opens a flagged issue', async () => {
    expect((await w.as.clinical.post(`/systems/${tube}/interface-tests`, { interfaceKey: 'ees', result: 'pass', evidenceReference: 'DMS://pts/ees' })).status).toBe(403);
    expect((await w.as.cxa.post(`/systems/${tube}/interface-tests`, { interfaceKey: 'nope', result: 'pass', evidenceReference: 'DMS://x' })).status).toBe(400);
    expect((await w.as.cxa.post(`/systems/${tube}/interface-tests`, { interfaceKey: 'ees', result: 'pass' })).status).toBe(400);
    expect((await w.as.cxa.post(`/systems/${w.ids.ahu}/interface-tests`, { interfaceKey: 'ees', result: 'pass', evidenceReference: 'DMS://x' })).status).toBe(400);
    expectStatus(await w.as.cxa.post(`/systems/${tube}/interface-tests`, { interfaceKey: 'ees', result: 'pass', evidenceReference: 'DMS://pts/ees' }), 201);
    expect((await w.as.gc.post(`/systems/${tube}/interface-tests`, { interfaceKey: 'fire_alarm', result: 'fail' })).status).toBe(400);
    const f = expectStatus(await w.as.gc.post(`/systems/${tube}/interface-tests`, { interfaceKey: 'fire_alarm', result: 'fail', notes: 'Blower kept running in zone 3 on alarm' }), 201);
    const issue = expectStatus(await w.as.cxa.get(`/issues/${f.issueId}`), 200);
    expect(issue.life_safety).toBe(true);
    expect(issue.system_id).toBe(tube);
    expect(issue.title).toBe('Pneumatic tube: Tube system responds to a fire alarm as designed failed');
    const nf = expectStatus(await w.as.cxa.post(`/systems/${nurseCall}/interface-tests`, { interfaceKey: 'phones', result: 'fail', notes: 'Escalation skipped tier 2' }), 201);
    expect(expectStatus(await w.as.cxa.get(`/issues/${nf.issueId}`), 200).life_safety).toBe(false);
  });

  it('a retest replaces the latest result and history is kept', async () => {
    expectStatus(await w.as.cxa.post(`/systems/${tube}/interface-tests`, { interfaceKey: 'fire_alarm', result: 'pass', evidenceReference: 'DMS://pts/fa-retest' }), 201);
    const s = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/specialty`), 200);
    const t = s.systems.find((x: { id: string }) => x.id === tube);
    expect(t.readiness).toEqual({ total: 3, passed: 2, failed: 0, untested: 1, ready: false });
    expect(expectStatus(await w.as.ahj.get(`/systems/${tube}/interface-tests`), 200)).toHaveLength(3);
  });

  it('shows in the survey binder with life safety gaps', async () => {
    const b = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/survey-binder`), 200);
    const sec = b.sections.find((s: { key: string }) => s.key === 'specialty');
    expect(sec.summary).toBe('2 systems, 2 of 8 interfaces passed');
    const texts = sec.gaps.map((g: { text: string }) => g.text);
    expect(texts).toContain('Nurse call 4 West: Calls reach assigned staff devices failed its interface test');
    expect(texts).toContain('Nurse call 4 West: Code calls annunciate unit-wide has not been tested');
    const html = await w.as.cxa.get(`/projects/${w.ids.project}/survey-binder/report`);
    expect(html.text).toMatch(/Specialty systems/);
  });
});
