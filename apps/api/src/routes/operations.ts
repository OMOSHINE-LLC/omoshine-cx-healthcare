import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AUDIENCES, COMPLIANCE_TASKS, COMPLIANCE_VERIFIED, DEFAULT_LIFE_SAFETY_POLICY, LIFE_SAFETY_KINDS, complianceStatus, occurrences, requiredAudiences, warrantyStatus,
  type Audience, type Interval, type TaskStatus,
} from '@omoshine/rules';
import { appendAudit } from '../audit.js';
import type { Db, Tx } from '../db.js';
import { HttpError, notFound, requirePermission, tenantTx } from '../http.js';
import { toCsv } from './connectors.js';
import { lifeSafetyItems } from './lifesafety.js';
import { reportShell } from './reports.js';

const uuid = z.string().uuid();
const today = () => new Date().toISOString().slice(0, 10);
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const AUDIENCE_KEYS = Object.keys(AUDIENCES) as [Audience, ...Audience[]];
/** Failures in these categories put patients or occupants at risk and are flagged life safety. */
const LIFE_SAFETY_CATEGORIES = new Set(['ees', 'life_safety', 'ventilation', 'medical_gas']);

interface TaskRow {
  id: string; project_id: string; kind: string; label: string; category: string; target_type: string; target_id: string | null;
  every: number; unit: Interval['unit']; grace_days: number; checks: { key: string; label: string }[]; start_on: string; active: boolean;
  target_label: string | null; room_id: string | null; last_done_on: string | null; last_result: 'pass' | 'fail' | null;
}

const TASK_SELECT = `
  SELECT t.*, t.start_on::text AS start_on,
         COALESCE(a.tag, r.number || ' ' || r.name, z.name) AS target_label,
         COALESCE(a.room_id, r.id) AS room_id,
         last.performed_on::text AS last_done_on, last.result AS last_result
    FROM compliance_task t
    LEFT JOIN asset a ON t.target_type = 'asset' AND a.id = t.target_id
    LEFT JOIN room r ON t.target_type = 'room' AND r.id = t.target_id
    LEFT JOIN medgas_zone z ON t.target_type = 'medgas_zone' AND z.id = t.target_id
    LEFT JOIN LATERAL (SELECT performed_on, result FROM compliance_completion c WHERE c.task_id = t.id ORDER BY performed_on DESC, recorded_at DESC LIMIT 1) last ON true`;

function withStatus(t: TaskRow, asOf = today()) {
  const s = complianceStatus({ interval: { every: t.every, unit: t.unit }, graceDays: t.grace_days, startOn: t.start_on, lastDoneOn: t.last_done_on, lastResult: t.last_result, asOf });
  return { ...t, status: s.status, nextDue: s.nextDue, frequency: frequencyText(t.every, t.unit) };
}
export const frequencyText = (every: number, unit: string) =>
  every === 1 ? ({ day: 'Daily', week: 'Weekly', month: 'Monthly' } as Record<string, string>)[unit]! : unit === 'month' && every === 12 ? 'Annually' : `Every ${every} ${unit}s`;

export async function complianceTasks(tx: Tx, projectId: string) {
  return (await tx.query<TaskRow>(`${TASK_SELECT} WHERE t.project_id = $1 AND t.active ORDER BY t.category, t.label, target_label`, [projectId])).rows.map((t) => withStatus(t));
}

async function loadTask(tx: Tx, id: string): Promise<TaskRow> {
  const t = (await tx.query<TaskRow>(`${TASK_SELECT} WHERE t.id = $1`, [id])).rows[0];
  if (!t) throw notFound('Compliance task');
  return t;
}

/** Training matrix: each system and the audiences that need training on it. */
async function trainingState(tx: Tx, projectId: string) {
  const systems = (await tx.query<{ id: string; name: string; discipline: string; system_type: string }>('SELECT id, name, discipline, system_type FROM system WHERE project_id = $1 ORDER BY name', [projectId])).rows;
  const sessions = (await tx.query(
    `SELECT s.*, (SELECT count(*)::int FROM training_attendance a WHERE a.session_id = s.id) AS attendee_count,
            (SELECT array_agg(DISTINCT a.audience) FROM training_attendance a WHERE a.session_id = s.id) AS attended_audiences
       FROM training_session s WHERE s.project_id = $1 ORDER BY s.scheduled_at`, [projectId])).rows;
  const matrix = systems.map((s) => ({
    ...s,
    audiences: requiredAudiences(s.discipline, s.system_type).map((aud) => {
      const held = sessions.filter((x) => x.system_id === s.id && x.status === 'held' && (x.attended_audiences ?? []).includes(aud));
      const planned = sessions.filter((x) => x.system_id === s.id && x.status === 'scheduled' && x.audiences.includes(aud));
      return { audience: aud, label: AUDIENCES[aud], status: held.length ? 'trained' : planned.length ? 'scheduled' : 'needed' };
    }),
  }));
  const cells = matrix.flatMap((m) => m.audiences);
  return { sessions, matrix, summary: { required: cells.length, trained: cells.filter((c) => c.status === 'trained').length, scheduled: cells.filter((c) => c.status === 'scheduled').length } };
}

export async function operationsRoutes(api: FastifyInstance, db: Db) {
  // --- Compliance calendar ------------------------------------------------------------
  api.get('/compliance/catalog', async () => ({ tasks: COMPLIANCE_TASKS, audiences: AUDIENCES, verified: COMPLIANCE_VERIFIED }));

  /** Create the standard recurring tasks for the project's generators, transfer switches, isolation rooms, gas zones and building. */
  api.post('/projects/:id/compliance/generate', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ startOn: z.string().date().optional() }).parse(req.body ?? {});
      await requirePermission(tx, p, { projectId: id }, 'compliance.manage');
      const startOn = b.startOn ?? today();
      const assets = (await tx.query<{ id: string; asset_type: string }>('SELECT a.id, a.asset_type FROM asset a JOIN system s ON s.id = a.system_id WHERE s.project_id = $1', [id])).rows;
      const rooms = (await tx.query<{ id: string; space_type_id: string }>(
        `SELECT rm.id, rm.space_type_id FROM room rm JOIN department d ON d.id = rm.department_id JOIN floor f ON f.id = d.floor_id JOIN building b ON b.id = f.building_id WHERE b.project_id = $1`, [id])).rows;
      const zones = (await tx.query<{ id: string }>('SELECT id FROM medgas_zone WHERE project_id = $1', [id])).rows;
      let created = 0;
      for (const [kind, def] of Object.entries(COMPLIANCE_TASKS)) {
        const targets: (string | null)[] =
          def.appliesTo?.assetTypes ? assets.filter((a) => def.appliesTo!.assetTypes!.includes(a.asset_type)).map((a) => a.id)
          : def.appliesTo?.spaceTypes ? rooms.filter((r) => def.appliesTo!.spaceTypes!.includes(r.space_type_id)).map((r) => r.id)
          : def.appliesTo?.withGasZones ? zones.map((z) => z.id)
          : def.appliesTo?.projectWide ? [null] : [];
        for (const t of targets) {
          const r = await tx.query(
            `INSERT INTO compliance_task (tenant_id, project_id, kind, label, category, target_type, target_id, every, unit, grace_days, checks, start_on, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
            [p.tenantId, id, kind, def.label, def.category, def.target, t, def.interval.every, def.interval.unit, def.graceDays, JSON.stringify(def.checks), startOn, p.userId]);
          created += r.rowCount ?? 0;
        }
      }
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'compliance.generate', entityType: 'project', entityId: id, data: { created, startOn } });
      return { created };
    }),
  );

  api.post('/projects/:id/compliance-tasks', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({
        label: z.string().min(3).max(200), category: z.enum(['ees', 'life_safety', 'water', 'medical_gas', 'ventilation', 'other']),
        targetType: z.enum(['asset', 'room', 'medgas_zone', 'project']).default('project'), targetId: uuid.optional(),
        every: z.number().int().min(1).max(120), unit: z.enum(['day', 'week', 'month']), graceDays: z.number().int().min(0).max(90).default(0),
        checks: z.array(z.string().min(3).max(300)).min(1).max(30), startOn: z.string().date().optional(),
      }).parse(req.body);
      await requirePermission(tx, p, { projectId: id }, 'compliance.manage');
      if ((b.targetType === 'project') !== !b.targetId) throw new HttpError(400, 'Choose a target for asset, room or gas zone tasks, and none for building-wide tasks', 'validation');
      const n = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM compliance_task WHERE project_id = $1 AND kind LIKE 'custom_%'`, [id])).rows[0]!.n;
      const row = (await tx.query(
        `INSERT INTO compliance_task (tenant_id, project_id, kind, label, category, target_type, target_id, every, unit, grace_days, checks, start_on, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [p.tenantId, id, `custom_${n + 1}`, b.label, b.category, b.targetType, b.targetId ?? null, b.every, b.unit, b.graceDays,
          JSON.stringify(b.checks.map((c, i) => ({ key: `c${i + 1}`, label: c }))), b.startOn ?? today(), p.userId])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'compliance.task.add', entityType: 'project', entityId: id, data: b });
      reply.status(201);
      return withStatus(await loadTask(tx, row.id));
    }),
  );

  /** Tighten or relax an interval, or retire a task. */
  api.patch('/compliance-tasks/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ every: z.number().int().min(1).max(120).optional(), unit: z.enum(['day', 'week', 'month']).optional(), graceDays: z.number().int().min(0).max(90).optional(), active: z.boolean().optional() }).parse(req.body);
      const t = await loadTask(tx, id);
      await requirePermission(tx, p, { projectId: t.project_id }, 'compliance.manage');
      await tx.query('UPDATE compliance_task SET every = $2, unit = $3, grace_days = $4, active = $5 WHERE id = $1', [id, b.every ?? t.every, b.unit ?? t.unit, b.graceDays ?? t.grace_days, b.active ?? t.active]);
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'compliance.task.update', entityType: 'project', entityId: t.project_id, data: { taskId: id, before: { every: t.every, unit: t.unit, graceDays: t.grace_days, active: t.active }, ...b } });
      return withStatus(await loadTask(tx, id));
    }),
  );

  api.get('/projects/:id/compliance', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const tasks = await complianceTasks(tx, id);
      const count = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
      return { tasks, summary: { total: tasks.length, current: count('current'), due: count('due'), overdue: count('overdue'), failed: count('failed') }, verified: COMPLIANCE_VERIFIED };
    }),
  );

  /** Everything falling due in a window: recurring tasks and life safety inspections. */
  api.get('/projects/:id/compliance/calendar', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const q = z.object({ from: z.string().date().optional(), to: z.string().date().optional() }).parse(req.query);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const from = q.from ?? today();
      const to = q.to ?? new Date(Date.parse(from) + 30 * 864e5).toISOString().slice(0, 10);
      if (to < from || Date.parse(to) - Date.parse(from) > 400 * 864e5) throw new HttpError(400, 'Choose a window of up to 400 days', 'validation');
      const events: { date: string; source: 'task' | 'life_safety'; id: string; label: string; target: string | null; status: string }[] = [];
      for (const t of await complianceTasks(tx, id)) {
        // Overdue and failed tasks show on the first day of the window.
        if (t.status === 'overdue' || t.status === 'failed') events.push({ date: from, source: 'task', id: t.id, label: t.label, target: t.target_label, status: t.status });
        for (const d of occurrences(t.nextDue, { every: t.every, unit: t.unit }, from, to)) {
          if (!(d === from && (t.status === 'overdue' || t.status === 'failed'))) events.push({ date: d, source: 'task', id: t.id, label: t.label, target: t.target_label, status: d === t.nextDue ? t.status : 'upcoming' });
        }
      }
      for (const i of await lifeSafetyItems(tx, id)) {
        if (i.dueStatus === 'overdue' || i.dueStatus === 'failed') events.push({ date: from, source: 'life_safety', id: i.id, label: `${LIFE_SAFETY_KINDS[i.kind].label} inspection`, target: i.tag, status: i.dueStatus });
        else if (i.nextDue && i.nextDue >= from && i.nextDue <= to) events.push({ date: i.nextDue, source: 'life_safety', id: i.id, label: `${LIFE_SAFETY_KINDS[i.kind].label} inspection`, target: i.tag, status: i.dueStatus });
      }
      events.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
      return { from, to, events };
    }),
  );

  api.get('/compliance-tasks/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const t = await loadTask(tx, id);
      await requirePermission(tx, p, { projectId: t.project_id }, 'read');
      const completions = (await tx.query(
        `SELECT c.*, c.performed_on::text AS performed_on, u.name AS recorded_by_name FROM compliance_completion c JOIN app_user u ON u.id = c.recorded_by
          WHERE c.task_id = $1 ORDER BY c.performed_on DESC, c.recorded_at DESC LIMIT 100`, [id])).rows;
      return { ...withStatus(t), completions };
    }),
  );

  /** Record a completion. Any "no" fails it and opens an issue (life safety for EES, life safety, ventilation and gas tasks). */
  api.post('/compliance-tasks/:id/completions', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ performedOn: z.string().date().optional(), answers: z.record(z.boolean()), notes: z.string().max(4000).optional() }).parse(req.body);
      const t = await loadTask(tx, id);
      await requirePermission(tx, p, { projectId: t.project_id }, 'compliance.record');
      if (!t.active) throw new HttpError(409, 'This task is retired', 'conflict');
      const performedOn = b.performedOn ?? today();
      if (performedOn > today()) throw new HttpError(400, 'The date cannot be in the future', 'validation');
      const missing = t.checks.filter((c) => typeof b.answers[c.key] !== 'boolean');
      if (missing.length) throw new HttpError(400, `Answer every check: ${missing.map((c) => c.label).join('; ')}`, 'validation');
      const failed = t.checks.filter((c) => b.answers[c.key] === false);
      const result = failed.length ? 'fail' : 'pass';
      if (result === 'fail' && !b.notes?.trim()) throw new HttpError(400, 'Describe what was found when a check fails', 'validation');
      let issueId: string | null = null;
      if (result === 'fail') {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`issue:${t.project_id}`]);
        const next = (await tx.query<{ n: number }>('SELECT COALESCE(max(number), 0) + 1 AS n FROM issue WHERE project_id = $1', [t.project_id])).rows[0]!.n;
        const ls = LIFE_SAFETY_CATEGORIES.has(t.category);
        issueId = (await tx.query<{ id: string }>(
          `INSERT INTO issue (tenant_id, project_id, number, title, description, room_id, priority, life_safety, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [p.tenantId, t.project_id, next, `${t.label}${t.target_label ? ` (${t.target_label})` : ''} failed`, `${failed.map((c) => `- ${c.label}`).join('\n')}\n\nNotes: ${b.notes}`,
            t.room_id, ls ? 'high' : 'medium', ls, p.userId])).rows[0]!.id;
        await tx.query(`INSERT INTO issue_event (tenant_id, issue_id, kind, payload, actor_id) VALUES ($1,$2,'created',$3,$4)`, [p.tenantId, issueId, JSON.stringify({ source: 'compliance_task', taskId: id }), p.userId]);
      }
      const row = (await tx.query(
        `INSERT INTO compliance_completion (tenant_id, task_id, performed_on, answers, result, notes, issue_id, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [p.tenantId, id, performedOn, JSON.stringify(b.answers), result, b.notes ?? null, issueId, p.userId])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'compliance.complete', entityType: 'project', entityId: t.project_id, data: { taskId: id, completionId: row.id, result, issueId } });
      reply.status(201);
      return { completionId: row.id, result, issueId, task: withStatus(await loadTask(tx, id)) };
    }),
  );

  // --- Owner training -----------------------------------------------------------------
  api.get('/projects/:id/training', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      return trainingState(tx, id);
    }),
  );

  api.post('/projects/:id/training-sessions', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({
        systemId: uuid.optional(), topic: z.string().min(3).max(200), audiences: z.array(z.enum(AUDIENCE_KEYS)).min(1),
        trainer: z.string().min(2).max(200), scheduledAt: z.string().datetime({ offset: true }), durationMin: z.number().int().min(5).max(1440),
      }).parse(req.body);
      await requirePermission(tx, p, { projectId: id }, 'training.manage');
      if (b.systemId && !(await tx.query('SELECT 1 FROM system WHERE id = $1 AND project_id = $2', [b.systemId, id])).rowCount) throw new HttpError(400, 'System is not in this project', 'validation');
      const row = (await tx.query(
        `INSERT INTO training_session (tenant_id, project_id, system_id, topic, audiences, trainer, scheduled_at, duration_min, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [p.tenantId, id, b.systemId ?? null, b.topic, b.audiences, b.trainer, b.scheduledAt, b.durationMin, p.userId])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'training.schedule', entityType: 'project', entityId: id, data: { sessionId: row.id, ...b } });
      reply.status(201);
      return row;
    }),
  );

  const loadSession = async (tx: Tx, id: string) => {
    const s = (await tx.query('SELECT * FROM training_session WHERE id = $1', [id])).rows[0];
    if (!s) throw notFound('Training session');
    return s;
  };

  api.post('/training-sessions/:id/attendance', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ attendees: z.array(z.object({ name: z.string().min(2).max(120), audience: z.enum(AUDIENCE_KEYS), department: z.string().max(120).optional() })).min(1).max(500) }).parse(req.body);
      const s = await loadSession(tx, id);
      await requirePermission(tx, p, { projectId: s.project_id }, 'training.manage');
      if (s.status !== 'scheduled') throw new HttpError(409, 'Attendance can only be added before the session is closed', 'conflict');
      let added = 0;
      for (const a of b.attendees) {
        const r = await tx.query(
          `INSERT INTO training_attendance (tenant_id, session_id, attendee_name, audience, department, recorded_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (session_id, attendee_name) DO NOTHING`,
          [p.tenantId, id, a.name.trim(), a.audience, a.department ?? null, p.userId]);
        added += r.rowCount ?? 0;
      }
      reply.status(201);
      return { added, skipped: b.attendees.length - added };
    }),
  );

  /** Close a session as held (with where the sign-in sheet is filed) or cancelled. */
  api.post('/training-sessions/:id/close', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ outcome: z.enum(['held', 'cancelled']), materialsReference: z.string().min(3).max(1000).optional() }).parse(req.body);
      const s = await loadSession(tx, id);
      await requirePermission(tx, p, { projectId: s.project_id }, 'training.manage');
      if (b.outcome === 'held') {
        const n = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM training_attendance WHERE session_id = $1', [id])).rows[0]!.n;
        if (!n) throw new HttpError(409, 'Record who attended before closing the session as held', 'conflict');
        if (!b.materialsReference) throw new HttpError(400, 'Say where the sign-in sheet and materials are filed', 'validation');
      }
      const row = (await tx.query(`UPDATE training_session SET status = $2, materials_reference = $3, held_at = CASE WHEN $2 = 'held' THEN now() ELSE NULL END WHERE id = $1 RETURNING *`,
        [id, b.outcome, b.materialsReference ?? null])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: `training.${b.outcome}`, entityType: 'project', entityId: s.project_id, data: { sessionId: id, ...b } });
      return row;
    }),
  );

  api.get('/training-sessions/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const s = await loadSession(tx, id);
      await requirePermission(tx, p, { projectId: s.project_id }, 'read');
      const attendees = (await tx.query('SELECT attendee_name, audience, department, recorded_at FROM training_attendance WHERE session_id = $1 ORDER BY attendee_name', [id])).rows;
      return { ...s, attendees };
    }),
  );

  api.get('/projects/:id/training/report', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const project = (await tx.query('SELECT name, facility_name FROM project WHERE id = $1', [id])).rows[0];
      const t = await trainingState(tx, id);
      const st: Record<string, string> = { trained: 'Trained', scheduled: 'Scheduled', needed: 'Needed' };
      const body = `<p class="meta"><strong>${esc(project.facility_name)}</strong> · ${esc(project.name)} · ${t.summary.trained} of ${t.summary.required} system and audience pairs trained</p>
        <h2>Training matrix</h2><table><thead><tr><th>System</th><th>Audience</th><th>Status</th></tr></thead><tbody>
        ${t.matrix.flatMap((m) => m.audiences.map((a) => `<tr><td>${esc(m.name)}</td><td>${esc(a.label)}</td><td>${esc(st[a.status])}</td></tr>`)).join('')}</tbody></table>
        <h2>Sessions</h2>${t.sessions.length ? `<table><thead><tr><th>Topic</th><th>Trainer</th><th>When</th><th>Status</th><th>Attendees</th><th>Records</th></tr></thead><tbody>
        ${t.sessions.map((s) => `<tr><td>${esc(s.topic)}</td><td>${esc(s.trainer)}</td><td>${esc(new Date(s.scheduled_at).toISOString().slice(0, 16).replace('T', ' '))} UTC</td><td>${esc(s.status)}</td><td>${s.attendee_count}</td><td>${esc(s.materials_reference ?? '')}</td></tr>`).join('')}</tbody></table>` : '<p>No sessions.</p>'}`;
      reply.type('text/html; charset=utf-8');
      return reportShell('Owner training record', project.facility_name, body);
    }),
  );

  // --- CMMS exports -------------------------------------------------------------------
  api.get('/projects/:id/exports/cmms/:file', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id, file } = z.object({ id: uuid, file: z.enum(['assets.csv', 'pm-schedule.csv']) }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      let csv: string;
      if (file === 'assets.csv') {
        const rows = (await tx.query(
          `SELECT a.tag, a.asset_type, s.name AS system, s.discipline, rm.number AS room, a.manufacturer, a.model, a.serial, a.qr_code,
                  w.warranty_start::text AS warranty_start, w.warranty_months
             FROM asset a JOIN system s ON s.id = a.system_id LEFT JOIN room rm ON rm.id = a.room_id
             LEFT JOIN LATERAL (SELECT warranty_start, warranty_months FROM turnover_document d
                                 WHERE d.kind = 'warranty' AND d.status = 'accepted' AND (d.asset_id = a.id OR (d.asset_id IS NULL AND d.system_id = s.id))
                                 ORDER BY (d.asset_id IS NOT NULL) DESC, d.submitted_at DESC LIMIT 1) w ON true
            WHERE s.project_id = $1 ORDER BY s.name, a.tag`, [id])).rows;
        csv = toCsv(['AssetTag', 'AssetType', 'System', 'Discipline', 'Room', 'Manufacturer', 'Model', 'Serial', 'QRCode', 'WarrantyStart', 'WarrantyEnd'],
          rows.map((r) => [r.tag, r.asset_type, r.system, r.discipline, r.room, r.manufacturer, r.model, r.serial, r.qr_code, r.warranty_start, warrantyStatus(r.warranty_start, r.warranty_months, today()).endsOn]));
      } else {
        const tasks = await complianceTasks(tx, id);
        const ls = await lifeSafetyItems(tx, id);
        csv = toCsv(['Target', 'TargetType', 'Task', 'Category', 'Frequency', 'NextDue', 'Status', 'Source'], [
          ...tasks.map((t) => [t.target_label ?? 'Building', t.target_type, t.label, t.category, t.frequency, t.nextDue, t.status, 'compliance_calendar']),
          ...ls.map((i) => [i.tag, 'life_safety_item', `${i.label} inspection`, 'life_safety',
            frequencyText(DEFAULT_LIFE_SAFETY_POLICY.intervalMonths[i.kind], 'month'),
            i.nextDue, i.dueStatus, 'life_safety']),
        ]);
      }
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'export.cmms', entityType: 'project', entityId: id, data: { file } });
      reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${file}"`);
      return csv;
    }),
  );
}
