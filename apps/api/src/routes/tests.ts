import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { evaluateRequirement, ENGINE_VERSION } from '@omoshine/rules';
import { SIGNATURE_MEANINGS, scopeOfTarget, type Role } from '../access.js';
import { appendAudit } from '../audit.js';
import { verifyReauthToken } from '../auth.js';
import { canonicalJson, sha256 } from '../crypto.js';
import type { Db, Tx } from '../db.js';
import { HttpError, forbidden, notFound, requirePermission, requirementsForProject, tenantTx } from '../http.js';

const uuid = z.string().uuid();

interface RunRow {
  id: string; project_id: string; template_id: string; target_type: 'room' | 'system' | 'asset'; target_id: string;
  status: string; result: string | null; supersedes: string | null; superseded_by: string | null; started_at: Date; submitted_at: Date | null; created_by: string;
}

async function loadRun(tx: Tx, id: string): Promise<RunRow> {
  const r = await tx.query<RunRow>('SELECT * FROM test_run WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound('Test run');
  return r.rows[0];
}

async function runDetail(tx: Tx, id: string) {
  const run = await loadRun(tx, id);
  const template = (await tx.query('SELECT * FROM template WHERE id = $1', [run.template_id])).rows[0];
  const items = (await tx.query('SELECT * FROM template_item WHERE template_id = $1 ORDER BY seq', [run.template_id])).rows;
  const responses = (await tx.query('SELECT * FROM test_response WHERE test_run_id = $1', [id])).rows;
  const signatures = (await tx.query('SELECT * FROM signature WHERE record_type = $1 AND record_id = $2 ORDER BY signed_at', ['test_run', id])).rows;
  return { run, template, items, responses, signatures };
}

/** The exact content a signature binds to: the run and its responses, canonicalised. */
export async function testRunDigest(tx: Tx, id: string): Promise<string> {
  const d = await runDetail(tx, id);
  const content = {
    run: { id: d.run.id, template_id: d.run.template_id, target_type: d.run.target_type, target_id: d.run.target_id, result: d.run.result, submitted_at: d.run.submitted_at },
    responses: d.responses
      .map((r) => ({ item: r.template_item_id, value: r.value, status: r.status, note: r.note }))
      .sort((a, b) => String(a.item).localeCompare(String(b.item))),
  };
  return sha256(canonicalJson(content));
}

export async function testRoutes(api: FastifyInstance, db: Db) {
  // --- Template library ---------------------------------------------------------
  api.get('/templates', async (req) =>
    tenantTx(db, req, async (tx) =>
      (await tx.query(`SELECT t.*, (SELECT count(*) FROM template_item i WHERE i.template_id = t.id)::int AS item_count
                         FROM template t ORDER BY t.kind, t.name, t.version`)).rows,
    ),
  );

  api.get('/templates/:id', async (req) =>
    tenantTx(db, req, async (tx) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const t = (await tx.query('SELECT * FROM template WHERE id = $1', [id])).rows[0];
      if (!t) throw notFound('Template');
      return { ...t, items: (await tx.query('SELECT * FROM template_item WHERE template_id = $1 ORDER BY seq', [id])).rows };
    }),
  );

  // --- Test runs (pre-functional checklists and functional performance tests) -----
  api.post('/test-runs', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const b = z.object({ templateId: uuid, targetType: z.enum(['room', 'system', 'asset']), targetId: uuid }).parse(req.body);
      const scope = await scopeOfTarget(tx, b.targetType, b.targetId);
      await requirePermission(tx, p, scope, 'test.execute');
      const t = (await tx.query<{ published: boolean }>('SELECT published FROM template WHERE id = $1', [b.templateId])).rows[0];
      if (!t) throw notFound('Template');
      if (!t.published) throw new HttpError(400, 'Only published templates can be executed', 'validation');
      const run = (await tx.query<RunRow>(
        `INSERT INTO test_run (tenant_id, project_id, template_id, target_type, target_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [p.tenantId, scope!.projectId, b.templateId, b.targetType, b.targetId, p.userId],
      )).rows[0]!;
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'test_run.start', entityType: 'test_run', entityId: run.id, data: b });
      reply.status(201);
      return run;
    }),
  );

  api.get('/projects/:id/test-runs', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const q = z.object({ status: z.string().optional() }).parse(req.query);
      await requirePermission(tx, p, { projectId: id }, 'read');
      return (await tx.query(
        `SELECT r.*, t.name AS template_name, t.kind,
                COALESCE(rm.number || ' ' || rm.name, s.name, a.tag) AS target_label
           FROM test_run r JOIN template t ON t.id = r.template_id
           LEFT JOIN room rm ON r.target_type = 'room' AND rm.id = r.target_id
           LEFT JOIN system s ON r.target_type = 'system' AND s.id = r.target_id
           LEFT JOIN asset a ON r.target_type = 'asset' AND a.id = r.target_id
          WHERE r.project_id = $1 AND ($2::text IS NULL OR r.status = $2) ORDER BY r.started_at DESC`,
        [id, q.status ?? null],
      )).rows;
    }),
  );

  api.get('/test-runs/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const run = await loadRun(tx, id);
      await requirePermission(tx, p, await scopeOfTarget(tx, run.target_type, run.target_id), 'read');
      return runDetail(tx, id);
    }),
  );

  api.put('/test-runs/:id/responses/:itemId', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id, itemId } = z.object({ id: uuid, itemId: uuid }).parse(req.params);
      const b = z.object({ value: z.union([z.string(), z.number(), z.boolean()]).nullable(), note: z.string().max(4000).optional() }).parse(req.body);
      const run = await loadRun(tx, id);
      await requirePermission(tx, p, await scopeOfTarget(tx, run.target_type, run.target_id), 'test.execute');
      if (run.status !== 'in_progress') throw new HttpError(423, 'Test run is locked', 'locked');
      const item = (await tx.query<{ id: string; response_type: string; requirement_key: string | null }>(
        'SELECT * FROM template_item WHERE id = $1 AND template_id = $2', [itemId, run.template_id])).rows[0];
      if (!item) throw notFound('Template item');

      let status: 'pass' | 'fail' | 'not_evaluated' = 'not_evaluated';
      let evaluation: unknown = null;
      if (item.response_type === 'pass_fail') {
        if (b.value === 'pass' || b.value === true) status = 'pass';
        else if (b.value === 'fail' || b.value === false) status = 'fail';
        else if (b.value !== null) throw new HttpError(400, 'Pass/fail items accept "pass" or "fail"', 'validation');
      } else if (item.response_type === 'number') {
        const num = b.value === null ? null : Number(b.value);
        if (num !== null && Number.isNaN(num)) throw new HttpError(400, 'Numeric value required', 'validation');
        if (item.requirement_key) {
          const req2 = (await requirementsForProject(tx, run.project_id)).find((r) => r.key === item.requirement_key);
          if (req2) {
            const ev = evaluateRequirement(req2, num);
            status = ev.status;
            evaluation = { ...ev, engineVersion: ENGINE_VERSION };
          }
        } else if (num !== null) status = 'pass';
      } else {
        status = b.value === null || b.value === '' ? 'not_evaluated' : 'pass';
      }

      const row = (await tx.query(
        `INSERT INTO test_response (tenant_id, test_run_id, template_item_id, value, status, evaluation, note, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (test_run_id, template_item_id) DO UPDATE SET value = EXCLUDED.value, status = EXCLUDED.status,
           evaluation = EXCLUDED.evaluation, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING *`,
        [p.tenantId, id, itemId, b.value === null ? null : String(b.value), status, evaluation ? JSON.stringify(evaluation) : null, b.note ?? null, p.userId],
      )).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'test_response.record', entityType: 'test_run', entityId: id, data: { itemId, value: b.value, status } });
      return row;
    }),
  );

  api.post('/test-runs/:id/submit', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const run = await loadRun(tx, id);
      await requirePermission(tx, p, await scopeOfTarget(tx, run.target_type, run.target_id), 'test.execute');
      if (run.status !== 'in_progress') throw new HttpError(409, `Run is ${run.status}`, 'conflict');
      const missing = await tx.query(
        `SELECT i.seq, i.prompt FROM template_item i
           LEFT JOIN test_response r ON r.template_item_id = i.id AND r.test_run_id = $1
          WHERE i.template_id = $2 AND i.required AND (r.id IS NULL OR r.value IS NULL OR r.value = '')`,
        [id, run.template_id],
      );
      if (missing.rowCount) throw new HttpError(400, `Required items unanswered: ${missing.rows.map((m) => m.seq).join(', ')}`, 'incomplete');
      const failed = await tx.query(`SELECT 1 FROM test_response WHERE test_run_id = $1 AND status = 'fail' LIMIT 1`, [id]);
      const result = failed.rowCount ? 'fail' : 'pass';
      const updated = (await tx.query(`UPDATE test_run SET status = 'submitted', result = $2, submitted_at = now() WHERE id = $1 RETURNING *`, [id, result])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'test_run.submit', entityType: 'test_run', entityId: id, data: { result } });
      return updated;
    }),
  );

  api.post('/test-runs/:id/signatures', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ meaning: z.enum(['performed', 'witnessed', 'reviewed', 'approved', 'ahj_accepted']) }).parse(req.body);
      const token = req.headers['x-reauth-token'];
      if (typeof token !== 'string') throw new HttpError(401, 'Re-authentication required to sign', 'reauth_required');
      let method: string;
      try {
        method = (await verifyReauthToken(token, p.userId)).method;
      } catch {
        throw new HttpError(401, 'Re-authentication expired; sign in again to sign', 'reauth_required');
      }
      const run = await loadRun(tx, id);
      const roles = await requirePermission(tx, p, await scopeOfTarget(tx, run.target_type, run.target_id), 'test.sign');
      const role = roles.find((r: Role) => SIGNATURE_MEANINGS[r].includes(b.meaning));
      if (!role) throw forbidden(`None of your roles may sign as "${b.meaning}"`);
      if (run.status !== 'submitted' && run.status !== 'signed') throw new HttpError(409, 'Only submitted runs can be signed', 'conflict');

      const digest = await testRunDigest(tx, id);
      const user = (await tx.query<{ name: string }>('SELECT name FROM app_user WHERE id = $1', [p.userId])).rows[0]!;
      const sig = (await tx.query(
        `INSERT INTO signature (tenant_id, record_type, record_id, record_sha256, signer_id, signer_name, signer_role, meaning, reauth_method)
         VALUES ($1,'test_run',$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [p.tenantId, id, digest, p.userId, user.name, role, b.meaning, method],
      )).rows[0];
      if (run.status === 'submitted') await tx.query(`UPDATE test_run SET status = 'signed' WHERE id = $1`, [id]);
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'test_run.sign', entityType: 'test_run', entityId: id, data: { meaning: b.meaning, role, digest } });
      reply.status(201);
      return sig;
    }),
  );

  /** Verify every signature still matches the record content. */
  api.get('/test-runs/:id/verify', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const run = await loadRun(tx, id);
      await requirePermission(tx, p, await scopeOfTarget(tx, run.target_type, run.target_id), 'read');
      const digest = await testRunDigest(tx, id);
      const sigs = (await tx.query<{ id: string; record_sha256: string }>('SELECT id, record_sha256 FROM signature WHERE record_type = $1 AND record_id = $2', ['test_run', id])).rows;
      return { digest, signatures: sigs.map((s) => ({ id: s.id, valid: s.record_sha256 === digest })), valid: sigs.every((s) => s.record_sha256 === digest) };
    }),
  );

  /** Create a new run that supersedes a signed one (signed records are never edited). */
  api.post('/test-runs/:id/supersede', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ reason: z.string().min(3) }).parse(req.body);
      const old = await loadRun(tx, id);
      await requirePermission(tx, p, await scopeOfTarget(tx, old.target_type, old.target_id), 'test.execute');
      if (old.status !== 'signed') throw new HttpError(409, 'Only signed runs are superseded; edit unsigned runs directly', 'conflict');
      const fresh = (await tx.query<RunRow>(
        `INSERT INTO test_run (tenant_id, project_id, template_id, target_type, target_id, supersedes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [p.tenantId, old.project_id, old.template_id, old.target_type, old.target_id, old.id, p.userId],
      )).rows[0]!;
      await tx.query(`UPDATE test_run SET status = 'superseded', superseded_by = $2 WHERE id = $1`, [id, fresh.id]);
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'test_run.supersede', entityType: 'test_run', entityId: id, data: { newRunId: fresh.id, reason: b.reason } });
      reply.status(201);
      return fresh;
    }),
  );

  // --- Audit -------------------------------------------------------------------------
  api.get('/audit', async (req) =>
    tenantTx(db, req, async (tx) => {
      const q = z.object({ entityType: z.string().optional(), entityId: z.string().optional(), limit: z.coerce.number().int().max(500).default(100) }).parse(req.query);
      return (await tx.query(
        `SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_id
          WHERE ($1::text IS NULL OR a.entity_type = $1) AND ($2::text IS NULL OR a.entity_id = $2)
          ORDER BY a.seq DESC LIMIT $3`,
        [q.entityType ?? null, q.entityId ?? null, q.limit],
      )).rows;
    }),
  );
}
