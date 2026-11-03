import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SPECIALTY_SYSTEMS, SPECIALTY_VERIFIED, interfaceReadiness, isSpecialtyType, type SpecialtyType } from '@omoshine/rules';
import { appendAudit } from '../audit.js';
import type { Db, Tx } from '../db.js';
import { HttpError, notFound, requirePermission, tenantTx } from '../http.js';

const uuid = z.string().uuid();
const today = () => new Date().toISOString().slice(0, 10);
const TYPES = Object.keys(SPECIALTY_SYSTEMS) as [SpecialtyType, ...SpecialtyType[]];

interface SystemRow { id: string; project_id: string; name: string; discipline: string; system_type: string }

/** Each specialty system with its interfaces, latest results, templates and test runs. */
export async function specialtyState(tx: Tx, projectId: string) {
  const systems = (await tx.query<SystemRow>('SELECT id, project_id, name, discipline, system_type FROM system WHERE project_id = $1 AND system_type = ANY($2) ORDER BY system_type, name', [projectId, TYPES])).rows;
  const tests = (await tx.query(
    `SELECT DISTINCT ON (t.system_id, t.interface_key) t.system_id, t.interface_key, t.result, t.tested_on::text AS tested_on, t.evidence_reference, t.notes, t.issue_id, u.name AS recorded_by_name
       FROM interface_test t JOIN app_user u ON u.id = t.recorded_by
      WHERE t.project_id = $1 ORDER BY t.system_id, t.interface_key, t.tested_on DESC, t.recorded_at DESC`, [projectId])).rows;
  const templates = (await tx.query<{ id: string; name: string; kind: string; applies_to_system_type: string }>(
    `SELECT DISTINCT ON (family_id) id, name, kind, applies_to_system_type FROM template WHERE published AND applies_to_system_type = ANY($1) ORDER BY family_id, version DESC`, [TYPES])).rows;
  const runs = (await tx.query<{ target_id: string; kind: string; status: string; result: string | null }>(
    `SELECT r.target_id, t.kind, r.status, r.result FROM test_run r JOIN template t ON t.id = r.template_id
      WHERE r.project_id = $1 AND r.target_type = 'system' AND r.superseded_by IS NULL AND t.applies_to_system_type = ANY($2)`, [projectId, TYPES])).rows;
  const out = systems.map((s) => {
    const type = s.system_type as SpecialtyType;
    const def = SPECIALTY_SYSTEMS[type];
    const mine = tests.filter((t) => t.system_id === s.id);
    const latest = Object.fromEntries(mine.map((t) => [t.interface_key, t.result]));
    return {
      ...s, type, label: def.label,
      interfaces: def.interfaces.map((i) => ({ ...i, latest: mine.find((t) => t.interface_key === i.key) ?? null })),
      readiness: interfaceReadiness(type, latest),
      templates: templates.filter((t) => t.applies_to_system_type === type).sort((a, b) => a.kind.localeCompare(b.kind)),
      runs: runs.filter((r) => r.target_id === s.id).map((r) => ({ kind: r.kind, status: r.status, result: r.result })),
    };
  });
  const sum = (k: 'total' | 'passed' | 'failed') => out.reduce((n, s) => n + s.readiness[k], 0);
  return { systems: out, summary: { systems: out.length, interfaces: sum('total'), passed: sum('passed'), failed: sum('failed') }, verified: SPECIALTY_VERIFIED };
}

export async function specialtyRoutes(api: FastifyInstance, db: Db) {
  api.get('/specialty/catalog', async () => ({ systems: SPECIALTY_SYSTEMS, verified: SPECIALTY_VERIFIED }));

  /** Add a specialty system with the right discipline and type, so templates, turnover and training follow. */
  api.post('/projects/:id/specialty-systems', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ type: z.enum(TYPES), name: z.string().min(2).max(200) }).parse(req.body);
      await requirePermission(tx, p, { projectId: id }, 'hierarchy.edit');
      const def = SPECIALTY_SYSTEMS[b.type];
      if ((await tx.query('SELECT 1 FROM system WHERE project_id = $1 AND lower(name) = lower($2)', [id, b.name.trim()])).rowCount) throw new HttpError(409, 'A system with this name already exists in the project', 'conflict');
      const row = (await tx.query('INSERT INTO system (tenant_id, project_id, name, discipline, system_type) VALUES ($1,$2,$3,$4,$5) RETURNING *', [p.tenantId, id, b.name, def.discipline, b.type])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'specialty.add', entityType: 'project', entityId: id, data: { systemId: row.id, ...b } });
      reply.status(201);
      return row;
    }),
  );

  api.get('/projects/:id/specialty', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      return specialtyState(tx, id);
    }),
  );

  /** Record an interface test. A failure needs notes and opens an issue, flagged life safety where the interface is. */
  api.post('/systems/:id/interface-tests', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({
        interfaceKey: z.string().min(1), result: z.enum(['pass', 'fail']), testedOn: z.string().date().optional(),
        evidenceReference: z.string().min(3).max(1000).optional(), notes: z.string().max(4000).optional(),
      }).parse(req.body);
      const s = (await tx.query<SystemRow>('SELECT id, project_id, name, discipline, system_type FROM system WHERE id = $1', [id])).rows[0];
      if (!s) throw notFound('System');
      await requirePermission(tx, p, { projectId: s.project_id }, 'test.execute');
      if (!isSpecialtyType(s.system_type)) throw new HttpError(400, 'Interface tests apply to nurse call, pneumatic tube, RTLS and imaging systems', 'validation');
      const def = SPECIALTY_SYSTEMS[s.system_type].interfaces.find((i) => i.key === b.interfaceKey);
      if (!def) throw new HttpError(400, 'Unknown interface for this system', 'validation');
      const testedOn = b.testedOn ?? today();
      if (testedOn > today()) throw new HttpError(400, 'The date cannot be in the future', 'validation');
      if (b.result === 'pass' && !b.evidenceReference) throw new HttpError(400, 'Say where the test record is filed', 'validation');
      if (b.result === 'fail' && !b.notes?.trim()) throw new HttpError(400, 'Describe what failed', 'validation');
      let issueId: string | null = null;
      if (b.result === 'fail') {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`issue:${s.project_id}`]);
        const next = (await tx.query<{ n: number }>('SELECT COALESCE(max(number), 0) + 1 AS n FROM issue WHERE project_id = $1', [s.project_id])).rows[0]!.n;
        issueId = (await tx.query<{ id: string }>(
          `INSERT INTO issue (tenant_id, project_id, number, title, description, system_id, priority, life_safety, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [p.tenantId, s.project_id, next, `${s.name}: ${def.label} failed`, `Interface with ${def.with}. Expected: ${def.acceptance}\n\nFound: ${b.notes}`,
            s.id, def.lifeSafety ? 'high' : 'medium', def.lifeSafety, p.userId])).rows[0]!.id;
        await tx.query(`INSERT INTO issue_event (tenant_id, issue_id, kind, payload, actor_id) VALUES ($1,$2,'created',$3,$4)`, [p.tenantId, issueId, JSON.stringify({ source: 'interface_test', systemId: id, interfaceKey: def.key }), p.userId]);
      }
      const row = (await tx.query(
        `INSERT INTO interface_test (tenant_id, project_id, system_id, interface_key, result, tested_on, evidence_reference, notes, issue_id, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [p.tenantId, s.project_id, id, def.key, b.result, testedOn, b.evidenceReference ?? null, b.notes ?? null, issueId, p.userId])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'interface.test', entityType: 'project', entityId: s.project_id, data: { systemId: id, interfaceKey: def.key, result: b.result, issueId } });
      reply.status(201);
      return { id: row.id, result: b.result, issueId };
    }),
  );

  api.get('/systems/:id/interface-tests', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const s = (await tx.query<{ project_id: string }>('SELECT project_id FROM system WHERE id = $1', [id])).rows[0];
      if (!s) throw notFound('System');
      await requirePermission(tx, p, { projectId: s.project_id }, 'read');
      return (await tx.query(
        `SELECT t.*, t.tested_on::text AS tested_on, u.name AS recorded_by_name FROM interface_test t JOIN app_user u ON u.id = t.recorded_by
          WHERE t.system_id = $1 ORDER BY t.tested_on DESC, t.recorded_at DESC`, [id])).rows;
    }),
  );
}
