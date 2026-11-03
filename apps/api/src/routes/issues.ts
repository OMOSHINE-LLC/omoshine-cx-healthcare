import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { scopeOfRoom, type Scope } from '../access.js';
import { appendAudit } from '../audit.js';
import type { Db, Tx } from '../db.js';
import { HttpError, notFound, requirePermission, tenantTx } from '../http.js';

const uuid = z.string().uuid();

interface IssueRow { id: string; project_id: string; room_id: string | null; system_id: string | null; status: string; ball_in_court_org_id: string | null }

async function issueScope(tx: Tx, issue: IssueRow): Promise<Scope> {
  const roomScope = issue.room_id ? await scopeOfRoom(tx, issue.room_id) : null;
  return { projectId: issue.project_id, phaseId: roomScope?.phaseId, departmentId: roomScope?.departmentId, systemId: issue.system_id };
}

async function loadIssue(tx: Tx, id: string): Promise<IssueRow> {
  const r = await tx.query<IssueRow>('SELECT * FROM issue WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound('Issue');
  return r.rows[0];
}

const ISSUE_SELECT = `
  SELECT i.*, o.name AS ball_in_court_name, rm.number AS room_number, rm.name AS room_name, s.name AS system_name, u.name AS created_by_name
    FROM issue i
    LEFT JOIN organization o ON o.id = i.ball_in_court_org_id
    LEFT JOIN room rm ON rm.id = i.room_id
    LEFT JOIN system s ON s.id = i.system_id
    LEFT JOIN app_user u ON u.id = i.created_by`;

export async function issueRoutes(api: FastifyInstance, db: Db) {
  api.get('/projects/:id/issues', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const q = z
        .object({
          status: z.enum(['open', 'in_progress', 'ready_for_review', 'closed', 'not_closed']).optional(),
          ballInCourt: uuid.optional(),
          lifeSafety: z.enum(['true', 'false']).optional(),
          roomId: uuid.optional(),
        })
        .parse(req.query);
      await requirePermission(tx, p, { projectId: id }, 'read');
      return (await tx.query(
        `${ISSUE_SELECT}
          WHERE i.project_id = $1
            AND ($2::text IS NULL OR ($2 = 'not_closed' AND i.status <> 'closed') OR i.status = $2)
            AND ($3::uuid IS NULL OR i.ball_in_court_org_id = $3)
            AND ($4::boolean IS NULL OR i.life_safety = $4)
            AND ($5::uuid IS NULL OR i.room_id = $5)
          ORDER BY i.life_safety DESC, CASE i.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.number DESC`,
        [id, q.status ?? null, q.ballInCourt ?? null, q.lifeSafety === undefined ? null : q.lifeSafety === 'true', q.roomId ?? null],
      )).rows;
    }),
  );

  api.post('/projects/:id/issues', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z
        .object({
          title: z.string().min(3).max(200),
          description: z.string().max(10000).default(''),
          roomId: uuid.optional(),
          systemId: uuid.optional(),
          assetId: uuid.optional(),
          testRunId: uuid.optional(),
          requirementKey: z.string().optional(),
          priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
          lifeSafety: z.boolean().default(false),
          ballInCourtOrgId: uuid.optional(),
          dueDate: z.string().date().optional(),
        })
        .parse(req.body);
      const roomScope = b.roomId ? await scopeOfRoom(tx, b.roomId) : null;
      if (b.roomId && roomScope?.projectId !== id) throw new HttpError(400, 'Room is not in this project', 'validation');
      await requirePermission(tx, p, { projectId: id, phaseId: roomScope?.phaseId, departmentId: roomScope?.departmentId, systemId: b.systemId }, 'issue.create');
      // Serialise numbering per project.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`issue:${id}`]);
      const next = (await tx.query<{ n: number }>('SELECT COALESCE(max(number), 0) + 1 AS n FROM issue WHERE project_id = $1', [id])).rows[0]!.n;
      const issue = (await tx.query(
        `INSERT INTO issue (tenant_id, project_id, number, title, description, room_id, system_id, asset_id, test_run_id, requirement_key,
                            priority, life_safety, ball_in_court_org_id, due_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [p.tenantId, id, next, b.title, b.description, b.roomId ?? null, b.systemId ?? null, b.assetId ?? null, b.testRunId ?? null,
          b.requirementKey ?? null, b.lifeSafety ? 'critical' : b.priority, b.lifeSafety, b.ballInCourtOrgId ?? null, b.dueDate ?? null, p.userId],
      )).rows[0];
      await tx.query(`INSERT INTO issue_event (tenant_id, issue_id, kind, payload, actor_id) VALUES ($1,$2,'created',$3,$4)`,
        [p.tenantId, issue.id, JSON.stringify({ ballInCourtOrgId: b.ballInCourtOrgId ?? null }), p.userId]);
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'issue.create', entityType: 'issue', entityId: issue.id, data: b });
      reply.status(201);
      return issue;
    }),
  );

  api.get('/issues/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const issue = await loadIssue(tx, id);
      await requirePermission(tx, p, await issueScope(tx, issue), 'read');
      const full = (await tx.query(`${ISSUE_SELECT} WHERE i.id = $1`, [id])).rows[0];
      const events = (await tx.query(
        'SELECT e.*, u.name AS actor_name FROM issue_event e JOIN app_user u ON u.id = e.actor_id WHERE e.issue_id = $1 ORDER BY e.at', [id])).rows;
      return { ...full, events };
    }),
  );

  api.patch('/issues/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z
        .object({
          status: z.enum(['open', 'in_progress', 'ready_for_review', 'closed']).optional(),
          ballInCourtOrgId: uuid.nullable().optional(),
          priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
          dueDate: z.string().date().nullable().optional(),
        })
        .parse(req.body);
      const issue = await loadIssue(tx, id);
      const roles = await requirePermission(tx, p, await issueScope(tx, issue), 'issue.update');
      // Closing a life safety issue is reserved for the CxA, owner or safety officer.
      if (b.status === 'closed') {
        const li = (await tx.query<{ life_safety: boolean }>('SELECT life_safety FROM issue WHERE id = $1', [id])).rows[0]!;
        if (li.life_safety && !roles.some((r) => r === 'cxa' || r === 'owner' || r === 'safety_officer')) {
          throw new HttpError(403, 'Only the CxA, owner or safety officer can close a life safety issue', 'forbidden');
        }
      }
      const updated = (await tx.query(
        `UPDATE issue SET
           status = COALESCE($2, status),
           ball_in_court_org_id = CASE WHEN $3::boolean THEN $4::uuid ELSE ball_in_court_org_id END,
           priority = COALESCE($5, priority),
           due_date = CASE WHEN $6::boolean THEN $7::date ELSE due_date END,
           closed_at = CASE WHEN $2 = 'closed' THEN now() WHEN $2 IS NOT NULL THEN NULL ELSE closed_at END
         WHERE id = $1 RETURNING *`,
        [id, b.status ?? null, b.ballInCourtOrgId !== undefined, b.ballInCourtOrgId ?? null, b.priority ?? null, b.dueDate !== undefined, b.dueDate ?? null],
      )).rows[0];
      if (b.status && b.status !== issue.status) {
        await tx.query(`INSERT INTO issue_event (tenant_id, issue_id, kind, payload, actor_id) VALUES ($1,$2,'status_change',$3,$4)`,
          [p.tenantId, id, JSON.stringify({ from: issue.status, to: b.status }), p.userId]);
      }
      if (b.ballInCourtOrgId !== undefined && b.ballInCourtOrgId !== issue.ball_in_court_org_id) {
        await tx.query(`INSERT INTO issue_event (tenant_id, issue_id, kind, payload, actor_id) VALUES ($1,$2,'reassigned',$3,$4)`,
          [p.tenantId, id, JSON.stringify({ from: issue.ball_in_court_org_id, to: b.ballInCourtOrgId }), p.userId]);
      }
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'issue.update', entityType: 'issue', entityId: id, data: b });
      return updated;
    }),
  );

  api.post('/issues/:id/comments', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ text: z.string().min(1).max(10000) }).parse(req.body);
      const issue = await loadIssue(tx, id);
      await requirePermission(tx, p, await issueScope(tx, issue), 'read');
      const ev = (await tx.query(
        `INSERT INTO issue_event (tenant_id, issue_id, kind, payload, actor_id) VALUES ($1,$2,'comment',$3,$4) RETURNING *`,
        [p.tenantId, id, JSON.stringify({ text: b.text }), p.userId],
      )).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'issue.comment', entityType: 'issue', entityId: id, data: b });
      reply.status(201);
      return ev;
    }),
  );
}
