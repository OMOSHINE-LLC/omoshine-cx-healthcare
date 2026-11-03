import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TURNOVER_KINDS, TURNOVER_VERIFIED, requiredTurnoverKinds, turnoverMatrix, warrantyStatus, type DocStatus, type TurnoverKind } from '@omoshine/rules';
import { appendAudit } from '../audit.js';
import { verifyReauthToken } from '../auth.js';
import { sha256 } from '../crypto.js';
import type { Db, Tx } from '../db.js';
import { HttpError, forbidden, notFound, requirePermission, tenantTx } from '../http.js';
import { phaseState } from './activation.js';
import { buildBinder } from './binder.js';
import { reportShell } from './reports.js';

const uuid = z.string().uuid();
const KINDS = Object.keys(TURNOVER_KINDS) as [TurnoverKind, ...TurnoverKind[]];
const today = () => new Date().toISOString().slice(0, 10);
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface DocRow {
  id: string; system_id: string; asset_id: string | null; asset_tag: string | null; kind: TurnoverKind; title: string; reference: string;
  warranty_start: string | null; warranty_months: number | null; status: DocStatus; review_note: string | null;
  submitted_at: Date; submitted_by_name: string; reviewed_by_name: string | null; reviewed_at: Date | null;
}

/** Turnover state per system: required documents, latest status of each, warranties. */
export async function turnoverState(tx: Tx, projectId: string) {
  const systems = (await tx.query<{ id: string; name: string; discipline: string; system_type: string }>(
    'SELECT id, name, discipline, system_type FROM system WHERE project_id = $1 ORDER BY discipline, name', [projectId])).rows;
  const docs = (await tx.query<DocRow>(
    `SELECT d.*, d.warranty_start::text AS warranty_start, a.tag AS asset_tag, su.name AS submitted_by_name, ru.name AS reviewed_by_name
       FROM turnover_document d JOIN app_user su ON su.id = d.submitted_by LEFT JOIN app_user ru ON ru.id = d.reviewed_by LEFT JOIN asset a ON a.id = d.asset_id
      WHERE d.project_id = $1 ORDER BY d.submitted_at DESC`, [projectId])).rows;
  const asOf = today();
  const out = systems.map((s) => {
    const mine = docs.filter((d) => d.system_id === s.id);
    const matrix = turnoverMatrix(requiredTurnoverKinds(s.discipline), mine.map((d) => ({ kind: d.kind, status: d.status, submittedAt: d.submitted_at.toISOString() })));
    return {
      ...s, matrix,
      accepted: matrix.filter((m) => m.status === 'accepted').length, required: matrix.length,
      documents: mine.map((d) => ({ ...d, warranty: d.kind === 'warranty' ? warrantyStatus(d.warranty_start, d.warranty_months, asOf) : null })),
    };
  });
  const required = out.reduce((a, s) => a + s.required, 0);
  const accepted = out.reduce((a, s) => a + s.accepted, 0);
  const warranties = out.flatMap((s) => s.documents.filter((d) => d.warranty && d.status === 'accepted').map((d) => ({ system: s.name, asset: d.asset_tag, title: d.title, ...d.warranty! })));
  return { systems: out, summary: { required, accepted, percent: required ? Math.round((accepted / required) * 100) : 0 }, warranties, verified: TURNOVER_VERIFIED };
}

async function loadDoc(tx: Tx, id: string) {
  const d = (await tx.query('SELECT * FROM turnover_document WHERE id = $1', [id])).rows[0];
  if (!d) throw notFound('Turnover document');
  return d;
}

/** Everything the final commissioning report states, gathered from the project's records. */
async function finalReportContent(tx: Tx, projectId: string, tenantId: string) {
  const binder = await buildBinder(tx, projectId, tenantId, false);
  const turnover = await turnoverState(tx, projectId);
  const phases = (await tx.query('SELECT *, target_occupancy_date::text AS target_occupancy_date FROM phase WHERE project_id = $1 ORDER BY sequence, name', [projectId])).rows;
  const phaseStates = [];
  for (const ph of phases) phaseStates.push(await phaseState(tx, ph));
  const cxa = (await tx.query<{ name: string; org: string | null }>(
    `SELECT u.name, o.name AS org FROM role_assignment r JOIN app_user u ON u.id = r.user_id LEFT JOIN organization o ON o.id = u.organization_id
      WHERE r.project_id = $1 AND r.role = 'cxa' ORDER BY u.name`, [projectId])).rows;
  const outstanding = [
    ...binder.gaps.map((g) => ({ severity: g.severity, text: g.text, source: g.section })),
    ...turnover.systems.flatMap((s) => s.matrix.filter((m) => m.status !== 'accepted').map((m) => ({
      severity: 'regulatory' as const, source: 'Operations turnover',
      text: `${s.name}: ${m.label} ${m.status === 'missing' ? 'not submitted' : m.status === 'rejected' ? 'rejected; resubmission needed' : 'under review'}`,
    }))),
  ];
  return { binder, turnover, phaseStates, cxa, outstanding };
}

function renderFinalReport(c: Awaited<ReturnType<typeof finalReportContent>>, meta: { version: number | null; issuedBy: string | null; issuedAt: string | null }) {
  const p = c.binder.project;
  const statusText: Record<string, string> = { ready: 'Ready', attention: 'Needs attention', no_records: 'No records' };
  const codes = (p.adopted_codes as { code: string; edition: string }[]).map((x) => `${esc(x.code)} ${esc(x.edition)}`).join(', ') || 'Not recorded';
  const ls = c.outstanding.filter((o) => o.severity === 'life_safety');
  const sectionRows = c.binder.sections.map((s) => `<tr><td>${esc(s.title)}</td><td>${esc(statusText[s.status] ?? s.status)}</td><td>${esc(s.summary)}</td></tr>`).join('');
  const phaseRows = c.phaseStates.map((s) => {
    const occ = s.signoffs.find((x) => x.kind === 'occupied');
    const ready = s.signoffs.find((x) => x.kind === 'ready');
    return `<tr><td>${esc(s.phase.name)}</td><td>${esc(s.phase.status)}</td><td>${s.gates.filter((g) => g.status === 'pass').length} of ${s.gates.filter((g) => g.status !== 'not_applicable').length} gates pass</td>
      <td>${ready ? `${esc(ready.signed_by_name)}, ${esc(new Date(ready.signed_at).toISOString().slice(0, 10))}` : '—'}</td><td>${occ ? esc(occ.occupied_on) : '—'}</td></tr>`;
  }).join('');
  const turnoverRows = c.turnover.systems.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.discipline)}</td><td>${s.accepted} of ${s.required}</td>
    <td>${esc(s.matrix.filter((m) => m.status !== 'accepted').map((m) => m.label).join('; ') || 'Complete')}</td></tr>`).join('');
  const warrantyRows = c.turnover.warranties.map((w) => `<tr><td>${esc(w.system)}${w.asset ? ` · ${esc(w.asset)}` : ''}</td><td>${esc(w.title)}</td><td>${esc(w.endsOn)}</td><td>${esc(w.status)}</td></tr>`).join('');
  const outstandingList = c.outstanding.length
    ? `<ol>${c.outstanding.map((o) => `<li>${o.severity === 'life_safety' ? '<span class="ls">⚑ Life safety</span> ' : ''}${esc(o.text)} <span class="note">(${esc(o.source)})</span></li>`).join('')}</ol>`
    : '<p>None. Every section is complete.</p>';
  const body = `
    <p class="meta"><strong>${esc(p.facility_name)}</strong> · ${esc(p.name)} · ${esc(p.state_code)} · ${esc(p.accreditor ?? '')}</p>
    <p class="meta">Adopted codes: ${codes}</p>
    <p class="meta">Commissioning authority: ${esc(c.cxa.map((x) => `${x.name}${x.org ? ` (${x.org})` : ''}`).join(', ') || 'Not assigned')}</p>
    <p class="meta">${meta.version ? `Version ${meta.version}, issued ${esc(meta.issuedAt)} by ${esc(meta.issuedBy)}` : '<strong>DRAFT</strong> preview, not issued'}</p>
    <h2>1. Summary</h2>
    <p>${plural(c.binder.summary.ready, 'evidence section')} ready, ${c.binder.summary.attention} needing attention, ${c.binder.summary.noRecords} with no records.
      Turnover documents ${c.turnover.summary.accepted} of ${c.turnover.summary.required} accepted (${c.turnover.summary.percent}%).
      ${ls.length ? `<span class="ls">⚑ ${plural(ls.length, 'life safety item')} outstanding</span>` : 'No life safety items outstanding.'}</p>
    <h2>2. Commissioning evidence</h2>
    <table><thead><tr><th>Area</th><th>Status</th><th>Summary</th></tr></thead><tbody>${sectionRows}</tbody></table>
    <h2>3. Phased occupancy</h2>
    ${phaseRows ? `<table><thead><tr><th>Phase</th><th>Status</th><th>Evidence gates</th><th>Signed ready</th><th>Occupied on</th></tr></thead><tbody>${phaseRows}</tbody></table>` : '<p>No phases.</p>'}
    <h2>4. Operations turnover</h2>
    ${turnoverRows ? `<table><thead><tr><th>System</th><th>Discipline</th><th>Documents accepted</th><th>Outstanding</th></tr></thead><tbody>${turnoverRows}</tbody></table>` : '<p>No systems.</p>'}
    <h2>5. Warranties</h2>
    ${warrantyRows ? `<table><thead><tr><th>System</th><th>Warranty</th><th>Ends</th><th>Status</th></tr></thead><tbody>${warrantyRows}</tbody></table>` : '<p>No accepted warranties recorded.</p>'}
    <h2>6. Outstanding items</h2>${outstandingList}
    <h2>7. Basis and limitations</h2>
    <p class="note">This report summarises the signed records held in OMOSHINE CX Planner for this project. Requirement values, state overlays,
      inspection intervals and document lists are seeded for review (verified=false) until confirmed against the editions the project adopts.
      Detailed evidence is in the survey binder and the individual signed records.</p>
    ${meta.version ? `<h2>8. Issue</h2><p>Issued by ${esc(meta.issuedBy)} (commissioning authority) with an electronic signature on ${esc(meta.issuedAt)}. Any later change to the records requires a new version.</p>` : ''}`;
  return reportShell(meta.version ? `Final commissioning report v${meta.version}` : 'Final commissioning report (draft)', p.facility_name, body);
}

export async function turnoverRoutes(api: FastifyInstance, db: Db) {
  api.get('/turnover/catalog', async () => ({ kinds: TURNOVER_KINDS, verified: TURNOVER_VERIFIED }));

  api.get('/projects/:id/turnover', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      return turnoverState(tx, id);
    }),
  );

  api.post('/systems/:id/turnover-documents', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({
        kind: z.enum(KINDS), title: z.string().min(2).max(200), reference: z.string().min(3).max(1000), assetId: uuid.optional(),
        warrantyStart: z.string().date().optional(), warrantyMonths: z.number().int().min(1).max(600).optional(),
      }).parse(req.body);
      const sys = (await tx.query<{ project_id: string }>('SELECT project_id FROM system WHERE id = $1', [id])).rows[0];
      if (!sys) throw notFound('System');
      await requirePermission(tx, p, { projectId: sys.project_id, systemId: id }, 'turnover.submit');
      if (b.kind === 'warranty' && (!b.warrantyStart || !b.warrantyMonths)) throw new HttpError(400, 'A warranty needs its start date and length in months', 'validation');
      if (b.assetId && !(await tx.query('SELECT 1 FROM asset WHERE id = $1 AND system_id = $2', [b.assetId, id])).rowCount) throw new HttpError(400, 'The asset is not part of this system', 'validation');
      const row = (await tx.query(
        `INSERT INTO turnover_document (tenant_id, project_id, system_id, asset_id, kind, title, reference, warranty_start, warranty_months, submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [p.tenantId, sys.project_id, id, b.assetId ?? null, b.kind, b.title, b.reference, b.kind === 'warranty' ? b.warrantyStart : null, b.kind === 'warranty' ? b.warrantyMonths : null, p.userId])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'turnover.submit', entityType: 'turnover_document', entityId: row.id, data: b });
      reply.status(201);
      return row;
    }),
  );

  /** Accept or reject a submitted document. Rejections need a note; reviewed documents are closed. */
  api.post('/turnover-documents/:id/review', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ decision: z.enum(['accepted', 'rejected']), note: z.string().max(2000).optional() }).parse(req.body);
      const d = await loadDoc(tx, id);
      await requirePermission(tx, p, { projectId: d.project_id, systemId: d.system_id }, 'turnover.review');
      if (d.submitted_by === p.userId) throw forbidden('Someone other than the submitter must review a turnover document');
      if (b.decision === 'rejected' && (b.note?.trim().length ?? 0) < 3) throw new HttpError(400, 'Say what needs to change when rejecting a document', 'validation');
      const row = (await tx.query(
        `UPDATE turnover_document SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1 RETURNING *`,
        [id, b.decision, b.note?.trim() || null, p.userId])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: `turnover.${b.decision === 'accepted' ? 'accept' : 'reject'}`, entityType: 'turnover_document', entityId: id, data: b });
      return row;
    }),
  );

  api.get('/projects/:id/turnover/report', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const project = (await tx.query('SELECT name, facility_name FROM project WHERE id = $1', [id])).rows[0];
      const t = await turnoverState(tx, id);
      const st: Record<string, string> = { accepted: 'Accepted', submitted: 'Under review', rejected: 'Rejected', missing: 'Missing' };
      const body = `<p class="meta"><strong>${esc(project.facility_name)}</strong> · ${esc(project.name)} · as of ${today()} · ${t.summary.accepted} of ${t.summary.required} documents accepted (${t.summary.percent}%)</p>
        ${t.systems.map((s) => `<h2>${esc(s.name)} <span class="note">(${esc(s.discipline)})</span></h2>
          <table><thead><tr><th>Document</th><th>Status</th><th>Latest submission</th></tr></thead><tbody>
          ${s.matrix.map((m) => { const d = s.documents.find((x) => x.kind === m.kind); return `<tr><td>${esc(m.label)}</td><td>${esc(st[m.status])}</td><td>${d ? `${esc(d.title)} · ${esc(d.reference)}${d.review_note ? `<div class="note">Review: ${esc(d.review_note)}</div>` : ''}` : '—'}</td></tr>`; }).join('')}
          </tbody></table>`).join('') || '<p>No systems.</p>'}
        <h2>Warranties</h2>${t.warranties.length ? `<table><thead><tr><th>System</th><th>Warranty</th><th>Ends</th><th>Status</th></tr></thead><tbody>${t.warranties.map((w) => `<tr><td>${esc(w.system)}${w.asset ? ` · ${esc(w.asset)}` : ''}</td><td>${esc(w.title)}</td><td>${esc(w.endsOn)}</td><td>${esc(w.status)}</td></tr>`).join('')}</tbody></table>` : '<p>No accepted warranties.</p>'}`;
      reply.type('text/html; charset=utf-8');
      return reportShell('Operations turnover package', project.facility_name, body);
    }),
  );

  // --- Final commissioning report --------------------------------------------------------
  api.get('/projects/:id/final-report/preview', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      reply.type('text/html; charset=utf-8');
      return renderFinalReport(await finalReportContent(tx, id, p.tenantId), { version: null, issuedBy: null, issuedAt: null });
    }),
  );

  api.get('/projects/:id/final-reports', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      return (await tx.query(
        `SELECT f.id, f.version, f.html_sha256, f.summary, f.issued_at, u.name AS issued_by_name FROM final_report f JOIN app_user u ON u.id = f.issued_by
          WHERE f.project_id = $1 ORDER BY f.version DESC`, [id])).rows;
    }),
  );

  api.get('/final-reports/:id', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const f = (await tx.query('SELECT project_id, html, html_sha256 FROM final_report WHERE id = $1', [id])).rows[0];
      if (!f) throw notFound('Final report');
      await requirePermission(tx, p, { projectId: f.project_id }, 'read');
      // The stored report must still match its signed hash.
      if (sha256(f.html) !== f.html_sha256) throw new HttpError(500, 'Stored report does not match its signature', 'integrity');
      reply.type('text/html; charset=utf-8');
      return f.html;
    }),
  );

  /** The CxA issues the final report: the rendered report is frozen, hashed and e-signed. */
  api.post('/projects/:id/final-reports', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const token = req.headers['x-reauth-token'];
      if (typeof token !== 'string') throw new HttpError(401, 'Re-authentication required to sign', 'reauth_required');
      let method: string;
      try { method = (await verifyReauthToken(token, p.userId)).method; } catch { throw new HttpError(401, 'Re-authentication expired; sign in again to sign', 'reauth_required'); }
      const roles = await requirePermission(tx, p, { projectId: id }, 'report.issue');
      if (!roles.includes('cxa')) throw forbidden('Only the commissioning authority issues the final report');
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`final_report:${id}`]);
      const version = (await tx.query<{ n: number }>('SELECT COALESCE(max(version), 0) + 1 AS n FROM final_report WHERE project_id = $1', [id])).rows[0]!.n;
      const user = (await tx.query<{ name: string }>('SELECT name FROM app_user WHERE id = $1', [p.userId])).rows[0]!;
      const issuedAt = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
      const content = await finalReportContent(tx, id, p.tenantId);
      const html = renderFinalReport(content, { version, issuedBy: user.name, issuedAt });
      const digest = sha256(html);
      const summary = {
        evidence: content.binder.summary, turnover: content.turnover.summary,
        outstanding: content.outstanding.length, outstandingLifeSafety: content.outstanding.filter((o) => o.severity === 'life_safety').length,
      };
      const reportId = (await tx.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
      const sig = (await tx.query(
        `INSERT INTO signature (tenant_id, record_type, record_id, record_sha256, signer_id, signer_name, signer_role, meaning, reauth_method)
         VALUES ($1,'final_report',$2,$3,$4,$5,'cxa','approved',$6) RETURNING *`, [p.tenantId, reportId, digest, p.userId, user.name, method])).rows[0];
      const row = (await tx.query(
        `INSERT INTO final_report (id, tenant_id, project_id, version, html, html_sha256, summary, signature_id, issued_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, version, html_sha256, summary, issued_at`,
        [reportId, p.tenantId, id, version, html, digest, JSON.stringify(summary), sig.id, p.userId])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'final_report.issue', entityType: 'project', entityId: id, data: { version, digest, ...summary } });
      reply.status(201);
      return row;
    }),
  );
}
