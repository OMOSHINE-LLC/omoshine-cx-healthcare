import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACTIVATION_TEMPLATE_VERIFIED, activationTemplate, phaseGates, type ActivationCategory, type GateInput } from '@omoshine/rules';
import { appendAudit } from '../audit.js';
import { verifyReauthToken } from '../auth.js';
import { canonicalJson, sha256 } from '../crypto.js';
import type { Db, Tx } from '../db.js';
import { HttpError, forbidden, notFound, requirePermission, tenantTx } from '../http.js';
import { lifeSafetyItems } from './lifesafety.js';
import { zoneState } from './medgas.js';
import { reportShell } from './reports.js';

const uuid = z.string().uuid();
const CATEGORIES = ['regulatory', 'life_safety', 'infection_control', 'facilities', 'clinical', 'it'] as const;

interface PhaseRow { id: string; tenant_id: string; project_id: string; name: string; sequence: number; target_occupancy_date: string | null; status: 'planned' | 'active' | 'ready' | 'occupied' }

async function loadPhase(tx: Tx, id: string): Promise<PhaseRow> {
  const r = await tx.query<PhaseRow>('SELECT *, target_occupancy_date::text AS target_occupancy_date FROM phase WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound('Phase');
  return r.rows[0];
}

/** Create the default activation checklist for a phase (idempotent). */
export async function seedActivationItems(tx: Tx, tenantId: string, phaseId: string, stateCode: string): Promise<number> {
  let created = 0;
  for (const [i, it] of activationTemplate(stateCode).entries()) {
    const r = await tx.query(
      `INSERT INTO activation_item (tenant_id, phase_id, key, label, category, required, source, sort) VALUES ($1,$2,$3,$4,$5,$6,'template',$7)
       ON CONFLICT (phase_id, key) DO NOTHING`, [tenantId, phaseId, it.key, it.label, it.category, it.required, i * 10]);
    created += r.rowCount ?? 0;
  }
  return created;
}

/** Evidence gates and checklist state for one phase, computed from existing records. */
export async function phaseState(tx: Tx, phase: PhaseRow) {
  const rooms = (await tx.query<{ overall: string | null }>(
    `SELECT latest.overall FROM room rm
       LEFT JOIN LATERAL (SELECT overall FROM room_measurement m WHERE m.room_id = rm.id ORDER BY measured_at DESC, recorded_at DESC LIMIT 1) latest ON true
      WHERE rm.phase_id = $1`, [phase.id])).rows;
  const tests = (await tx.query<{ status: string; result: string | null }>(
    `SELECT t.status, t.result FROM test_run t
      WHERE t.project_id = $1 AND t.status <> 'superseded' AND (
        (t.target_type = 'room' AND t.target_id IN (SELECT id FROM room WHERE phase_id = $2)) OR
        (t.target_type = 'asset' AND t.target_id IN (SELECT a.id FROM asset a JOIN room r ON r.id = a.room_id WHERE r.phase_id = $2)))`,
    [phase.project_id, phase.id])).rows;
  const zones = (await tx.query(
    `SELECT z.* FROM medgas_zone z WHERE z.project_id = $1 AND (
       z.department_id IN (SELECT id FROM department WHERE phase_id = $2) OR
       z.id IN (SELECT o.zone_id FROM medgas_outlet o JOIN room r ON r.id = o.room_id WHERE r.phase_id = $2))
      ORDER BY z.name`, [phase.project_id, phase.id])).rows;
  const zoneStates = [];
  for (const zn of zones) zoneStates.push({ name: zn.name as string, certified: (await zoneState(tx, zn)).certification.status === 'certified' });
  const phaseRoomIds = new Set((await tx.query<{ id: string }>('SELECT id FROM room WHERE phase_id = $1', [phase.id])).rows.map((r) => r.id));
  const ls = (await lifeSafetyItems(tx, phase.project_id)).filter((i) => i.room_id && phaseRoomIds.has(i.room_id));
  const lsIssues = (await tx.query<{ number: number; title: string }>(
    `SELECT number, title FROM issue WHERE project_id = $1 AND life_safety AND status <> 'closed' AND room_id IN (SELECT id FROM room WHERE phase_id = $2) ORDER BY number`,
    [phase.project_id, phase.id])).rows;
  const items = (await tx.query(
    `SELECT a.*, u.name AS completed_by_name FROM activation_item a LEFT JOIN app_user u ON u.id = a.completed_by WHERE a.phase_id = $1 ORDER BY a.sort, a.label`, [phase.id])).rows;
  const required = items.filter((i) => i.required);

  const input: GateInput = {
    rooms: { total: rooms.length, pass: rooms.filter((r) => r.overall === 'pass').length, fail: rooms.filter((r) => r.overall === 'fail').length, untested: rooms.filter((r) => r.overall !== 'pass' && r.overall !== 'fail').length },
    tests: { total: tests.length, signed: tests.filter((t) => t.status === 'signed').length, failed: tests.filter((t) => t.result === 'fail').length },
    medgasZones: { total: zoneStates.length, certified: zoneStates.filter((z) => z.certified).length },
    lifeSafetyItems: {
      total: ls.length, current: ls.filter((i) => i.dueStatus === 'current' || i.dueStatus === 'due_soon').length,
      failed: ls.filter((i) => i.dueStatus === 'failed').length, overdue: ls.filter((i) => i.dueStatus === 'overdue').length, neverInspected: ls.filter((i) => i.dueStatus === 'never_inspected').length,
    },
    openLifeSafetyIssues: lsIssues.length,
    checklist: { required: required.length, resolved: required.filter((i) => i.status !== 'open').length },
  };
  const { gates, ready } = phaseGates(input);
  const signoffs = (await tx.query(
    `SELECT s.id, s.kind, s.occupied_on::text AS occupied_on, s.snapshot_sha256, s.signed_at, u.name AS signed_by_name, sig.signer_role
       FROM phase_signoff s JOIN app_user u ON u.id = s.signed_by JOIN signature sig ON sig.id = s.signature_id
      WHERE s.phase_id = $1 ORDER BY s.signed_at`, [phase.id])).rows;
  return {
    phase, gates, ready, input, items, signoffs,
    openLifeSafetyIssues: lsIssues, medgasZones: zoneStates,
    /** A phase signed ready whose evidence no longer passes. */
    readinessLapsed: phase.status === 'ready' && !ready,
    templateVerified: ACTIVATION_TEMPLATE_VERIFIED,
  };
}

const snapshotOf = (s: Awaited<ReturnType<typeof phaseState>>, kind: string, occupiedOn: string | null) => ({
  phaseId: s.phase.id, kind, occupiedOn, gates: s.gates.map((g) => ({ key: g.key, status: g.status, detail: g.detail })),
  items: s.items.map((i) => ({ key: i.key, required: i.required, status: i.status, evidence: i.evidence })),
});

export async function activationRoutes(api: FastifyInstance, db: Db) {
  api.get('/projects/:id/activation', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const phases = (await tx.query<PhaseRow>('SELECT *, target_occupancy_date::text AS target_occupancy_date FROM phase WHERE project_id = $1 ORDER BY sequence, name', [id])).rows;
      const out = [];
      for (const ph of phases) {
        const s = await phaseState(tx, ph);
        out.push({
          id: ph.id, name: ph.name, sequence: ph.sequence, targetOccupancyDate: ph.target_occupancy_date, status: ph.status, ready: s.ready, readinessLapsed: s.readinessLapsed,
          gates: s.gates, checklist: s.input.checklist, occupiedOn: s.signoffs.find((x) => x.kind === 'occupied')?.occupied_on ?? null,
        });
      }
      return out;
    }),
  );

  api.get('/phases/:id/activation', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const ph = await loadPhase(tx, id);
      await requirePermission(tx, p, { projectId: ph.project_id, phaseId: ph.id }, 'read');
      const { input: _input, ...rest } = await phaseState(tx, ph);
      return rest;
    }),
  );

  /** Add the default checklist (for phases created before activation existed, or after a template update). */
  api.post('/phases/:id/activation/init', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const ph = await loadPhase(tx, id);
      await requirePermission(tx, p, { projectId: ph.project_id, phaseId: ph.id }, 'activation.manage');
      const state = (await tx.query<{ state_code: string }>('SELECT state_code FROM project WHERE id = $1', [ph.project_id])).rows[0]!.state_code;
      const created = await seedActivationItems(tx, p.tenantId, id, state);
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'activation.init', entityType: 'phase', entityId: id, data: { created } });
      return { created };
    }),
  );

  api.post('/phases/:id/activation-items', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ label: z.string().min(3).max(300), category: z.enum(CATEGORIES), required: z.boolean().default(true) }).parse(req.body);
      const ph = await loadPhase(tx, id);
      await requirePermission(tx, p, { projectId: ph.project_id, phaseId: ph.id }, 'activation.manage');
      const n = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM activation_item WHERE phase_id = $1 AND source = 'custom'`, [id])).rows[0]!.n;
      const row = (await tx.query(
        `INSERT INTO activation_item (tenant_id, phase_id, key, label, category, required, source, sort) VALUES ($1,$2,$3,$4,$5,$6,'custom',1000 + $7) RETURNING *`,
        [p.tenantId, id, `custom_${n + 1}`, b.label, b.category satisfies ActivationCategory, b.required, n])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'activation.item.add', entityType: 'phase', entityId: id, data: b });
      reply.status(201);
      return row;
    }),
  );

  /** Mark an item done (with evidence), not applicable (with a reason), or reopen it. */
  api.patch('/activation-items/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ status: z.enum(['open', 'done', 'na']), evidence: z.string().max(2000).optional() }).parse(req.body);
      const cur = (await tx.query('SELECT * FROM activation_item WHERE id = $1', [id])).rows[0];
      if (!cur) throw notFound('Activation item');
      const ph = await loadPhase(tx, cur.phase_id);
      await requirePermission(tx, p, { projectId: ph.project_id, phaseId: ph.id }, 'activation.manage');
      const evidence = b.evidence?.trim() ?? '';
      if (b.status !== 'open' && evidence.length < 3) {
        throw new HttpError(400, b.status === 'done' ? 'Describe the evidence (document, date, who approved) to mark this done' : 'Give the reason this item does not apply', 'validation');
      }
      const row = (await tx.query(
        `UPDATE activation_item SET status = $2, evidence = $3, completed_by = $4, completed_at = CASE WHEN $2 = 'open' THEN NULL ELSE now() END WHERE id = $1 RETURNING *`,
        [id, b.status, b.status === 'open' ? null : evidence, b.status === 'open' ? null : p.userId])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'activation.item.update', entityType: 'activation_item', entityId: id,
        data: { phaseId: ph.id, key: cur.key, from: cur.status, to: b.status, evidence: b.status === 'open' ? null : evidence } });
      return row;
    }),
  );

  /**
   * Sign the phase ready to occupy (owner or CxA) or occupied (owner), with re-authentication.
   * Both need every evidence gate to pass at the moment of signing.
   */
  api.post('/phases/:id/signoff', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ kind: z.enum(['ready', 'occupied']), occupiedOn: z.string().date().optional() }).parse(req.body);
      const token = req.headers['x-reauth-token'];
      if (typeof token !== 'string') throw new HttpError(401, 'Re-authentication required to sign', 'reauth_required');
      let method: string;
      try { method = (await verifyReauthToken(token, p.userId)).method; } catch { throw new HttpError(401, 'Re-authentication expired; sign in again to sign', 'reauth_required'); }
      const ph = await loadPhase(tx, id);
      const roles = await requirePermission(tx, p, { projectId: ph.project_id, phaseId: ph.id }, 'phase.signoff');
      const role = b.kind === 'occupied' ? (roles.includes('owner') ? 'owner' : null) : roles.includes('owner') ? 'owner' : roles.includes('cxa') ? 'cxa' : null;
      if (!role) throw forbidden(b.kind === 'occupied' ? 'Only the owner can record occupancy' : 'Only the owner or the commissioning authority can sign a phase ready');
      if (ph.status === 'occupied') throw new HttpError(409, 'The phase is already occupied', 'conflict');
      if (b.kind === 'ready' && ph.status === 'ready') throw new HttpError(409, 'The phase is already signed ready', 'conflict');
      if (b.kind === 'occupied' && ph.status !== 'ready') throw new HttpError(409, 'Sign the phase ready before recording occupancy', 'conflict');
      const today = new Date().toISOString().slice(0, 10);
      const occupiedOn = b.kind === 'occupied' ? (b.occupiedOn ?? today) : null;
      if (occupiedOn && occupiedOn > today) throw new HttpError(400, 'Occupancy date cannot be in the future', 'validation');
      const s = await phaseState(tx, ph);
      if (!s.ready) {
        const failing = s.gates.filter((g) => g.status === 'fail').map((g) => `${g.label} (${g.detail})`);
        throw new HttpError(409, `Not ready to occupy: ${failing.join('; ')}`, 'conflict');
      }
      const snapshot = snapshotOf(s, b.kind, occupiedOn);
      const digest = sha256(canonicalJson(snapshot));
      const user = (await tx.query<{ name: string }>('SELECT name FROM app_user WHERE id = $1', [p.userId])).rows[0]!;
      const sig = (await tx.query(
        `INSERT INTO signature (tenant_id, record_type, record_id, record_sha256, signer_id, signer_name, signer_role, meaning, reauth_method)
         VALUES ($1,'phase',$2,$3,$4,$5,$6,'approved',$7) RETURNING *`,
        [p.tenantId, id, digest, p.userId, user.name, role, method])).rows[0];
      const so = (await tx.query(
        `INSERT INTO phase_signoff (tenant_id, phase_id, kind, occupied_on, snapshot, snapshot_sha256, signature_id, signed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [p.tenantId, id, b.kind, occupiedOn, JSON.stringify(snapshot), digest, sig.id, p.userId])).rows[0];
      await tx.query('UPDATE phase SET status = $2 WHERE id = $1', [id, b.kind]);
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: b.kind === 'ready' ? 'phase.ready' : 'phase.occupied', entityType: 'phase', entityId: id, data: { digest, occupiedOn, signatureId: sig.id } });
      reply.status(201);
      return { signoff: so, signature: sig };
    }),
  );

  api.get('/phases/:id/activation/report', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const ph = await loadPhase(tx, id);
      await requirePermission(tx, p, { projectId: ph.project_id, phaseId: ph.id }, 'read');
      const project = (await tx.query('SELECT name, facility_name, state_code FROM project WHERE id = $1', [ph.project_id])).rows[0];
      const s = await phaseState(tx, ph);
      const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
      const ok = 'background:#E6F4EA;color:#1E6B34', bad = 'background:#FDE7E7;color:#A61B1B', grey = 'background:#ECEAE4;color:#4A4A4A';
      const chip = (text: string, style: string) => `<span class="chip" style="${style}">${esc(text)}</span>`;
      const gateRows = s.gates.map((g) => `<tr><td>${g.status === 'fail' && g.key !== 'checklist' ? '<span class="ls">⚑</span> ' : ''}${esc(g.label)}</td><td>${esc(g.detail)}</td>
        <td>${g.status === 'pass' ? chip('Pass', ok) : g.status === 'fail' ? chip('Not met', bad) : chip('Not applicable', grey)}</td></tr>`).join('');
      const catLabel: Record<string, string> = { regulatory: 'Regulatory', life_safety: 'Life safety', infection_control: 'Infection control', facilities: 'Facilities', clinical: 'Clinical', it: 'IT and communications' };
      const itemRows = s.items.map((i) => `<tr><td>${esc(i.label)}${i.required ? '' : ' <span class="note">(optional)</span>'}</td><td>${esc(catLabel[i.category] ?? i.category)}</td>
        <td>${i.status === 'done' ? chip('Done', ok) : i.status === 'na' ? chip('Not applicable', grey) : chip('Open', bad)}</td><td>${esc(i.evidence ?? '')}${i.completed_by_name ? `<div class="note">${esc(i.completed_by_name)}, ${esc(new Date(i.completed_at).toISOString().slice(0, 10))}</div>` : ''}</td></tr>`).join('');
      const signRows = s.signoffs.length
        ? `<table><thead><tr><th>Sign-off</th><th>Signed by</th><th>Date</th><th>Record hash</th></tr></thead><tbody>${s.signoffs.map((x) => `<tr><td>${x.kind === 'ready' ? 'Ready to occupy' : `Occupied on ${esc(x.occupied_on)}`}</td><td>${esc(x.signed_by_name)} (${esc(x.signer_role)})</td><td>${esc(new Date(x.signed_at).toISOString().slice(0, 16).replace('T', ' '))} UTC</td><td><code>${esc(x.snapshot_sha256.slice(0, 16))}…</code></td></tr>`).join('')}</tbody></table>`
        : '<p>Not signed.</p>';
      const statusText: Record<string, string> = { planned: 'Planned', active: 'Active', ready: 'Signed ready to occupy', occupied: 'Occupied' };
      const body = `<p class="meta"><strong>${esc(project.facility_name)}</strong> · ${esc(project.name)} · ${esc(ph.name)} · ${esc(statusText[ph.status])}${ph.target_occupancy_date ? ` · target ${esc(ph.target_occupancy_date)}` : ''}</p>
        ${s.readinessLapsed ? '<p><span class="ls">⚑ Life safety</span> This phase was signed ready, but its evidence no longer passes every gate.</p>' : ''}
        <h2>Evidence gates</h2><table><thead><tr><th>Gate</th><th>Detail</th><th>Status</th></tr></thead><tbody>${gateRows}</tbody></table>
        ${s.openLifeSafetyIssues.length ? `<p class="note">Open life safety issues: ${s.openLifeSafetyIssues.map((i) => `#${i.number} ${esc(i.title)}`).join('; ')}</p>` : ''}
        <h2>Activation checklist</h2><table><thead><tr><th>Item</th><th>Category</th><th>Status</th><th>Evidence</th></tr></thead><tbody>${itemRows}</tbody></table>
        <h2>Sign-offs</h2>${signRows}
        <p class="note">State activation items name the agency in the ${esc(project.state_code)} profile and are seeded for review; confirm each against the agency's current pre-occupancy process.</p>`;
      reply.type('text/html; charset=utf-8');
      return reportShell('Phase activation report', project.facility_name, body);
    }),
  );
}
