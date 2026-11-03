import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_LIFE_SAFETY_POLICY,
  LIFE_SAFETY_KINDS,
  evaluateLifeSafetyInspection,
  lifeSafetyDue,
  pfiStatus,
  type DueStatus,
  type LifeSafetyKind,
} from '@omoshine/rules';
import { scopeOfRoom } from '../access.js';
import { appendAudit } from '../audit.js';
import type { Db, Tx } from '../db.js';
import { HttpError, notFound, requirePermission, tenantTx } from '../http.js';
import { reportShell } from './reports.js';

const uuid = z.string().uuid();
const KINDS = Object.keys(LIFE_SAFETY_KINDS) as [LifeSafetyKind, ...LifeSafetyKind[]];
const today = () => new Date().toISOString().slice(0, 10);

interface ItemRow {
  id: string; project_id: string; kind: LifeSafetyKind; tag: string; room_id: string | null; room_number?: string | null; location: string;
  rating_minutes: number | null; installed_on: string | null; attributes: Record<string, unknown>; active: boolean;
  last_overall?: 'pass' | 'fail' | 'incomplete' | null; last_performed_on?: string | null; last_passed_on?: string | null;
}

const ITEM_SELECT = `
  SELECT i.*, i.installed_on::text AS installed_on, rm.number AS room_number,
         latest.overall AS last_overall, latest.performed_on::text AS last_performed_on,
         (SELECT max(performed_on)::text FROM ls_inspection x WHERE x.item_id = i.id AND x.overall = 'pass') AS last_passed_on
    FROM ls_item i LEFT JOIN room rm ON rm.id = i.room_id
    LEFT JOIN LATERAL (SELECT overall, performed_on FROM ls_inspection x WHERE x.item_id = i.id ORDER BY performed_on DESC, recorded_at DESC LIMIT 1) latest ON true`;

export function withDue(i: ItemRow, asOf = today()) {
  const due = lifeSafetyDue({ kind: i.kind, installedOn: i.installed_on, lastPassedOn: i.last_passed_on, lastResult: i.last_overall ?? null, asOf });
  return { ...i, label: LIFE_SAFETY_KINDS[i.kind].label, group: LIFE_SAFETY_KINDS[i.kind].group, dueStatus: due.status as DueStatus, nextDue: due.nextDue };
}

export async function lifeSafetyItems(tx: Tx, projectId: string) {
  const rows = (await tx.query<ItemRow>(`${ITEM_SELECT} WHERE i.project_id = $1 AND i.active ORDER BY i.kind, i.tag`, [projectId])).rows;
  return rows.map((r) => withDue(r));
}

export async function pfiItems(tx: Tx, projectId: string) {
  const rows = (await tx.query(
    `SELECT p.*, p.planned_completion::text AS planned_completion, l.tag AS ls_tag FROM pfi_item p LEFT JOIN ls_item l ON l.id = p.ls_item_id
      WHERE p.project_id = $1 ORDER BY p.status, p.planned_completion, p.number`, [projectId])).rows;
  return rows.map((r) => ({ ...r, pfiStatus: pfiStatus({ status: r.status, plannedCompletion: r.planned_completion }, today()) }));
}

async function loadItem(tx: Tx, id: string): Promise<ItemRow> {
  const r = await tx.query<ItemRow>(`${ITEM_SELECT} WHERE i.id = $1`, [id]);
  if (!r.rows[0]) throw notFound('Life safety item');
  return r.rows[0];
}

const scopeOf = async (tx: Tx, item: { project_id: string; room_id: string | null }) =>
  item.room_id ? await scopeOfRoom(tx, item.room_id) : { projectId: item.project_id };

function summarize(items: ReturnType<typeof withDue>[]) {
  const groups: Record<string, Record<DueStatus | 'total', number>> = {};
  for (const i of items) {
    const g = (groups[i.group] ??= { total: 0, current: 0, due_soon: 0, overdue: 0, never_inspected: 0, failed: 0 });
    g.total++;
    g[i.dueStatus]++;
  }
  return groups;
}

export async function lifeSafetyRoutes(api: FastifyInstance, db: Db) {
  api.get('/life-safety/catalog', async () => ({ kinds: LIFE_SAFETY_KINDS, policy: DEFAULT_LIFE_SAFETY_POLICY }));

  const itemBody = z.object({
    kind: z.enum(KINDS),
    tag: z.string().min(1).max(60),
    roomId: uuid.optional(),
    location: z.string().max(200).default(''),
    ratingMinutes: z.union([z.literal(20), z.literal(45), z.literal(60), z.literal(90), z.literal(180)]).optional(),
    installedOn: z.string().date().optional(),
    attributes: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  });

  /** Add one item or a batch (e.g. a damper schedule). Existing tags are skipped. */
  api.post('/projects/:id/ls-items', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ items: z.array(itemBody).min(1).max(2000) }).parse(req.body);
      await requirePermission(tx, p, { projectId: id }, 'ls.manage');
      let created = 0;
      for (const it of b.items) {
        const r = await tx.query(
          `INSERT INTO ls_item (tenant_id, project_id, kind, tag, room_id, location, rating_minutes, installed_on, attributes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (project_id, tag) DO NOTHING RETURNING id`,
          [p.tenantId, id, it.kind, it.tag, it.roomId ?? null, it.location, it.ratingMinutes ?? null, it.installedOn ?? null, JSON.stringify(it.attributes), p.userId]);
        created += r.rowCount ?? 0;
      }
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'ls.items.add', entityType: 'project', entityId: id, data: { created, skipped: b.items.length - created } });
      reply.status(201);
      return { created, skipped: b.items.length - created };
    }),
  );

  api.get('/projects/:id/ls-items', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const q = z.object({ group: z.enum(['damper', 'door', 'fire_alarm']).optional(), status: z.string().optional() }).parse(req.query);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const all = await lifeSafetyItems(tx, id);
      const items = all.filter((i) => (!q.group || i.group === q.group) && (!q.status || i.dueStatus === q.status));
      return { summary: summarize(all), items };
    }),
  );

  api.get('/ls-items/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const item = await loadItem(tx, id);
      await requirePermission(tx, p, await scopeOf(tx, item), 'read');
      const inspections = (await tx.query(
        `SELECT x.*, x.performed_on::text AS performed_on, u.name AS recorded_by_name FROM ls_inspection x JOIN app_user u ON u.id = x.recorded_by
          WHERE x.item_id = $1 ORDER BY x.performed_on DESC, x.recorded_at DESC`, [id])).rows;
      return { ...withDue(item), checklist: LIFE_SAFETY_KINDS[item.kind].items, inspections };
    }),
  );

  api.patch('/ls-items/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ location: z.string().max(200).optional(), installedOn: z.string().date().nullable().optional(), active: z.boolean().optional() }).parse(req.body);
      const item = await loadItem(tx, id);
      await requirePermission(tx, p, await scopeOf(tx, item), 'ls.manage');
      await tx.query('UPDATE ls_item SET location = $2, installed_on = $3, active = $4 WHERE id = $1',
        [id, b.location ?? item.location, b.installedOn !== undefined ? b.installedOn : item.installed_on, b.active ?? item.active]);
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'ls.item.update', entityType: 'ls_item', entityId: id, data: b });
      return withDue(await loadItem(tx, id));
    }),
  );

  /** Record an inspection. A failure opens a life safety issue. */
  api.post('/ls-items/:id/inspections', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({
        performedOn: z.string().date().optional(),
        answers: z.record(z.union([z.boolean(), z.literal('na')])),
        inspectorCredential: z.string().max(100).optional(),
        notes: z.string().max(4000).optional(),
      }).parse(req.body);
      const item = await loadItem(tx, id);
      await requirePermission(tx, p, await scopeOf(tx, item), 'ls.inspect');
      if (!item.active) throw new HttpError(409, 'Item is retired', 'conflict');
      const performedOn = b.performedOn ?? today();
      if (performedOn > today()) throw new HttpError(400, 'Inspection date cannot be in the future', 'validation');
      const ev = evaluateLifeSafetyInspection(item.kind, b.answers);
      let issueId: string | null = null;
      if (ev.overall === 'fail') {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`issue:${item.project_id}`]);
        const next = (await tx.query<{ n: number }>('SELECT COALESCE(max(number), 0) + 1 AS n FROM issue WHERE project_id = $1', [item.project_id])).rows[0]!.n;
        const failed = ev.results.filter((r) => r.status === 'fail').map((r) => `- ${r.label}`).join('\n');
        issueId = (await tx.query<{ id: string }>(
          `INSERT INTO issue (tenant_id, project_id, number, title, description, room_id, priority, life_safety, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,'high',true,$7) RETURNING id`,
          [p.tenantId, item.project_id, next, `${LIFE_SAFETY_KINDS[item.kind].label} ${item.tag} failed inspection`,
            `${failed}${b.notes ? `\n\nInspector notes: ${b.notes}` : ''}${item.location ? `\n\nLocation: ${item.location}` : ''}`, item.room_id, p.userId])).rows[0]!.id;
        await tx.query(`INSERT INTO issue_event (tenant_id, issue_id, kind, payload, actor_id) VALUES ($1,$2,'created',$3,$4)`,
          [p.tenantId, issueId, JSON.stringify({ source: 'ls_inspection', itemId: id }), p.userId]);
      }
      const row = (await tx.query(
        `INSERT INTO ls_inspection (tenant_id, item_id, performed_on, answers, results, overall, inspector_credential, notes, issue_id, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [p.tenantId, id, performedOn, JSON.stringify(b.answers), JSON.stringify(ev.results), ev.overall, b.inspectorCredential ?? null, b.notes ?? null, issueId, p.userId])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'ls.inspect', entityType: 'ls_item', entityId: id, data: { inspectionId: row.id, overall: ev.overall, issueId } });
      reply.status(201);
      return { inspectionId: row.id, evaluation: ev, issueId, item: withDue(await loadItem(tx, id)) };
    }),
  );

  // --- Statement of Conditions: plan-for-improvement items ---------------------------
  api.post('/projects/:id/pfi', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({
        deficiency: z.string().min(3).max(2000), codeReference: z.string().max(200).default(''), location: z.string().min(1).max(200),
        plannedCompletion: z.string().date(), estimatedCost: z.number().nonnegative().optional(), ilsmAssessmentId: uuid.optional(), lsItemId: uuid.optional(),
      }).parse(req.body);
      await requirePermission(tx, p, { projectId: id }, 'soc.manage');
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pfi:${id}`]);
      const next = (await tx.query<{ n: number }>('SELECT COALESCE(max(number), 0) + 1 AS n FROM pfi_item WHERE project_id = $1', [id])).rows[0]!.n;
      const row = (await tx.query(
        `INSERT INTO pfi_item (tenant_id, project_id, number, deficiency, code_reference, location, planned_completion, estimated_cost, ilsm_assessment_id, ls_item_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [p.tenantId, id, next, b.deficiency, b.codeReference, b.location, b.plannedCompletion, b.estimatedCost ?? null, b.ilsmAssessmentId ?? null, b.lsItemId ?? null, p.userId])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'pfi.create', entityType: 'pfi_item', entityId: row.id, data: b });
      reply.status(201);
      return row;
    }),
  );

  api.get('/projects/:id/pfi', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      return pfiItems(tx, id);
    }),
  );

  api.patch('/pfi/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({
        plannedCompletion: z.string().date().optional(), status: z.literal('resolved').optional(), resolution: z.string().min(3).max(2000).optional(), ilsmAssessmentId: uuid.nullable().optional(),
      }).parse(req.body);
      const cur = (await tx.query('SELECT *, planned_completion::text AS planned_completion FROM pfi_item WHERE id = $1', [id])).rows[0];
      if (!cur) throw notFound('Plan-for-improvement item');
      await requirePermission(tx, p, { projectId: cur.project_id }, 'soc.manage');
      if (b.status === 'resolved' && !b.resolution) throw new HttpError(400, 'Describe how the deficiency was corrected to resolve it', 'validation');
      const row = (await tx.query(
        `UPDATE pfi_item SET planned_completion = $2, status = $3, resolution = $4, resolved_at = CASE WHEN $3 = 'resolved' THEN now() ELSE NULL END,
                ilsm_assessment_id = $5 WHERE id = $1 RETURNING *`,
        [id, b.plannedCompletion ?? cur.planned_completion, b.status ?? cur.status, b.resolution ?? cur.resolution,
          b.ilsmAssessmentId !== undefined ? b.ilsmAssessmentId : cur.ilsm_assessment_id])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: b.status === 'resolved' ? 'pfi.resolve' : 'pfi.update', entityType: 'pfi_item', entityId: id,
        data: { ...b, previousPlannedCompletion: cur.planned_completion } });
      return row;
    }),
  );

  // --- Report -------------------------------------------------------------------------
  api.get('/projects/:id/life-safety/report', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const project = (await tx.query('SELECT name, facility_name FROM project WHERE id = $1', [id])).rows[0];
      const items = await lifeSafetyItems(tx, id);
      const pfi = await pfiItems(tx, id);
      const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
      const label: Record<string, string> = { current: 'Current', due_soon: 'Due soon', overdue: 'Overdue', never_inspected: 'Never inspected', failed: 'Failed', open: 'Open', resolved: 'Resolved' };
      const style: Record<string, string> = { current: 'background:#E6F4EA;color:#1E6B34', resolved: 'background:#E6F4EA;color:#1E6B34', overdue: 'background:#FDE7E7;color:#A61B1B', failed: 'background:#FDE7E7;color:#A61B1B' };
      const chip = (s: string) => `<span class="chip" style="${style[s] ?? 'background:#FFF4E0;color:#8A5300'}">${esc(label[s] ?? s)}</span>`;
      const groupTitle: Record<string, string> = { damper: 'Fire and smoke dampers', door: 'Fire and smoke doors', fire_alarm: 'Fire alarm devices' };
      const sum = summarize(items);
      const sections = (['damper', 'door', 'fire_alarm'] as const).map((g) => {
        const list = items.filter((i) => i.group === g);
        if (!list.length) return '';
        const s = sum[g]!;
        return `<h2>${groupTitle[g]}</h2><p class="meta">${s.total} items: ${s.current} current, ${s.due_soon} due soon, ${s.overdue} overdue, ${s.failed} failed, ${s.never_inspected} never inspected</p>
          <table><thead><tr><th>Tag</th><th>Type</th><th>Location</th><th>Rating</th><th>Last inspected</th><th>Next due</th><th>Status</th></tr></thead><tbody>
          ${list.map((i) => `<tr><td>${esc(i.tag)}</td><td>${esc(i.label)}</td><td>${esc([i.room_number, i.location].filter(Boolean).join(' · '))}</td><td>${i.rating_minutes ? `${i.rating_minutes} min` : '—'}</td>
            <td>${esc(i.last_performed_on ?? '—')}</td><td>${esc(i.nextDue ?? '—')}</td><td>${i.dueStatus === 'failed' || i.dueStatus === 'overdue' ? '<span class="ls">⚑</span> ' : ''}${chip(i.dueStatus)}</td></tr>`).join('')}
          </tbody></table>`;
      }).join('');
      const pfiHtml = pfi.length
        ? `<table><thead><tr><th>#</th><th>Deficiency</th><th>Code reference</th><th>Location</th><th>Planned completion</th><th>Status</th></tr></thead><tbody>
          ${pfi.map((x) => `<tr><td>${x.number}</td><td>${esc(x.deficiency)}${x.resolution ? `<div class="note">Resolution: ${esc(x.resolution)}</div>` : ''}</td><td>${esc(x.code_reference)}</td><td>${esc(x.location)}</td><td>${esc(x.planned_completion)}</td><td>${chip(x.pfiStatus)}</td></tr>`).join('')}
          </tbody></table>`
        : '<p>No plan-for-improvement items.</p>';
      const body = `<p class="meta"><strong>${esc(project.facility_name)}</strong> · ${esc(project.name)} · as of ${today()}</p>
        ${sections || '<p>No life safety items recorded.</p>'}
        <h2>Statement of Conditions: plan for improvement</h2>${pfiHtml}
        <p class="note">Inspection intervals follow the hospital's life safety policy (default: dampers 6 years after the first test within 1 year of installation; doors and most fire alarm devices annually; waterflow and tamper switches every 6 months). Values are seeded for review and must be confirmed against the adopted editions.</p>`;
      reply.type('text/html; charset=utf-8');
      return reportShell('Life safety report', project.facility_name, body);
    }),
  );
}
