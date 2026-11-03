import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_ILSM_POLICY,
  DEFICIENCY_TYPES,
  ILSM_MEASURES,
  controlsForClass,
  effectiveIcraClass,
  evaluateIcraLog,
  fireWatchGaps,
  requiredIlsmMeasures,
  type DeficiencyType,
  type IcraClass,
} from '@omoshine/rules';
import { SIGNATURE_MEANINGS, type Role } from '../access.js';
import { appendAudit } from '../audit.js';
import { verifyReauthToken } from '../auth.js';
import { canonicalJson, sha256 } from '../crypto.js';
import type { Db, Tx } from '../db.js';
import { HttpError, forbidden, notFound, requirePermission, tenantTx } from '../http.js';

const uuid = z.string().uuid();
const LOG_DAYS = 30;

interface ZoneRow {
  id: string; project_id: string; department_id: string | null; name: string; construction_type: 'A' | 'B' | 'C' | 'D';
  risk_group: 'low' | 'medium' | 'high' | 'highest'; class_override: IcraClass | null; icra_class: IcraClass; barrier_type: string | null;
  adjacent_areas: string; min_negative_pressure_in_wc: string | null; active: boolean; starts_on: string | null; ends_on: string | null;
}

async function loadZone(tx: Tx, id: string): Promise<ZoneRow> {
  const r = await tx.query<ZoneRow>('SELECT * FROM icra_zone WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound('ICRA zone');
  return r.rows[0];
}

const zoneScope = (z: ZoneRow) => ({ projectId: z.project_id, departmentId: z.department_id });

/** The content an Infection Prevention permit signature binds to. Any change requires a new sign-off. */
export function zoneDigest(z: ZoneRow): string {
  return sha256(canonicalJson({
    id: z.id, name: z.name, construction_type: z.construction_type, risk_group: z.risk_group, class_override: z.class_override,
    icra_class: z.icra_class, barrier_type: z.barrier_type, adjacent_areas: z.adjacent_areas,
    min_negative_pressure_in_wc: z.min_negative_pressure_in_wc === null ? null : Number(z.min_negative_pressure_in_wc),
  }));
}

async function approvalOf(tx: Tx, z: ZoneRow) {
  const sigs = (await tx.query<{ signer_name: string; signed_at: Date; record_sha256: string; signer_role: string }>(
    `SELECT signer_name, signed_at, record_sha256, signer_role FROM signature WHERE record_type = 'icra_zone' AND record_id = $1 ORDER BY signed_at DESC`, [z.id])).rows;
  const digest = zoneDigest(z);
  const current = sigs.find((s) => s.record_sha256 === digest && s.signer_role === 'infection_prevention');
  return current
    ? { status: 'approved' as const, by: current.signer_name, at: current.signed_at }
    : { status: sigs.length ? ('reapproval_required' as const) : ('pending' as const), by: null, at: null };
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

const zoneBody = z.object({
  name: z.string().min(1),
  departmentId: uuid.optional(),
  constructionType: z.enum(['A', 'B', 'C', 'D']),
  riskGroup: z.enum(['low', 'medium', 'high', 'highest']),
  classOverride: z.enum(['I', 'II', 'III', 'IV']).nullable().optional(),
  barrierType: z.string().optional(),
  adjacentAreas: z.string().default(''),
  minNegativePressureInWc: z.number().positive().max(0.1).nullable().optional(),
  startsOn: z.string().date().optional(),
  endsOn: z.string().date().optional(),
});

export async function icraRoutes(api: FastifyInstance, db: Db) {
  // --- ICRA zones -------------------------------------------------------------------
  api.post('/projects/:id/icra-zones', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = zoneBody.parse(req.body);
      await requirePermission(tx, p, { projectId: id, departmentId: b.departmentId }, 'icra.manage');
      const icraClass = effectiveIcraClass(b.constructionType, b.riskGroup, b.classOverride);
      const zone = (await tx.query<ZoneRow>(
        `INSERT INTO icra_zone (tenant_id, project_id, department_id, name, construction_type, risk_group, class_override, icra_class,
                                barrier_type, adjacent_areas, min_negative_pressure_in_wc, starts_on, ends_on, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [p.tenantId, id, b.departmentId ?? null, b.name, b.constructionType, b.riskGroup, b.classOverride ?? null, icraClass,
          b.barrierType ?? null, b.adjacentAreas, b.minNegativePressureInWc ?? null, b.startsOn ?? null, b.endsOn ?? null, p.userId],
      )).rows[0]!;
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'icra.zone.create', entityType: 'icra_zone', entityId: zone.id, data: { ...b, icraClass } });
      reply.status(201);
      return { ...zone, controls: controlsForClass(icraClass), approval: await approvalOf(tx, zone) };
    }),
  );

  api.get('/projects/:id/icra-zones', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const zones = (await tx.query<ZoneRow & { department_name: string | null }>(
        `SELECT z.*, d.name AS department_name FROM icra_zone z LEFT JOIN department d ON d.id = z.department_id
          WHERE z.project_id = $1 ORDER BY z.active DESC, z.name`, [id])).rows;
      const since = new Date(Date.now() - (LOG_DAYS - 1) * 864e5);
      since.setUTCHours(0, 0, 0, 0);
      const logs = (await tx.query<{ zone_id: string; day: string; worst: string }>(
        `SELECT zone_id, to_char(logged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                CASE WHEN bool_or(overall = 'fail') THEN 'fail' WHEN bool_or(overall = 'incomplete') THEN 'incomplete' ELSE 'pass' END AS worst
           FROM icra_log WHERE zone_id = ANY($1) AND logged_at >= $2 GROUP BY zone_id, day`,
        [zones.map((z) => z.id), since])).rows;
      const today = dayKey(new Date());
      const days = Array.from({ length: LOG_DAYS }, (_, i) => dayKey(new Date(since.getTime() + i * 864e5)));
      const out = [];
      for (const zone of zones) {
        const byDay = new Map(logs.filter((l) => l.zone_id === zone.id).map((l) => [l.day, l.worst]));
        out.push({
          ...zone,
          approval: await approvalOf(tx, zone),
          today: byDay.get(today) ?? (zone.active ? 'missing' : 'inactive'),
          history: days.map((d) => ({ date: d, status: byDay.get(d) ?? 'missing' })),
        });
      }
      return out;
    }),
  );

  api.get('/icra-zones/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const zone = await loadZone(tx, id);
      await requirePermission(tx, p, zoneScope(zone), 'read');
      const logs = (await tx.query(
        `SELECT l.*, u.name AS recorded_by_name FROM icra_log l JOIN app_user u ON u.id = l.recorded_by
          WHERE l.zone_id = $1 ORDER BY l.logged_at DESC LIMIT 60`, [id])).rows;
      return { ...zone, controls: controlsForClass(zone.icra_class), approval: await approvalOf(tx, zone), logs };
    }),
  );

  api.patch('/icra-zones/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = zoneBody.partial().extend({ active: z.boolean().optional() }).parse(req.body);
      const zone = await loadZone(tx, id);
      await requirePermission(tx, p, zoneScope(zone), 'icra.manage');
      const next = {
        name: b.name ?? zone.name,
        construction_type: b.constructionType ?? zone.construction_type,
        risk_group: b.riskGroup ?? zone.risk_group,
        class_override: b.classOverride !== undefined ? b.classOverride : zone.class_override,
        barrier_type: b.barrierType ?? zone.barrier_type,
        adjacent_areas: b.adjacentAreas ?? zone.adjacent_areas,
        min_negative_pressure_in_wc: b.minNegativePressureInWc !== undefined ? b.minNegativePressureInWc : zone.min_negative_pressure_in_wc,
        active: b.active ?? zone.active,
      };
      const icraClass = effectiveIcraClass(next.construction_type, next.risk_group, next.class_override);
      const updated = (await tx.query<ZoneRow>(
        `UPDATE icra_zone SET name=$2, construction_type=$3, risk_group=$4, class_override=$5, icra_class=$6, barrier_type=$7,
                adjacent_areas=$8, min_negative_pressure_in_wc=$9, active=$10 WHERE id=$1 RETURNING *`,
        [id, next.name, next.construction_type, next.risk_group, next.class_override, icraClass, next.barrier_type, next.adjacent_areas,
          next.min_negative_pressure_in_wc, next.active],
      )).rows[0]!;
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'icra.zone.update', entityType: 'icra_zone', entityId: id, data: { ...b, icraClass } });
      return { ...updated, approval: await approvalOf(tx, updated) };
    }),
  );

  /** Infection Prevention sign-off on the zone's ICRA permit (e-signature with re-authentication). */
  api.post('/icra-zones/:id/approve', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const token = req.headers['x-reauth-token'];
      if (typeof token !== 'string') throw new HttpError(401, 'Re-authentication required to sign', 'reauth_required');
      let method: string;
      try { method = (await verifyReauthToken(token, p.userId)).method; } catch { throw new HttpError(401, 'Re-authentication expired; sign in again to sign', 'reauth_required'); }
      const zone = await loadZone(tx, id);
      const roles = await requirePermission(tx, p, zoneScope(zone), 'icra.approve');
      const role = roles.find((r: Role) => r === 'infection_prevention' && SIGNATURE_MEANINGS[r].includes('approved'));
      if (!role) throw forbidden('Only Infection Prevention can approve an ICRA permit');
      const digest = zoneDigest(zone);
      const user = (await tx.query<{ name: string }>('SELECT name FROM app_user WHERE id = $1', [p.userId])).rows[0]!;
      const meaning = 'approved';
      const sig = (await tx.query(
        `INSERT INTO signature (tenant_id, record_type, record_id, record_sha256, signer_id, signer_name, signer_role, meaning, reauth_method)
         VALUES ($1,'icra_zone',$2,$3,$4,$5,'infection_prevention',$6,$7) RETURNING *`,
        [p.tenantId, id, digest, p.userId, user.name, meaning, method],
      )).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'icra.zone.approve', entityType: 'icra_zone', entityId: id, data: { digest, icraClass: zone.icra_class } });
      reply.status(201);
      return sig;
    }),
  );

  /** Daily ICRA log (quick entry). Failed logs open an issue automatically. */
  api.post('/icra-zones/:id/logs', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z
        .object({
          loggedAt: z.string().datetime({ offset: true }).optional(),
          controls: z.record(z.boolean()),
          pressureDiffInWc: z.number().min(-1).max(1).optional(),
          correctiveAction: z.string().max(4000).optional(),
        })
        .parse(req.body);
      const zone = await loadZone(tx, id);
      await requirePermission(tx, p, zoneScope(zone), 'icra.log');
      if (!zone.active) throw new HttpError(409, 'Zone is closed', 'conflict');
      const ev = evaluateIcraLog({
        icraClass: zone.icra_class,
        controls: b.controls,
        pressureDiffInWc: b.pressureDiffInWc,
        minNegativePressureInWc: zone.min_negative_pressure_in_wc === null ? null : Number(zone.min_negative_pressure_in_wc),
      });
      const log = (await tx.query(
        `INSERT INTO icra_log (tenant_id, zone_id, logged_at, icra_class, readings, evaluation, overall, corrective_action, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [p.tenantId, id, b.loggedAt ?? new Date().toISOString(), zone.icra_class, JSON.stringify({ controls: b.controls, pressureDiffInWc: b.pressureDiffInWc ?? null }),
          JSON.stringify(ev.results), ev.overall, b.correctiveAction ?? null, p.userId],
      )).rows[0];
      let issueId: string | null = null;
      if (ev.overall === 'fail') {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`issue:${zone.project_id}`]);
        const next = (await tx.query<{ n: number }>('SELECT COALESCE(max(number), 0) + 1 AS n FROM issue WHERE project_id = $1', [zone.project_id])).rows[0]!.n;
        const failed = ev.results.filter((r) => r.status === 'fail').map((r) => `- ${r.label}${r.reason ? `: ${r.reason}` : ''}`).join('\n');
        issueId = (await tx.query<{ id: string }>(
          `INSERT INTO issue (tenant_id, project_id, number, title, description, priority, life_safety, created_by)
           VALUES ($1,$2,$3,$4,$5,'high',false,$6) RETURNING id`,
          [p.tenantId, zone.project_id, next, `ICRA ${zone.name}: daily inspection failed (Class ${zone.icra_class})`,
            `${failed}${b.correctiveAction ? `\n\nCorrective action: ${b.correctiveAction}` : ''}`, p.userId],
        )).rows[0]!.id;
        await tx.query(`INSERT INTO issue_event (tenant_id, issue_id, kind, payload, actor_id) VALUES ($1,$2,'created',$3,$4)`,
          [p.tenantId, issueId, JSON.stringify({ source: 'icra_log', logId: log.id }), p.userId]);
      }
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'icra.log', entityType: 'icra_zone', entityId: id, data: { logId: log.id, overall: ev.overall, issueId } });
      reply.status(201);
      return { log, evaluation: ev, issueId };
    }),
  );

  // --- ILSM -------------------------------------------------------------------------
  api.get('/ilsm/catalog', async () => ({ deficiencyTypes: DEFICIENCY_TYPES, measures: ILSM_MEASURES, policy: DEFAULT_ILSM_POLICY }));

  api.post('/projects/:id/ilsm-assessments', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z
        .object({
          deficiencyType: z.enum(Object.keys(DEFICIENCY_TYPES) as [DeficiencyType, ...DeficiencyType[]]),
          description: z.string().min(3),
          location: z.string().min(1),
          identifiedAt: z.string().datetime({ offset: true }).optional(),
          expectedOutOfServiceHours: z.number().min(0).max(24 * 365),
        })
        .parse(req.body);
      await requirePermission(tx, p, { projectId: id }, 'ilsm.manage');
      const required = requiredIlsmMeasures(b.deficiencyType, b.expectedOutOfServiceHours);
      const a = (await tx.query(
        `INSERT INTO ilsm_assessment (tenant_id, project_id, deficiency_type, description, location, identified_at, expected_out_of_service_hours, required_measures, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [p.tenantId, id, b.deficiencyType, b.description, b.location, b.identifiedAt ?? new Date().toISOString(), b.expectedOutOfServiceHours, JSON.stringify(required), p.userId],
      )).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'ilsm.assess', entityType: 'ilsm_assessment', entityId: a.id, data: { ...b, required } });
      reply.status(201);
      return a;
    }),
  );

  async function assessmentDetail(tx: Tx, a: { id: string; identified_at: Date; status: string; resolved_at: Date | null; required_measures: string[] }) {
    const patrols = (await tx.query<{ patrolled_at: Date }>(
      `SELECT f.*, u.name AS recorded_by_name FROM fire_watch_log f JOIN app_user u ON u.id = f.recorded_by WHERE assessment_id = $1 ORDER BY patrolled_at`, [a.id])).rows;
    const fireWatch = a.required_measures.includes('fire_watch');
    const end = a.status === 'resolved' && a.resolved_at ? a.resolved_at : new Date();
    const gaps = fireWatch ? fireWatchGaps(a.identified_at.toISOString(), patrols.map((x) => x.patrolled_at.toISOString()), end.toISOString()) : [];
    return { ...a, fireWatchRequired: fireWatch, patrols, gaps, patrolIntervalMin: DEFAULT_ILSM_POLICY.patrolIntervalMin };
  }

  api.get('/projects/:id/ilsm-assessments', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const rows = (await tx.query('SELECT * FROM ilsm_assessment WHERE project_id = $1 ORDER BY status, identified_at DESC', [id])).rows;
      return Promise.all(rows.map((a) => assessmentDetail(tx, a)));
    }),
  );

  async function loadAssessment(tx: Tx, id: string) {
    const r = await tx.query('SELECT * FROM ilsm_assessment WHERE id = $1', [id]);
    if (!r.rows[0]) throw notFound('ILSM assessment');
    return r.rows[0];
  }

  api.patch('/ilsm-assessments/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ implementedMeasures: z.array(z.string()).optional(), status: z.enum(['resolved']).optional() }).parse(req.body);
      const a = await loadAssessment(tx, id);
      await requirePermission(tx, p, { projectId: a.project_id }, 'ilsm.manage');
      const implemented: string[] = b.implementedMeasures ?? a.implemented_measures;
      for (const m of implemented) if (!(m in ILSM_MEASURES)) throw new HttpError(400, `Unknown measure ${m}`, 'validation');
      if (b.status === 'resolved') {
        const missing = (a.required_measures as string[]).filter((m) => !implemented.includes(m));
        if (missing.length) throw new HttpError(400, `Required measures not documented as implemented: ${missing.join(', ')}`, 'incomplete');
      }
      const updated = (await tx.query(
        `UPDATE ilsm_assessment SET implemented_measures = $2, status = COALESCE($3, status), resolved_at = CASE WHEN $3 = 'resolved' THEN now() ELSE resolved_at END
          WHERE id = $1 RETURNING *`, [id, JSON.stringify(implemented), b.status ?? null])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'ilsm.update', entityType: 'ilsm_assessment', entityId: id, data: b });
      return assessmentDetail(tx, updated);
    }),
  );

  api.post('/ilsm-assessments/:id/fire-watch', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ patrolledAt: z.string().datetime({ offset: true }).optional(), area: z.string().min(1), allClear: z.boolean(), findings: z.string().max(4000).default('') }).parse(req.body);
      const a = await loadAssessment(tx, id);
      await requirePermission(tx, p, { projectId: a.project_id }, 'firewatch.log');
      if (a.status !== 'open') throw new HttpError(409, 'Assessment is resolved', 'conflict');
      if (!(a.required_measures as string[]).includes('fire_watch')) throw new HttpError(400, 'This assessment does not require a fire watch', 'validation');
      if (!b.allClear && !b.findings.trim()) throw new HttpError(400, 'Describe the findings when the patrol is not all clear', 'validation');
      const row = (await tx.query(
        `INSERT INTO fire_watch_log (tenant_id, assessment_id, patrolled_at, area, all_clear, findings, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [p.tenantId, id, b.patrolledAt ?? new Date().toISOString(), b.area, b.allClear, b.findings, p.userId],
      )).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'ilsm.fire_watch', entityType: 'ilsm_assessment', entityId: id, data: { patrolId: row.id, allClear: b.allClear } });
      reply.status(201);
      return row;
    }),
  );
}
