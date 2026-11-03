import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ENGINE_VERSION, EES_BRANCHES, evaluateAtsTest, evaluateGeneratorTest } from '@omoshine/rules';
import { scopeOfAsset } from '../access.js';
import { appendAudit } from '../audit.js';
import type { Db, Tx } from '../db.js';
import { HttpError, notFound, overlaysForProject, requirePermission, tenantTx } from '../http.js';

const uuid = z.string().uuid();

interface AssetRow { id: string; tag: string; asset_type: string; attributes: Record<string, unknown> }

async function loadAsset(tx: Tx, id: string): Promise<AssetRow> {
  const r = await tx.query<AssetRow>('SELECT * FROM asset WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound('Asset');
  return r.rows[0];
}

/** Tests due on a monthly cadence that carry into operations. */
export function nextMonthlyDue(last: Date | null): string | null {
  if (!last) return null;
  const d = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, last.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

export async function eesRoutes(api: FastifyInstance, db: Db) {
  api.post('/assets/:id/ats-tests', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z
        .object({
          transferTimeS: z.number().nonnegative().max(600),
          retransferTimeS: z.number().nonnegative().optional(),
          loadKw: z.number().nonnegative().optional(),
          performedAt: z.string().datetime({ offset: true }).optional(),
          testKind: z.enum(['functional', 'monthly', 'annual']).default('functional'),
        })
        .parse(req.body);
      const asset = await loadAsset(tx, id);
      if (asset.asset_type !== 'ats') throw new HttpError(400, 'Asset is not an automatic transfer switch', 'validation');
      const scope = await scopeOfAsset(tx, id);
      await requirePermission(tx, p, scope, 'ees.record');
      const ev = evaluateAtsTest({ transferTimeS: b.transferTimeS, overlays: await overlaysForProject(tx, scope!.projectId) });
      const row = (await tx.query(
        `INSERT INTO ees_test (tenant_id, asset_id, test_type, performed_at, readings, evaluation, overall, life_safety_failure, engine_version, recorded_by)
         VALUES ($1,$2,'ats_transfer',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [p.tenantId, id, b.performedAt ?? new Date().toISOString(), JSON.stringify(b), JSON.stringify(ev.results), ev.overall, ev.lifeSafetyFailure, ENGINE_VERSION, p.userId],
      )).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'ees.ats_test', entityType: 'asset', entityId: id, data: { testId: row.id, overall: ev.overall, transferTimeS: b.transferTimeS } });
      reply.status(201);
      return { test: row, evaluation: ev };
    }),
  );

  api.post('/assets/:id/generator-tests', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z
        .object({
          testType: z.enum(['monthly', 'triennial']),
          durationMin: z.number().nonnegative(),
          loadPct: z.number().min(0).max(150),
          exhaustTempF: z.number().optional(),
          performedAt: z.string().datetime({ offset: true }).optional(),
        })
        .parse(req.body);
      const asset = await loadAsset(tx, id);
      if (asset.asset_type !== 'generator') throw new HttpError(400, 'Asset is not a generator', 'validation');
      await requirePermission(tx, p, await scopeOfAsset(tx, id), 'ees.record');
      const mfr = asset.attributes.mfr_min_exhaust_temp_f;
      const ev = evaluateGeneratorTest({ ...b, manufacturerMinExhaustTempF: typeof mfr === 'number' ? mfr : undefined });
      const row = (await tx.query(
        `INSERT INTO ees_test (tenant_id, asset_id, test_type, performed_at, readings, evaluation, overall, engine_version, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [p.tenantId, id, `generator_${b.testType}`, b.performedAt ?? new Date().toISOString(), JSON.stringify(b), JSON.stringify(ev.results), ev.overall, ENGINE_VERSION, p.userId],
      )).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'ees.generator_test', entityType: 'asset', entityId: id, data: { testId: row.id, overall: ev.overall } });
      reply.status(201);
      return { test: row, evaluation: ev };
    }),
  );

  api.get('/assets/:id/ees-tests', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, await scopeOfAsset(tx, id), 'read');
      return (await tx.query('SELECT * FROM ees_test WHERE asset_id = $1 ORDER BY performed_at DESC', [id])).rows;
    }),
  );

  /** EES dashboard: branch-by-branch ATS status and generator status. */
  api.get('/projects/:id/ees/summary', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const assets = (await tx.query<{
        id: string; tag: string; asset_type: string; attributes: Record<string, unknown>; system_name: string;
        last_type: string | null; last_at: Date | null; last_overall: string | null; last_readings: Record<string, unknown> | null; last_ls: boolean | null;
      }>(
        `SELECT a.id, a.tag, a.asset_type, a.attributes, s.name AS system_name,
                t.test_type AS last_type, t.performed_at AS last_at, t.overall AS last_overall, t.readings AS last_readings, t.life_safety_failure AS last_ls
           FROM asset a JOIN system s ON s.id = a.system_id
           LEFT JOIN LATERAL (SELECT * FROM ees_test e WHERE e.asset_id = a.id ORDER BY performed_at DESC, recorded_at DESC LIMIT 1) t ON true
          WHERE s.project_id = $1 AND a.asset_type IN ('ats','generator') ORDER BY a.tag`,
        [id],
      )).rows;
      const ats = assets.filter((a) => a.asset_type === 'ats').map((a) => ({
        id: a.id, tag: a.tag, branch: String(a.attributes.branch ?? 'unassigned'), servedPanel: a.attributes.served_panel ?? null,
        lastTestAt: a.last_at, transferTimeS: a.last_readings?.transferTimeS ?? null, result: a.last_overall ?? 'not_tested', lifeSafetyFailure: !!a.last_ls,
      }));
      const openIssues = (await tx.query<{ system_id: string | null; n: string }>(
        `SELECT i.system_id, count(*) AS n FROM issue i JOIN system s ON s.id = i.system_id
          WHERE i.project_id = $1 AND i.status <> 'closed' AND s.system_type LIKE 'ees%' GROUP BY i.system_id`, [id])).rows;
      const branches = EES_BRANCHES.map((br) => {
        const list = ats.filter((a) => a.branch === br.id);
        const passed = list.filter((a) => a.result === 'pass').length;
        return {
          branch: br.id, name: br.name, atsCount: list.length, passed,
          failed: list.filter((a) => a.result === 'fail').length,
          percentPassed: list.length ? Math.round((passed / list.length) * 100) : 0,
          lifeSafetyFailure: list.some((a) => a.lifeSafetyFailure),
        };
      });
      const generators = assets.filter((a) => a.asset_type === 'generator').map((g) => ({
        id: g.id, tag: g.tag, ratingKw: g.attributes.rating_kw ?? null, lastTestType: g.last_type, lastTestAt: g.last_at,
        loadPct: g.last_readings?.loadPct ?? null, durationMin: g.last_readings?.durationMin ?? null, result: g.last_overall ?? 'not_tested',
        nextMonthlyDue: nextMonthlyDue(g.last_type === 'generator_monthly' ? g.last_at : null),
      }));
      return { branches, ats, generators, openIssues: openIssues.reduce((a, r) => a + Number(r.n), 0) };
    }),
  );
}
