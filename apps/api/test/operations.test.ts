import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, expectStatus, type World } from './helpers.js';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
type Task = { id: string; kind: string; status: string; nextDue: string; target_label: string | null; frequency: string; checks: { key: string }[] };

describe('compliance calendar', () => {
  let tasks: Task[];
  const byKind = (k: string) => tasks.find((t) => t.kind === k)!;

  it('generates the standard recurring tasks for the project', async () => {
    expect((await w.as.clinical.post(`/projects/${w.ids.project}/compliance/generate`, {})).status).toBe(403);
    const r = expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/compliance/generate`, { startOn: daysAgo(20) }), 200);
    // GEN-1 monthly + triennial, two ATS, egress x2, water x2, isolation room.
    expect(r.created).toBe(9);
    expect(expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/compliance/generate`, {}), 200).created).toBe(0);
    const c = expectStatus(await w.as.ahj.get(`/projects/${w.ids.project}/compliance`), 200);
    tasks = c.tasks;
    expect(c.verified).toBe(false);
    expect(c.summary.total).toBe(9);
    expect(byKind('gen_monthly').target_label).toBe('GEN-1');
    expect(byKind('gen_monthly').status).toBe('overdue');
    expect(byKind('gen_triennial').status).toBe('due');
    expect(byKind('water_flush').frequency).toBe('Weekly');
    expect(byKind('aiir_pressure_daily').target_label).toMatch(/ISO-12/);
  });

  it('records a passing completion and moves the next due date', async () => {
    const t = byKind('gen_monthly');
    expect((await w.as.cxa.post(`/compliance-tasks/${t.id}/completions`, { answers: { ran_30_min: true } })).status).toBe(400);
    expect((await w.as.ahj.post(`/compliance-tasks/${t.id}/completions`, { answers: { ran_30_min: true, load_or_exhaust_ok: true, no_alarms: true } })).status).toBe(403);
    expect((await w.as.cxa.post(`/compliance-tasks/${t.id}/completions`, { performedOn: '2999-01-01', answers: { ran_30_min: true, load_or_exhaust_ok: true, no_alarms: true } })).status).toBe(400);
    const r = expectStatus(await w.as.cxa.post(`/compliance-tasks/${t.id}/completions`, { performedOn: daysAgo(2), answers: { ran_30_min: true, load_or_exhaust_ok: true, no_alarms: true } }), 201);
    expect(r.result).toBe('pass');
    expect(r.issueId).toBeNull();
    expect(r.task.status).toBe('current');
    expect(r.task.nextDue > daysAgo(0)).toBe(true);
  });

  it('a failed check needs notes and opens a life safety issue', async () => {
    const t = byKind('ats_monthly');
    const answers = { transferred: true, within_10s: false };
    expect((await w.as.safety.post(`/compliance-tasks/${t.id}/completions`, { answers })).status).toBe(400);
    const r = expectStatus(await w.as.safety.post(`/compliance-tasks/${t.id}/completions`, { answers, notes: 'Life safety branch restored in 14 s' }), 201);
    expect(r.result).toBe('fail');
    expect(r.task.status).toBe('failed');
    const issue = expectStatus(await w.as.cxa.get(`/issues/${r.issueId}`), 200);
    expect(issue.life_safety).toBe(true);
    expect(issue.priority).toBe('high');
    expect(issue.title).toMatch(/Transfer switch monthly test \(ATS-/);
    const water = byKind('water_temp_monthly');
    const r2 = expectStatus(await w.as.cxa.post(`/compliance-tasks/${water.id}/completions`, { answers: { hot_in_range: false, cold_in_range: true }, notes: 'Sentinel 3 at 112 F' }), 201);
    expect(expectStatus(await w.as.cxa.get(`/issues/${r2.issueId}`), 200).life_safety).toBe(false);
    const detail = expectStatus(await w.as.cxa.get(`/compliance-tasks/${t.id}`), 200);
    expect(detail.completions).toHaveLength(1);
  });

  it('owners can tighten an interval, retire a task, and add a custom one', async () => {
    const t = byKind('water_flush');
    expect((await w.as.gc.patch(`/compliance-tasks/${t.id}`, { every: 3, unit: 'day' })).status).toBe(403);
    expect(expectStatus(await w.as.admin.patch(`/compliance-tasks/${t.id}`, { every: 3, unit: 'day' }), 200).frequency).toBe('Every 3 days');
    expectStatus(await w.as.admin.patch(`/compliance-tasks/${t.id}`, { active: false }), 200);
    expect((await w.as.cxa.post(`/compliance-tasks/${t.id}/completions`, { answers: { flushed: true } })).status).toBe(409);
    expect((await w.as.cxa.post(`/projects/${w.ids.project}/compliance-tasks`, { label: 'Kitchen hood check', category: 'other', targetType: 'room', every: 1, unit: 'month', checks: ['Hood clean'] })).status).toBe(400);
    const custom = expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/compliance-tasks`, { label: 'OR smoke purge check', category: 'ventilation', targetType: 'room', targetId: w.ids.or, every: 6, unit: 'month', checks: ['Purge mode starts', 'Room returns to setpoint'] }), 201);
    expect(custom.kind).toBe('custom_1');
    expect(custom.checks.map((c: { key: string }) => c.key)).toEqual(['c1', 'c2']);
    const c = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/compliance`), 200);
    expect(c.summary.total).toBe(9);
  });

  it('shows a calendar of tasks and life safety inspections', async () => {
    const from = daysAgo(0);
    const to = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    const cal = expectStatus(await w.as.clinical.get(`/projects/${w.ids.project}/compliance/calendar?from=${from}&to=${to}`), 200);
    const iso = cal.events.filter((e: { label: string }) => e.label.startsWith('Isolation room'));
    expect(iso.length).toBe(15);
    expect(cal.events.find((e: { status: string; label: string }) => e.status === 'failed' && e.label.startsWith('Transfer switch')).date).toBe(from);
    expect((await w.as.cxa.get(`/projects/${w.ids.project}/compliance/calendar?from=2026-01-01&to=2028-01-01`)).status).toBe(400);
  });
});

describe('owner training', () => {
  let sessionId: string;

  it('builds a training matrix from the systems', async () => {
    const t = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/training`), 200);
    const ahu = t.matrix.find((m: { id: string }) => m.id === w.ids.ahu);
    expect(ahu.audiences.map((a: { audience: string }) => a.audience)).toEqual(['facilities', 'infection_prevention']);
    expect(t.summary.trained).toBe(0);
  });

  it('schedules, records attendance and closes a session', async () => {
    const body = { systemId: w.ids.ahu, topic: 'AHU-1 operation and filter changes', audiences: ['facilities', 'infection_prevention'], trainer: 'Acme Mechanical', scheduledAt: new Date().toISOString(), durationMin: 90 };
    expect((await w.as.clinical.post(`/projects/${w.ids.project}/training-sessions`, body)).status).toBe(403);
    sessionId = expectStatus(await w.as.gc.post(`/projects/${w.ids.project}/training-sessions`, body), 201).id;
    let t = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/training`), 200);
    expect(t.matrix.find((m: { id: string }) => m.id === w.ids.ahu).audiences.every((a: { status: string }) => a.status === 'scheduled')).toBe(true);
    expect((await w.as.cxa.post(`/training-sessions/${sessionId}/close`, { outcome: 'held', materialsReference: 'DMS://training/ahu1' })).status).toBe(409);
    const a = expectStatus(await w.as.cxa.post(`/training-sessions/${sessionId}/attendance`, { attendees: [{ name: 'J. Rivera', audience: 'facilities' }, { name: 'J. Rivera', audience: 'facilities' }] }), 201);
    expect(a).toEqual({ added: 1, skipped: 1 });
    expect((await w.as.cxa.post(`/training-sessions/${sessionId}/close`, { outcome: 'held' })).status).toBe(400);
    expect(expectStatus(await w.as.cxa.post(`/training-sessions/${sessionId}/close`, { outcome: 'held', materialsReference: 'DMS://training/ahu1' }), 200).status).toBe('held');
    expect((await w.as.cxa.post(`/training-sessions/${sessionId}/attendance`, { attendees: [{ name: 'Late Person', audience: 'facilities' }] })).status).toBe(409);
    t = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/training`), 200);
    const cells = t.matrix.find((m: { id: string }) => m.id === w.ids.ahu).audiences;
    expect(cells.find((c: { audience: string }) => c.audience === 'facilities').status).toBe('trained');
    expect(cells.find((c: { audience: string }) => c.audience === 'infection_prevention').status).toBe('needed');
    expect(expectStatus(await w.as.ahj.get(`/training-sessions/${sessionId}`), 200).attendees).toHaveLength(1);
  });

  it('produces a training record report with the footer', async () => {
    const r = await w.as.ahj.get(`/projects/${w.ids.project}/training/report`);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/AHU-1 operation and filter changes/);
    expect(r.text).toMatch(/Generated by OMOSHINE CX Planner – OMOSHINE LLC/);
  });
});

describe('CMMS exports', () => {
  it('exports assets with warranty end dates', async () => {
    const start = daysAgo(10);
    const wid = expectStatus(await w.as.gc.post(`/systems/${w.ids.eesLs}/turnover-documents`, { kind: 'warranty', title: 'GEN-1 warranty', reference: 'DMS://w-gen', assetId: w.ids.gen, warrantyStart: start, warrantyMonths: 24 }), 201).id;
    expectStatus(await w.as.cxa.post(`/turnover-documents/${wid}/review`, { decision: 'accepted' }), 200);
    const r = await w.as.ahj.get(`/projects/${w.ids.project}/exports/cmms/assets.csv`);
    expect(r.status).toBe(200);
    const lines = r.text.trim().split(/\r?\n/);
    expect(lines[0]).toBe('AssetTag,AssetType,System,Discipline,Room,Manufacturer,Model,Serial,QRCode,WarrantyStart,WarrantyEnd');
    const gen = lines.find((l: string) => l.startsWith('GEN-1,'))!;
    expect(gen).toContain(start);
    expect(gen.split(',').pop()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('exports a PM schedule from the calendar', async () => {
    const r = await w.as.cxa.get(`/projects/${w.ids.project}/exports/cmms/pm-schedule.csv`);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/GEN-1,asset,Generator monthly load test,ees,Monthly/);
    expect(r.text).not.toMatch(/Flush low-use water outlets/);
    expect((await w.as.cxa.get(`/projects/${w.ids.project}/exports/cmms/other.csv`)).status).toBe(400);
  });
});
