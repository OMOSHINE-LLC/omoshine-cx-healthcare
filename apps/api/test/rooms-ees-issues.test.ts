import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/routes/rooms.js';
import { nextMonthlyDue } from '../src/routes/ees.js';
import { createWorld, expectStatus, type World } from './helpers.js';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

const GOOD_OR = { supplyCfm: 2000, oaCfm: 400, pressureDiffInWc: 0.01, tempF: 68, rhPct: 45, recircRoomUnits: false };

describe('ASHRAE 170 room compliance', () => {
  it('evaluates a compliant OR and stores the result with code citations', async () => {
    const r = expectStatus(await w.as.tab.post(`/rooms/${w.ids.or}/measurements`, { source: 'tab', ...GOOD_OR }), 201);
    expect(r.evaluation.overall).toBe('pass');
    expect(r.evaluation.computed.totalAch).toBe(24);
    const sheet = expectStatus(await w.as.cxa.get(`/rooms/${w.ids.or}/data-sheet`), 200);
    expect(sheet.overall).toBe('pass');
    expect(sheet.spaceType.id).toBe('or_class_bc');
    expect(sheet.requirements.find((q: { parameter: string }) => q.parameter === 'total_ach').citation).toBe('ASHRAE 170-2021 Table 7-1');
    expect(sheet.room.state_code).toBe('CA');
  });

  it('flags failures and keeps history; the latest reading drives status', async () => {
    const r = expectStatus(await w.as.tab.post(`/rooms/${w.ids.or}/measurements`, { ...GOOD_OR, supplyCfm: 1500, rhPct: 63 }), 201);
    expect(r.evaluation.overall).toBe('fail');
    const failed = r.evaluation.results.filter((x: { status: string }) => x.status === 'fail').map((x: { parameter: string }) => x.parameter).sort();
    expect(failed).toEqual(['rh_pct', 'total_ach']);
    const sheet = expectStatus(await w.as.cxa.get(`/rooms/${w.ids.or}/data-sheet`), 200);
    expect(sheet.overall).toBe('fail');
    expect(sheet.history.length).toBe(2);
  });

  it('marks a positive isolation room as a life safety failure', async () => {
    const r = expectStatus(await w.as.tab.post(`/rooms/${w.ids.aiir}/measurements`, {
      supplyCfm: 260, exhaustCfm: 360, oaCfm: 60, pressureDiffInWc: 0.01, allExhaust: true, recircRoomUnits: false, tempF: 72, rhPct: 40,
    }), 201);
    expect(r.evaluation.lifeSafetyFailure).toBe(true);
  });

  it('validates measurement input', async () => {
    expect((await w.as.tab.post(`/rooms/${w.ids.or}/measurements`, { rhPct: 140 })).status).toBe(400);
  });

  it('shows the compliance grid and filters by status', async () => {
    const all = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/room-compliance`), 200);
    expect(all).toHaveLength(2);
    const failing = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/room-compliance?status=fail`), 200);
    expect(failing.map((r: { number: string }) => r.number).sort()).toEqual(['ISO-12', 'OR-04']);
    expect(failing.find((r: { number: string }) => r.number === 'OR-04').parameters.total_ach.status).toBe('fail');
  });

  it('a project/AHJ overlay changes the evaluation and is audited', async () => {
    expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/overlays`, {
      action: 'replace', requirementKey: 'ashrae170.or_class_bc.total_ach', requirement: { valueMin: 25 },
      effectiveDate: '2026-01-01', sourceNote: 'AHJ letter dated 2026-01-15 requires 25 ACH for hybrid ORs (example)',
    }), 201);
    const r = expectStatus(await w.as.tab.post(`/rooms/${w.ids.or}/measurements`, GOOD_OR), 201);
    expect(r.evaluation.overall).toBe('fail');
    expect(r.evaluation.results.find((x: { parameter: string }) => x.parameter === 'total_ach').required).toBe('≥ 25 ACH');
    const sheet = expectStatus(await w.as.cxa.get(`/rooms/${w.ids.or}/data-sheet`), 200);
    expect(sheet.requirements.find((q: { parameter: string }) => q.parameter === 'total_ach').required).toBe('≥ 25 ACH');
  });
});

describe('TAB report import', () => {
  it('parses quoted CSV fields', () => {
    expect(parseCsv('a,b\n"x, y","He said ""hi"""\r\n')).toEqual([{ a: 'x, y', b: 'He said "hi"' }]);
  });

  it('rejects the whole file when any row is invalid, writing nothing', async () => {
    const before = expectStatus(await w.as.cxa.get(`/rooms/${w.ids.aiir}/data-sheet`), 200).history.length;
    const csv = 'room_number,supply_cfm,exhaust_cfm,oa_cfm,pressure_in_wc,temp_f,rh_pct\nISO-12,260,360,60,-0.02,72,40\nNOPE-1,100,100,10,0,70,40\n';
    const r = await w.as.tab.post(`/projects/${w.ids.project}/imports/tab`, { csv });
    expect(r.status).toBe(422);
    expect(r.body.errors[0]).toMatchObject({ row: 3 });
    expect(expectStatus(await w.as.cxa.get(`/rooms/${w.ids.aiir}/data-sheet`), 200).history.length).toBe(before);
  });

  it('imports valid rows and evaluates each room', async () => {
    const csv = [
      'Room_Number,Supply_CFM,Exhaust_CFM,OA_CFM,Pressure_In_WC,Temp_F,RH_Pct,All_Exhaust,Recirc_Room_Units,Measured_At',
      'ISO-12,260,360,60,-0.02,72,40,yes,no,2026-10-30T14:00:00Z',
      'OR-04,2600,,500,0.012,67,45,,no,2026-10-30T15:00:00Z',
    ].join('\n');
    const r = expectStatus(await w.as.tab.post(`/projects/${w.ids.project}/imports/tab`, { csv }), 201);
    expect(r.imported).toBe(2);
    const byRoom = Object.fromEntries(r.results.map((x: { roomNumber: string; overall: string }) => [x.roomNumber, x.overall]));
    expect(byRoom['ISO-12']).toBe('pass');
    // OR at 67 °F is below the 68 °F minimum.
    expect(byRoom['OR-04']).toBe('fail');
  });
});

describe('Essential electrical system', () => {
  it('passes an ATS transfer within 10 seconds', async () => {
    const r = expectStatus(await w.as.cxa.post(`/assets/${w.ids.atsLs}/ats-tests`, { transferTimeS: 8.4 }), 201);
    expect(r.evaluation.overall).toBe('pass');
  });

  it('fails a slow critical-branch transfer as life safety', async () => {
    const r = expectStatus(await w.as.cxa.post(`/assets/${w.ids.atsCrit}/ats-tests`, { transferTimeS: 11.2 }), 201);
    expect(r.evaluation.overall).toBe('fail');
    expect(r.evaluation.lifeSafetyFailure).toBe(true);
    expect(r.evaluation.results[0].citation).toMatch(/NFPA 110/);
  });

  it('refuses ATS readings on a non-ATS asset and checks permissions', async () => {
    expect((await w.as.cxa.post(`/assets/${w.ids.gen}/ats-tests`, { transferTimeS: 5 })).status).toBe(400);
    expect((await w.as.gc.post(`/assets/${w.ids.atsLs}/ats-tests`, { transferTimeS: 5 })).status).toBe(403);
  });

  it('evaluates generator monthly tests, including the exhaust-temperature alternative', async () => {
    const r = expectStatus(await w.as.cxa.post(`/assets/${w.ids.gen}/generator-tests`, { testType: 'monthly', durationMin: 30, loadPct: 22, exhaustTempF: 700, performedAt: '2026-10-15T10:00:00Z' }), 201);
    expect(r.evaluation.overall).toBe('pass');
  });

  it('summarises readiness by branch on the EES dashboard', async () => {
    const s = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/ees/summary`), 200);
    const ls = s.branches.find((b: { branch: string }) => b.branch === 'life_safety');
    const crit = s.branches.find((b: { branch: string }) => b.branch === 'critical');
    expect(ls).toMatchObject({ atsCount: 1, passed: 1, percentPassed: 100, lifeSafetyFailure: false });
    expect(crit).toMatchObject({ atsCount: 1, failed: 1, lifeSafetyFailure: true });
    expect(s.generators[0]).toMatchObject({ tag: 'GEN-1', result: 'pass', nextMonthlyDue: '2026-11-15' });
  });

  it('computes the next monthly due date', () => {
    expect(nextMonthlyDue(new Date('2026-01-31T00:00:00Z'))).toBe('2026-03-03');
    expect(nextMonthlyDue(null)).toBeNull();
  });
});

describe('Issues with ball-in-court', () => {
  let issueId: string;

  it('creates numbered issues linked to a room and requirement', async () => {
    const a = expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/issues`, {
      title: 'OR-04 total ACH below requirement', roomId: w.ids.or, requirementKey: 'ashrae170.or_class_bc.total_ach', ballInCourtOrgId: w.tenant.orgs.tab,
    }), 201);
    const b = expectStatus(await w.as.clinical.post(`/projects/${w.ids.project}/issues`, { title: 'Door to ISO-12 does not self-close', roomId: w.ids.aiir, lifeSafety: true }), 201);
    expect(b.number).toBe(a.number + 1);
    expect(b.priority).toBe('critical');
    issueId = a.id;
  });

  it('numbers issues without gaps under concurrency', async () => {
    const created = await Promise.all(
      Array.from({ length: 5 }, (_, i) => w.as.cxa.post(`/projects/${w.ids.project}/issues`, { title: `Concurrent issue ${i}` })),
    );
    const nums = created.map((r) => expectStatus(r, 201).number).sort((x: number, y: number) => x - y);
    expect(new Set(nums).size).toBe(5);
    expect(nums.at(-1)! - nums[0]!).toBe(4);
  });

  it('tracks ball-in-court changes and status history', async () => {
    expectStatus(await w.as.tab.patch(`/issues/${issueId}`, { status: 'in_progress' }), 200);
    expectStatus(await w.as.cxa.patch(`/issues/${issueId}`, { ballInCourtOrgId: w.tenant.orgs.gc, status: 'ready_for_review' }), 200);
    expectStatus(await w.as.gc.post(`/issues/${issueId}/comments`, { text: 'Supply fan sheave adjusted; ready for re-measure.' }), 201);
    const d = expectStatus(await w.as.cxa.get(`/issues/${issueId}`), 200);
    expect(d.ball_in_court_name).toBe('Summit Builders');
    expect(d.events.map((e: { kind: string }) => e.kind)).toEqual(['created', 'status_change', 'status_change', 'reassigned', 'comment']);
  });

  it('filters by ball in court and life safety', async () => {
    const gc = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/issues?ballInCourt=${w.tenant.orgs.gc}`), 200);
    expect(gc.map((i: { id: string }) => i.id)).toEqual([issueId]);
    const ls = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/issues?lifeSafety=true`), 200);
    expect(ls).toHaveLength(1);
  });

  it('only the CxA, owner or safety officer may close a life safety issue', async () => {
    const ls = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/issues?lifeSafety=true`), 200)[0];
    expect((await w.as.gc.patch(`/issues/${ls.id}`, { status: 'closed' })).status).toBe(403);
    const closed = expectStatus(await w.as.cxa.patch(`/issues/${ls.id}`, { status: 'closed' }), 200);
    expect(closed.closed_at).not.toBeNull();
  });

  it('rejects a room from a different project', async () => {
    const otherProject = expectStatus(await w.as.admin.post('/projects', { name: 'Other', facilityName: 'Other', stateCode: 'NY' }), 201);
    expect((await w.as.admin.post(`/projects/${otherProject.id}/issues`, { title: 'Wrong room', roomId: w.ids.or })).status).toBe(400);
  });
});

describe('Readiness, QR and reports', () => {
  it('rolls up tests, issues and rooms by phase', async () => {
    const r = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/readiness`), 200);
    expect(r.issues.open).toBeGreaterThan(0);
    expect(r.roomsByPhase[0].phase).toBe('Phase 1 – Surgery');
    expect(r.roomsByPhase[0].pass + r.roomsByPhase[0].fail).toBe(2);
  });

  it('resolves QR tags to rooms and assets', async () => {
    const tree = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/tree`), 200);
    const room = tree.rooms.find((r: { id: string }) => r.id === w.ids.or);
    expect(expectStatus(await w.as.cxa.get(`/qr/${room.qr_code}`), 200)).toMatchObject({ type: 'room', id: w.ids.or });
    const asset = tree.assets.find((a: { id: string }) => a.id === w.ids.gen);
    expect(expectStatus(await w.as.cxa.get(`/qr/${asset.qr_code}`), 200)).toMatchObject({ type: 'asset', tag: 'GEN-1' });
    expect((await w.as.outsider.get(`/qr/${room.qr_code}`)).status).toBe(403);
  });

  it('renders a branded room report with the required footer', async () => {
    const r = await w.as.cxa.get(`/rooms/${w.ids.or}/report`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('Generated by OMOSHINE CX Planner – OMOSHINE LLC');
    expect(r.text).toContain('/brand/logo.png');
    expect(r.text).toContain('#072740');
    expect(r.text).toContain('ASHRAE 170-2021 Table 7-1');
  });

  it('escapes user-entered text in reports', async () => {
    const room = expectStatus(await w.as.cxa.post(`/departments/${w.ids.dept}/rooms`, { number: 'OR-<b>5</b>', name: '<script>x</script>', spaceTypeId: 'or_class_bc', volumeCuft: 5000 }), 201);
    const r = await w.as.cxa.get(`/rooms/${room.id}/report`);
    expect(r.text).not.toContain('<script>x</script>');
    expect(r.text).toContain('&lt;script&gt;');
  });

  it('exposes the code library with state profiles', async () => {
    const states = expectStatus(await w.as.cxa.get('/states'), 200);
    expect(states.map((s: { stateCode: string }) => s.stateCode)).toEqual(['CA', 'NY', 'FL', 'TX']);
    const reqs = expectStatus(await w.as.cxa.get('/space-types/aiir/requirements?state=TX'), 200);
    expect(reqs.find((r: { parameter: string }) => r.parameter === 'pressure_relationship').severity).toBe('life_safety');
  });
});
