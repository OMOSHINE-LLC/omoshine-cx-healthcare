import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_ILSM_POLICY, DEFICIENCY_TYPES, MED_GASES, findSpaceType, fireWatchGaps, type DeficiencyType, type MedGas } from '@omoshine/rules';
import { appendAudit, verifyAuditChain } from '../audit.js';
import type { Db, Tx } from '../db.js';
import { isTenantAdmin, requirePermission, tenantTx } from '../http.js';
import { approvalOf } from './icra.js';
import { zoneState } from './medgas.js';
import { reportShell } from './reports.js';

const uuid = z.string().uuid();
const ICRA_LOOKBACK_DAYS = 30;

/**
 * Survey binder: one place that gathers the evidence a surveyor or AHJ asks for
 * (signed tests, room compliance, essential electrical, ICRA, ILSM, medical gas,
 * open life safety items and record integrity), with a list of gaps to close
 * before the survey. It reads existing records only; nothing here changes them.
 */
export type SectionStatus = 'ready' | 'attention' | 'no_records';
export interface Gap { severity: 'life_safety' | 'regulatory'; text: string }
export interface BinderSection<T = unknown> { key: string; title: string; status: SectionStatus; summary: string; gaps: Gap[]; records: T[] }

const sectionStatus = (records: unknown[], gaps: Gap[]): SectionStatus => (gaps.length ? 'attention' : records.length ? 'ready' : 'no_records');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function buildBinder(tx: Tx, projectId: string, tenantId: string, includeAuditCheck: boolean) {
  const project = (await tx.query(`SELECT id, name, facility_name, state_code, accreditor, project_type, adopted_codes FROM project WHERE id = $1`, [projectId])).rows[0];
  const sections: BinderSection[] = [];

  // 1. Room compliance (ASHRAE 170) -----------------------------------------------------
  const rooms = (await tx.query<{ id: string; number: string; name: string; space_type_id: string; department: string; overall: string | null; life_safety_failure: boolean | null; measured_at: Date | null }>(
    `SELECT rm.id, rm.number, rm.name, rm.space_type_id, d.name AS department, latest.overall, latest.life_safety_failure, latest.measured_at
       FROM room rm JOIN department d ON d.id = rm.department_id JOIN floor f ON f.id = d.floor_id JOIN building b ON b.id = f.building_id
       LEFT JOIN LATERAL (SELECT overall, life_safety_failure, measured_at FROM room_measurement m WHERE m.room_id = rm.id ORDER BY measured_at DESC, recorded_at DESC LIMIT 1) latest ON true
      WHERE b.project_id = $1 ORDER BY rm.number`, [projectId])).rows;
  {
    const gaps: Gap[] = [];
    for (const r of rooms) {
      if (!r.overall) gaps.push({ severity: 'regulatory', text: `${r.number} has no ventilation measurements` });
      else if (r.overall === 'fail') gaps.push({ severity: r.life_safety_failure ? 'life_safety' : 'regulatory', text: `${r.number} ${r.name} does not meet its ventilation requirements` });
      else if (r.overall === 'incomplete') gaps.push({ severity: 'regulatory', text: `${r.number} measurements are incomplete` });
    }
    const pass = rooms.filter((r) => r.overall === 'pass').length;
    sections.push({
      key: 'rooms', title: 'Room ventilation compliance (ASHRAE 170)', status: sectionStatus(rooms, gaps), gaps,
      summary: `${pass} of ${plural(rooms.length, 'room')} pass on their latest measurement`,
      records: rooms.map((r) => ({ number: r.number, name: r.name, spaceType: findSpaceType(r.space_type_id)?.name ?? r.space_type_id, department: r.department, result: r.overall ?? 'not_tested', measuredAt: r.measured_at })),
    });
  }

  // 2. Checklists and functional tests -------------------------------------------------
  const runs = (await tx.query<{ id: string; template: string; kind: string; target: string; status: string; result: string | null; submitted_at: Date | null; signers: string | null }>(
    `SELECT t.id, tp.name AS template, tp.kind, t.status, t.result, t.submitted_at,
            COALESCE(rm.number, a.tag, s.name) AS target,
            (SELECT string_agg(sg.signer_name || ' (' || sg.meaning || ')', ', ' ORDER BY sg.signed_at) FROM signature sg WHERE sg.record_type = 'test_run' AND sg.record_id = t.id) AS signers
       FROM test_run t JOIN template tp ON tp.id = t.template_id
       LEFT JOIN room rm ON t.target_type = 'room' AND rm.id = t.target_id
       LEFT JOIN asset a ON t.target_type = 'asset' AND a.id = t.target_id
       LEFT JOIN system s ON t.target_type = 'system' AND s.id = t.target_id
      WHERE t.project_id = $1 AND t.status <> 'superseded' ORDER BY tp.name, target`, [projectId])).rows;
  {
    const gaps: Gap[] = [];
    for (const r of runs) {
      if (r.result === 'fail') gaps.push({ severity: 'regulatory', text: `${r.template} on ${r.target} failed and has no passing retest` });
      else if (r.status !== 'signed') gaps.push({ severity: 'regulatory', text: `${r.template} on ${r.target} is ${r.status === 'submitted' ? 'awaiting signatures' : 'still in progress'}` });
    }
    const signed = runs.filter((r) => r.status === 'signed').length;
    sections.push({
      key: 'tests', title: 'Checklists and functional tests', status: sectionStatus(runs, gaps), gaps,
      summary: `${signed} of ${plural(runs.length, 'test')} signed`,
      records: runs.map((r) => ({ template: r.template, target: r.target, status: r.status, result: r.result ?? 'not_tested', signedBy: r.signers })),
    });
  }

  // 3. Essential electrical system ----------------------------------------------------
  const ees = (await tx.query<{ tag: string; asset_type: string; branch: string | null; test_type: string | null; overall: string | null; performed_at: Date | null; life_safety_failure: boolean | null }>(
    `SELECT a.tag, a.asset_type, a.attributes->>'branch' AS branch, latest.test_type, latest.overall, latest.performed_at, latest.life_safety_failure
       FROM asset a JOIN system s ON s.id = a.system_id
       LEFT JOIN LATERAL (SELECT test_type, overall, performed_at, life_safety_failure FROM ees_test e WHERE e.asset_id = a.id ORDER BY performed_at DESC, recorded_at DESC LIMIT 1) latest ON true
      WHERE s.project_id = $1 AND a.asset_type IN ('ats','generator') ORDER BY a.asset_type, a.tag`, [projectId])).rows;
  {
    const gaps: Gap[] = [];
    for (const a of ees) {
      const essential = a.asset_type === 'generator' || a.branch === 'life_safety' || a.branch === 'critical';
      if (!a.overall) gaps.push({ severity: essential ? 'life_safety' : 'regulatory', text: `${a.tag} has no recorded ${a.asset_type === 'ats' ? 'transfer' : 'load'} test` });
      else if (a.overall !== 'pass') gaps.push({ severity: a.life_safety_failure || a.branch === 'life_safety' || a.branch === 'critical' ? 'life_safety' : 'regulatory', text: `${a.tag} latest test ${a.overall === 'fail' ? 'failed' : 'is incomplete'}` });
    }
    sections.push({
      key: 'ees', title: 'Essential electrical system (NFPA 99 / NFPA 110)', status: sectionStatus(ees, gaps), gaps,
      summary: `${ees.filter((a) => a.overall === 'pass').length} of ${plural(ees.length, 'transfer switch and generator', 'transfer switches and generators')} pass on their latest test`,
      records: ees.map((a) => ({ tag: a.tag, type: a.asset_type, branch: a.branch, result: a.overall ?? 'not_tested', testedAt: a.performed_at })),
    });
  }

  // 4. Infection control (ICRA) --------------------------------------------------------
  const zones = (await tx.query(`SELECT * FROM icra_zone WHERE project_id = $1 ORDER BY active DESC, name`, [projectId])).rows;
  {
    const gaps: Gap[] = [];
    const records = [];
    for (const z of zones) {
      const approval = await approvalOf(tx, z);
      const stats = (await tx.query<{ fails: string; days: string }>(
        `SELECT count(*) FILTER (WHERE overall = 'fail') AS fails,
                count(DISTINCT (logged_at AT TIME ZONE 'UTC')::date) AS days
           FROM icra_log WHERE zone_id = $1 AND logged_at >= now() - make_interval(days => $2)`, [z.id, ICRA_LOOKBACK_DAYS])).rows[0]!;
      const since = Math.max(z.created_at.getTime(), Date.now() - ICRA_LOOKBACK_DAYS * 864e5);
      const expectedDays = Math.min(ICRA_LOOKBACK_DAYS, Math.floor((Date.now() - since) / 864e5) + 1);
      const missing = z.active ? Math.max(0, expectedDays - Number(stats.days)) : 0;
      if (z.active && approval.status !== 'approved') gaps.push({ severity: 'regulatory', text: `ICRA zone ${z.name} (Class ${z.icra_class}) ${approval.status === 'pending' ? 'has no Infection Prevention approval' : 'changed after approval and needs re-approval'}` });
      if (missing > 0) gaps.push({ severity: 'regulatory', text: `ICRA zone ${z.name} is missing ${plural(missing, 'daily log')} in the last ${ICRA_LOOKBACK_DAYS} days` });
      records.push({ name: z.name, icraClass: z.icra_class, active: z.active, approval: approval.status, approvedBy: approval.by, failedLogs: Number(stats.fails), daysLogged: Number(stats.days), daysMissing: missing });
    }
    sections.push({
      key: 'icra', title: 'Infection control risk assessment (ICRA)', status: sectionStatus(records, gaps), gaps,
      summary: `${plural(zones.filter((z) => z.active).length, 'active zone')}, ${plural(zones.filter((z) => !z.active).length, 'closed zone')}`,
      records,
    });
  }

  // 5. Interim life safety measures -----------------------------------------------------
  const assessments = (await tx.query(`SELECT * FROM ilsm_assessment WHERE project_id = $1 ORDER BY status, identified_at DESC`, [projectId])).rows;
  {
    const gaps: Gap[] = [];
    const records = [];
    for (const a of assessments) {
      const required = a.required_measures as string[];
      const implemented = a.implemented_measures as string[];
      const missing = required.filter((m) => !implemented.includes(m));
      const fireWatch = required.includes('fire_watch');
      const patrols = fireWatch
        ? (await tx.query<{ patrolled_at: Date }>('SELECT patrolled_at FROM fire_watch_log WHERE assessment_id = $1 ORDER BY patrolled_at', [a.id])).rows.map((r) => r.patrolled_at.toISOString())
        : [];
      const end = a.status === 'resolved' && a.resolved_at ? a.resolved_at : new Date();
      const watchGaps = fireWatch ? fireWatchGaps(a.identified_at.toISOString(), patrols, end.toISOString()) : [];
      const label = DEFICIENCY_TYPES[a.deficiency_type as DeficiencyType] ?? a.deficiency_type;
      if (a.status === 'open' && missing.length) gaps.push({ severity: 'life_safety', text: `${label} at ${a.location}: ${plural(missing.length, 'required measure')} not documented` });
      if (watchGaps.length) gaps.push({ severity: 'life_safety', text: `${label} at ${a.location}: ${plural(watchGaps.length, 'fire watch gap')} over ${DEFAULT_ILSM_POLICY.patrolIntervalMin} min (longest ${Math.max(...watchGaps.map((g) => g.minutes))} min)` });
      records.push({ deficiency: label, location: a.location, status: a.status, identifiedAt: a.identified_at, resolvedAt: a.resolved_at, measuresDocumented: `${required.length - missing.length}/${required.length}`, patrols: patrols.length, fireWatchGaps: watchGaps.length });
    }
    sections.push({
      key: 'ilsm', title: 'Interim life safety measures (ILSM) and fire watch', status: sectionStatus(records, gaps), gaps,
      summary: `${plural(assessments.filter((a) => a.status === 'open').length, 'open assessment')}, ${assessments.filter((a) => a.status === 'resolved').length} resolved`,
      records,
    });
  }

  // 6. Medical gas -------------------------------------------------------------------
  const mgZones = (await tx.query(`SELECT * FROM medgas_zone WHERE project_id = $1 ORDER BY name`, [projectId])).rows;
  {
    const gaps: Gap[] = [];
    const records = [];
    for (const z of mgZones) {
      const s = await zoneState(tx, z);
      if (s.summary.failed) gaps.push({ severity: 'life_safety', text: `Medical gas zone ${z.name}: ${plural(s.summary.failed, 'failed verification test')}` });
      if (s.certification.status !== 'certified') {
        gaps.push({ severity: 'life_safety', text: `Medical gas zone ${z.name} is ${s.certification.status === 'recertification_required' ? 'awaiting recertification' : 'not certified'} (${s.summary.passed}/${s.summary.required} tests passed)` });
      }
      records.push({ name: z.name, valveTag: z.zone_valve_tag, gases: (z.gases as MedGas[]).map((g) => MED_GASES[g]?.label ?? g).join(', '), outlets: s.outlets.length, passed: s.summary.passed, required: s.summary.required, certification: s.certification.status, certifiedBy: s.certification.by, certifiedAt: s.certification.at });
    }
    sections.push({
      key: 'medgas', title: 'Medical gas and vacuum verification (NFPA 99)', status: sectionStatus(records, gaps), gaps,
      summary: `${mgZones.length ? `${records.filter((r) => r.certification === 'certified').length} of ${plural(mgZones.length, 'zone')} certified` : 'No zones'}`,
      records,
    });
  }

  // 7. Open issues ------------------------------------------------------------------
  const issues = (await tx.query<{ number: number; title: string; priority: string; life_safety: boolean; status: string; created_at: Date; org: string | null }>(
    `SELECT i.number, i.title, i.priority, i.life_safety, i.status, i.created_at, o.name AS org
       FROM issue i LEFT JOIN organization o ON o.id = i.ball_in_court_org_id
      WHERE i.project_id = $1 AND i.status <> 'closed' ORDER BY i.life_safety DESC, i.priority = 'critical' DESC, i.number`, [projectId])).rows;
  {
    const gaps: Gap[] = issues.filter((i) => i.life_safety || i.priority === 'critical')
      .map((i) => ({ severity: i.life_safety ? 'life_safety' as const : 'regulatory' as const, text: `Issue #${i.number} open: ${i.title}` }));
    sections.push({
      key: 'issues', title: 'Open issues', status: gaps.length ? 'attention' : 'ready', gaps,
      summary: `${plural(issues.length, 'open issue')}, ${issues.filter((i) => i.life_safety).length} life safety`,
      records: issues.map((i) => ({ number: i.number, title: i.title, priority: i.priority, lifeSafety: i.life_safety, status: i.status, ballInCourt: i.org, opened: i.created_at })),
    });
  }

  // 8. Record integrity --------------------------------------------------------------
  const sigCount = Number((await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM signature s WHERE
       (s.record_type = 'test_run' AND s.record_id IN (SELECT id FROM test_run WHERE project_id = $1)) OR
       (s.record_type = 'icra_zone' AND s.record_id IN (SELECT id FROM icra_zone WHERE project_id = $1)) OR
       (s.record_type = 'medgas_zone' AND s.record_id IN (SELECT id FROM medgas_zone WHERE project_id = $1))`, [projectId])).rows[0]!.n);
  const chain = includeAuditCheck ? await verifyAuditChain(tx, tenantId) : null;
  sections.push({
    key: 'integrity', title: 'Record integrity', status: chain && !chain.ok ? 'attention' : 'ready',
    gaps: chain && !chain.ok ? [{ severity: 'regulatory', text: `Audit trail hash chain is broken at entry ${chain.brokenAt}` }] : [],
    summary: `${plural(sigCount, 'electronic signature')} with re-authentication${chain ? `; audit trail of ${chain.entries} entries ${chain.ok ? 'verified intact' : 'FAILED verification'}` : ''}`,
    records: [],
  });

  const allGaps = sections.flatMap((s) => s.gaps.map((g) => ({ ...g, section: s.title })));
  return {
    project,
    generatedAt: new Date().toISOString(),
    sections,
    gaps: [...allGaps.filter((g) => g.severity === 'life_safety'), ...allGaps.filter((g) => g.severity !== 'life_safety')],
    summary: {
      ready: sections.filter((s) => s.status === 'ready').length,
      attention: sections.filter((s) => s.status === 'attention').length,
      noRecords: sections.filter((s) => s.status === 'no_records').length,
      lifeSafetyGaps: allGaps.filter((g) => g.severity === 'life_safety').length,
      otherGaps: allGaps.filter((g) => g.severity !== 'life_safety').length,
    },
  };
}

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const STATUS_LABEL: Record<SectionStatus, string> = { ready: 'Ready', attention: 'Needs attention', no_records: 'No records' };
const STATUS_STYLE: Record<string, string> = {
  ready: 'background:#E6F4EA;color:#1E6B34', pass: 'background:#E6F4EA;color:#1E6B34', certified: 'background:#E6F4EA;color:#1E6B34', approved: 'background:#E6F4EA;color:#1E6B34', signed: 'background:#E6F4EA;color:#1E6B34', resolved: 'background:#E6F4EA;color:#1E6B34',
  attention: 'background:#FDE7E7;color:#A61B1B', fail: 'background:#FDE7E7;color:#A61B1B',
};
const chip = (s: string, label = s.replace(/_/g, ' ')) => `<span class="chip" style="${STATUS_STYLE[s] ?? 'background:#FFF4E0;color:#8A5300'}">${esc(label)}</span>`;
const fmt = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—');

function table(headers: string[], rows: string[][]): string {
  if (!rows.length) return '<p class="note">No records.</p>';
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

type Rec = Record<string, unknown>;
const RECORD_TABLES: Record<string, (rs: Rec[]) => string> = {
  rooms: (rs) => table(['Room', 'Space type', 'Department', 'Result', 'Measured'], rs.map((r) => [`${esc(r.number)} ${esc(r.name)}`, esc(r.spaceType), esc(r.department), chip(String(r.result)), fmt(r.measuredAt)])),
  tests: (rs) => table(['Test', 'Target', 'Status', 'Result', 'Signed by'], rs.map((r) => [esc(r.template), esc(r.target), chip(String(r.status)), chip(String(r.result)), esc(r.signedBy ?? '—')])),
  ees: (rs) => table(['Asset', 'Type', 'Branch', 'Latest result', 'Tested'], rs.map((r) => [esc(r.tag), esc(r.type), esc(r.branch ?? '—'), chip(String(r.result)), fmt(r.testedAt)])),
  icra: (rs) => table(['Zone', 'Class', 'State', 'IP approval', 'Days logged / missing (30 d)', 'Failed logs'], rs.map((r) => [esc(r.name), esc(r.icraClass), r.active ? 'Active' : 'Closed', `${chip(String(r.approval))}${r.approvedBy ? ` ${esc(r.approvedBy)}` : ''}`, `${esc(r.daysLogged)} / ${esc(r.daysMissing)}`, esc(r.failedLogs)])),
  ilsm: (rs) => table(['Deficiency', 'Location', 'Status', 'Measures documented', 'Patrols', 'Fire watch gaps', 'Identified'], rs.map((r) => [`<span class="ls">⚑</span> ${esc(r.deficiency)}`, esc(r.location), chip(String(r.status)), esc(r.measuresDocumented), esc(r.patrols), esc(r.fireWatchGaps), fmt(r.identifiedAt)])),
  medgas: (rs) => table(['Zone', 'Valve', 'Gases', 'Outlets', 'Tests passed', 'Certification'], rs.map((r) => [esc(r.name), esc(r.valveTag), esc(r.gases), esc(r.outlets), `${esc(r.passed)}/${esc(r.required)}`, `${chip(String(r.certification))}${r.certifiedBy ? ` ${esc(r.certifiedBy)}, ${fmt(r.certifiedAt)}` : ''}`])),
  issues: (rs) => table(['#', 'Issue', 'Priority', 'Status', 'Ball in court', 'Opened'], rs.map((r) => [esc(r.number), `${r.lifeSafety ? '<span class="ls">⚑ Life safety</span> ' : ''}${esc(r.title)}`, esc(r.priority), chip(String(r.status)), esc(r.ballInCourt ?? '—'), fmt(r.opened)])),
  integrity: () => '',
};

export function renderBinder(b: Awaited<ReturnType<typeof buildBinder>>): string {
  const p = b.project;
  const codes = (p.adopted_codes as { code: string; edition: string; source?: string }[]).map((c) => `${esc(c.code)} ${esc(c.edition)}${c.source ? ` (${esc(c.source)})` : ''}`).join(', ') || 'Not recorded';
  const toc = b.sections.map((s, i) => `<tr><td>${i + 1}</td><td><a href="#${s.key}">${esc(s.title)}</a></td><td>${chip(s.status, STATUS_LABEL[s.status])}</td><td>${esc(s.summary)}</td></tr>`).join('');
  const gapList = b.gaps.length
    ? `<ol>${b.gaps.map((g) => `<li>${g.severity === 'life_safety' ? '<span class="ls">⚑ Life safety</span> ' : ''}${esc(g.text)} <span class="note">(${esc(g.section)})</span></li>`).join('')}</ol>`
    : '<p>No open gaps. Every section is ready.</p>';
  const body = `
    <section class="cover">
      <p class="meta"><strong>${esc(p.facility_name)}</strong> · ${esc(p.name)}<br>
      State: ${esc(p.state_code)} · Accreditor: ${esc(p.accreditor)} · Project type: ${esc(p.project_type)}<br>
      Adopted code editions: ${codes}<br>Generated ${fmt(b.generatedAt)}</p>
      <h2>Readiness summary</h2>
      <p>${plural(b.summary.ready, 'section')} ready, ${b.summary.attention} need${b.summary.attention === 1 ? 's' : ''} attention, ${b.summary.noRecords} with no records.
      <strong>${b.summary.lifeSafetyGaps} life safety gap${b.summary.lifeSafetyGaps === 1 ? '' : 's'}</strong> and ${b.summary.otherGaps} other gap${b.summary.otherGaps === 1 ? '' : 's'}.</p>
      <table><thead><tr><th>#</th><th>Section</th><th>Status</th><th>Summary</th></tr></thead><tbody>${toc}</tbody></table>
      <h2>Gaps to close before the survey</h2>${gapList}
    </section>
    ${b.sections.map((s, i) => `
      <section id="${s.key}" class="section">
        <h2>${i + 1}. ${esc(s.title)} ${chip(s.status, STATUS_LABEL[s.status])}</h2>
        <p class="meta">${esc(s.summary)}</p>
        ${RECORD_TABLES[s.key]?.(s.records as Rec[]) ?? ''}
      </section>`).join('')}
    <p class="note">This binder is compiled from records in OMOSHINE CX Planner. Signed records are locked; corrections appear as superseding records.
    Requirement values are seeded for review and must be confirmed against the code editions adopted for this project.</p>`;
  return reportShell('Survey binder', p.facility_name, body).replace('</style>', '  .section { page-break-before: always; } .cover ol li { margin-bottom: 4px; }\n</style>');
}

export async function binderRoutes(api: FastifyInstance, db: Db) {
  api.get('/projects/:id/survey-binder', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      return buildBinder(tx, id, p.tenantId, await isTenantAdmin(tx, p.userId));
    }),
  );

  api.get('/projects/:id/survey-binder/report', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const binder = await buildBinder(tx, id, p.tenantId, await isTenantAdmin(tx, p.userId));
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'binder.generate', entityType: 'project', entityId: id, data: { summary: binder.summary } });
      reply.type('text/html; charset=utf-8');
      return renderBinder(binder);
    }),
  );
}
