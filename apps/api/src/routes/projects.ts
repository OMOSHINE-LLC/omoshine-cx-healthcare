import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { findSpaceType } from '@omoshine/rules';
import { ROLES, scopeOfRoom } from '../access.js';
import { appendAudit } from '../audit.js';
import type { Db, Tx } from '../db.js';
import { HttpError, notFound, projectIdOf, requirePermission, requireTenantAdmin, tenantTx } from '../http.js';

const uuid = z.string().uuid();
const idParam = (req: { params: unknown }) => z.object({ id: uuid }).parse(req.params).id;

async function insert(tx: Tx, table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  const vals = Object.values(row).map((v) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v));
  const r = await tx.query(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    vals,
  );
  return r.rows[0];
}

export async function projectRoutes(api: FastifyInstance, db: Db) {
  api.get('/projects', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const r = await tx.query(
        `SELECT DISTINCT pr.* FROM project pr
          LEFT JOIN role_assignment ra ON ra.project_id = pr.id AND ra.user_id = $1
          WHERE ra.id IS NOT NULL OR (SELECT is_tenant_admin FROM app_user WHERE id = $1)
          ORDER BY pr.name`,
        [p.userId],
      );
      return r.rows;
    }),
  );

  api.post('/projects', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      await requireTenantAdmin(tx, p);
      const b = z
        .object({
          name: z.string().min(1),
          facilityName: z.string().min(1),
          stateCode: z.string().length(2).transform((s) => s.toUpperCase()),
          accreditor: z.enum(['TJC', 'DNV', 'HFAP', 'NONE']).default('TJC'),
          projectType: z.enum(['new', 'expansion', 'renovation']).default('renovation'),
          occupiedBuilding: z.boolean().default(true),
          adoptedCodes: z.array(z.object({ code: z.string(), edition: z.string(), source: z.string() })).optional(),
          creatorRole: z.enum(ROLES).default('cxa'),
        })
        .parse(req.body);
      // Every Medicare-certified hospital is held to the CMS-adopted editions in addition to local codes.
      const adopted = b.adoptedCodes ?? [
        { code: 'NFPA 101', edition: '2012', source: 'CMS' },
        { code: 'NFPA 99', edition: '2012', source: 'CMS' },
        { code: 'ASHRAE 170', edition: '2021', source: 'Local/FGI' },
        { code: 'NFPA 110', edition: '2022', source: 'Local' },
      ];
      const project = await insert(tx, 'project', {
        tenant_id: p.tenantId, name: b.name, facility_name: b.facilityName, state_code: b.stateCode, accreditor: b.accreditor,
        project_type: b.projectType, occupied_building: b.occupiedBuilding, adopted_codes: adopted, created_by: p.userId,
      });
      await insert(tx, 'role_assignment', { tenant_id: p.tenantId, user_id: p.userId, project_id: project.id, role: b.creatorRole, scope_type: 'project', scope_id: project.id });
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'project.create', entityType: 'project', entityId: project.id, data: b });
      reply.status(201);
      return project;
    }),
  );

  api.get('/projects/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const id = idParam(req);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const r = await tx.query('SELECT * FROM project WHERE id = $1', [id]);
      if (!r.rows[0]) throw notFound('Project');
      return r.rows[0];
    }),
  );

  api.get('/projects/:id/tree', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const id = idParam(req);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const q = async (sql: string) => (await tx.query(sql, [id])).rows;
      const [buildings, phases, floors, departments, rooms, systems, assets] = await Promise.all([
        q('SELECT * FROM building WHERE project_id = $1 ORDER BY name'),
        q('SELECT * FROM phase WHERE project_id = $1 ORDER BY sequence'),
        q('SELECT f.* FROM floor f JOIN building b ON b.id = f.building_id WHERE b.project_id = $1 ORDER BY f.level'),
        q('SELECT d.* FROM department d JOIN floor f ON f.id = d.floor_id JOIN building b ON b.id = f.building_id WHERE b.project_id = $1 ORDER BY d.name'),
        q(`SELECT rm.*, (SELECT overall FROM room_measurement m WHERE m.room_id = rm.id ORDER BY measured_at DESC, recorded_at DESC LIMIT 1) AS latest_overall
             FROM room rm JOIN department d ON d.id = rm.department_id JOIN floor f ON f.id = d.floor_id JOIN building b ON b.id = f.building_id
            WHERE b.project_id = $1 ORDER BY rm.number`),
        q('SELECT * FROM system WHERE project_id = $1 ORDER BY name'),
        q('SELECT a.* FROM asset a JOIN system s ON s.id = a.system_id WHERE s.project_id = $1 ORDER BY a.tag'),
      ]);
      return { buildings, phases, floors, departments, rooms, systems, assets };
    }),
  );

  // --- Hierarchy creation ---------------------------------------------------
  const nameBody = z.object({ name: z.string().min(1) });

  api.post('/projects/:id/buildings', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const id = idParam(req);
      await requirePermission(tx, p, { projectId: id }, 'hierarchy.edit');
      const b = nameBody.extend({ constructionType: z.string().optional() }).parse(req.body);
      reply.status(201);
      return insert(tx, 'building', { tenant_id: p.tenantId, project_id: id, name: b.name, construction_type: b.constructionType ?? null });
    }),
  );

  api.post('/projects/:id/phases', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const id = idParam(req);
      await requirePermission(tx, p, { projectId: id }, 'hierarchy.edit');
      const b = nameBody.extend({ sequence: z.number().int().default(1), targetOccupancyDate: z.string().date().optional() }).parse(req.body);
      reply.status(201);
      return insert(tx, 'phase', { tenant_id: p.tenantId, project_id: id, name: b.name, sequence: b.sequence, target_occupancy_date: b.targetOccupancyDate ?? null });
    }),
  );

  api.post('/buildings/:id/floors', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const id = idParam(req);
      await requirePermission(tx, p, { projectId: await projectIdOf(tx, 'building', id) }, 'hierarchy.edit');
      const b = nameBody.extend({ level: z.number().int().default(1) }).parse(req.body);
      reply.status(201);
      return insert(tx, 'floor', { tenant_id: p.tenantId, building_id: id, name: b.name, level: b.level });
    }),
  );

  api.post('/floors/:id/departments', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const id = idParam(req);
      const f = await tx.query<{ project_id: string }>('SELECT b.project_id FROM floor f JOIN building b ON b.id = f.building_id WHERE f.id = $1', [id]);
      if (!f.rows[0]) throw notFound('Floor');
      await requirePermission(tx, p, { projectId: f.rows[0].project_id }, 'hierarchy.edit');
      const b = nameBody.extend({ phaseId: uuid.optional(), clinicalService: z.string().optional() }).parse(req.body);
      reply.status(201);
      return insert(tx, 'department', { tenant_id: p.tenantId, floor_id: id, name: b.name, phase_id: b.phaseId ?? null, clinical_service: b.clinicalService ?? null });
    }),
  );

  api.post('/departments/:id/rooms', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const id = idParam(req);
      const d = await tx.query<{ project_id: string; phase_id: string | null }>(
        'SELECT b.project_id, d.phase_id FROM department d JOIN floor f ON f.id = d.floor_id JOIN building b ON b.id = f.building_id WHERE d.id = $1',
        [id],
      );
      if (!d.rows[0]) throw notFound('Department');
      await requirePermission(tx, p, { projectId: d.rows[0].project_id, departmentId: id, phaseId: d.rows[0].phase_id }, 'hierarchy.edit');
      const b = z
        .object({
          number: z.string().min(1),
          name: z.string().min(1),
          spaceTypeId: z.string(),
          areaSqft: z.number().positive().optional(),
          volumeCuft: z.number().positive(),
          phaseId: uuid.optional(),
          design: z.record(z.number()).optional(),
        })
        .parse(req.body);
      if (!findSpaceType(b.spaceTypeId)) throw new HttpError(400, `Unknown space type ${b.spaceTypeId}`, 'validation');
      reply.status(201);
      return insert(tx, 'room', {
        tenant_id: p.tenantId, department_id: id, number: b.number, name: b.name, space_type_id: b.spaceTypeId,
        area_sqft: b.areaSqft ?? null, volume_cuft: b.volumeCuft, phase_id: b.phaseId ?? d.rows[0].phase_id, design: b.design ?? {},
      });
    }),
  );

  api.post('/projects/:id/systems', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const id = idParam(req);
      await requirePermission(tx, p, { projectId: id }, 'hierarchy.edit');
      const b = nameBody.extend({ discipline: z.string().default('mechanical'), systemType: z.string().min(1) }).parse(req.body);
      reply.status(201);
      return insert(tx, 'system', { tenant_id: p.tenantId, project_id: id, name: b.name, discipline: b.discipline, system_type: b.systemType });
    }),
  );

  api.post('/systems/:id/assets', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const id = idParam(req);
      await requirePermission(tx, p, { projectId: await projectIdOf(tx, 'system', id), systemId: id }, 'hierarchy.edit');
      const b = z
        .object({
          tag: z.string().min(1), assetType: z.string().min(1), roomId: uuid.optional(), manufacturer: z.string().optional(),
          model: z.string().optional(), serial: z.string().optional(), attributes: z.record(z.unknown()).default({}),
        })
        .parse(req.body);
      reply.status(201);
      return insert(tx, 'asset', {
        tenant_id: p.tenantId, system_id: id, room_id: b.roomId ?? null, tag: b.tag, asset_type: b.assetType,
        manufacturer: b.manufacturer ?? null, model: b.model ?? null, serial: b.serial ?? null, attributes: b.attributes,
      });
    }),
  );

  api.post('/systems/:id/rooms', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const id = idParam(req);
      await requirePermission(tx, p, { projectId: await projectIdOf(tx, 'system', id), systemId: id }, 'hierarchy.edit');
      const b = z.object({ roomId: uuid }).parse(req.body);
      reply.status(201);
      return insert(tx, 'system_room', { tenant_id: p.tenantId, system_id: id, room_id: b.roomId });
    }),
  );

  api.get('/qr/:code', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { code } = z.object({ code: z.string().min(6) }).parse(req.params);
      const room = await tx.query<{ id: string }>('SELECT id, number, name FROM room WHERE qr_code = $1', [code]);
      if (room.rows[0]) {
        await requirePermission(tx, p, await scopeOfRoom(tx, room.rows[0].id), 'read');
        return { type: 'room', ...room.rows[0] };
      }
      const asset = await tx.query<{ id: string; project_id: string; system_id: string }>(
        'SELECT a.id, a.tag, a.asset_type, a.system_id, s.project_id FROM asset a JOIN system s ON s.id = a.system_id WHERE a.qr_code = $1',
        [code],
      );
      if (asset.rows[0]) {
        await requirePermission(tx, p, { projectId: asset.rows[0].project_id, systemId: asset.rows[0].system_id }, 'read');
        return { type: 'asset', ...asset.rows[0] };
      }
      throw notFound('QR code');
    }),
  );

  // --- Access -----------------------------------------------------------------
  api.get('/projects/:id/role-assignments', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const id = idParam(req);
      await requirePermission(tx, p, { projectId: id }, 'read');
      return (await tx.query(
        'SELECT ra.*, u.name AS user_name, u.email FROM role_assignment ra JOIN app_user u ON u.id = ra.user_id WHERE ra.project_id = $1 ORDER BY u.name',
        [id],
      )).rows;
    }),
  );

  api.post('/projects/:id/role-assignments', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const id = idParam(req);
      await requirePermission(tx, p, { projectId: id }, 'project.manage');
      const b = z
        .object({ userId: uuid, role: z.enum(ROLES), scopeType: z.enum(['project', 'phase', 'department', 'system']).default('project'), scopeId: uuid.optional() })
        .parse(req.body);
      const row = await insert(tx, 'role_assignment', {
        tenant_id: p.tenantId, user_id: b.userId, project_id: id, role: b.role, scope_type: b.scopeType, scope_id: b.scopeId ?? id,
      });
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'access.grant', entityType: 'role_assignment', entityId: row.id, data: b });
      reply.status(201);
      return row;
    }),
  );

  // --- Project / AHJ requirement overlays ---------------------------------------
  api.get('/projects/:id/overlays', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const id = idParam(req);
      await requirePermission(tx, p, { projectId: id }, 'read');
      return (await tx.query('SELECT * FROM project_overlay WHERE project_id = $1 ORDER BY created_at', [id])).rows;
    }),
  );

  api.post('/projects/:id/overlays', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const id = idParam(req);
      await requirePermission(tx, p, { projectId: id }, 'project.manage');
      const b = z
        .object({
          action: z.enum(['replace', 'add', 'disable']),
          requirementKey: z.string().min(1),
          requirement: z.record(z.unknown()).optional(),
          effectiveDate: z.string().date(),
          sourceNote: z.string().min(3),
          verified: z.boolean().default(false),
        })
        .parse(req.body);
      const row = await insert(tx, 'project_overlay', {
        tenant_id: p.tenantId, project_id: id, action: b.action, requirement_key: b.requirementKey, requirement: b.requirement ?? null,
        effective_date: b.effectiveDate, source_note: b.sourceNote, verified: b.verified,
      });
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'overlay.create', entityType: 'project_overlay', entityId: row.id, data: b });
      reply.status(201);
      return row;
    }),
  );

  // --- Readiness dashboard ------------------------------------------------------
  api.get('/projects/:id/readiness', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const id = idParam(req);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const tests = await tx.query<{ status: string; result: string | null; n: string }>(
        `SELECT status, result, count(*) AS n FROM test_run WHERE project_id = $1 AND status <> 'superseded' GROUP BY status, result`, [id]);
      const issues = await tx.query<{ status: string; life_safety: boolean; n: string }>(
        'SELECT status, life_safety, count(*) AS n FROM issue WHERE project_id = $1 GROUP BY status, life_safety', [id]);
      const rooms = await tx.query<{ phase_id: string | null; phase_name: string | null; overall: string | null; n: string }>(
        `SELECT rm.phase_id, ph.name AS phase_name, ph.sequence, latest.overall, count(*) AS n
           FROM room rm
           JOIN department d ON d.id = rm.department_id JOIN floor f ON f.id = d.floor_id JOIN building b ON b.id = f.building_id
           LEFT JOIN phase ph ON ph.id = rm.phase_id
           LEFT JOIN LATERAL (SELECT overall FROM room_measurement m WHERE m.room_id = rm.id ORDER BY measured_at DESC, recorded_at DESC LIMIT 1) latest ON true
          WHERE b.project_id = $1 GROUP BY rm.phase_id, ph.name, ph.sequence, latest.overall
          ORDER BY ph.sequence NULLS LAST`, [id]);
      const n = (s: string) => Number(s);
      const testTotal = tests.rows.reduce((a, r) => a + n(r.n), 0);
      const testSigned = tests.rows.filter((r) => r.status === 'signed').reduce((a, r) => a + n(r.n), 0);
      const roomByPhase = new Map<string, { phaseId: string | null; phase: string; pass: number; fail: number; incomplete: number; notTested: number }>();
      for (const r of rooms.rows) {
        const k = r.phase_id ?? 'none';
        const e = roomByPhase.get(k) ?? { phaseId: r.phase_id, phase: r.phase_name ?? 'Unphased', pass: 0, fail: 0, incomplete: 0, notTested: 0 };
        if (r.overall === 'pass') e.pass += n(r.n);
        else if (r.overall === 'fail') e.fail += n(r.n);
        else if (r.overall === 'incomplete') e.incomplete += n(r.n);
        else e.notTested += n(r.n);
        roomByPhase.set(k, e);
      }
      return {
        tests: { total: testTotal, signed: testSigned, failed: tests.rows.filter((r) => r.result === 'fail').reduce((a, r) => a + n(r.n), 0), percentSigned: testTotal ? Math.round((testSigned / testTotal) * 100) : 0 },
        issues: {
          open: issues.rows.filter((r) => r.status !== 'closed').reduce((a, r) => a + n(r.n), 0),
          closed: issues.rows.filter((r) => r.status === 'closed').reduce((a, r) => a + n(r.n), 0),
          openLifeSafety: issues.rows.filter((r) => r.status !== 'closed' && r.life_safety).reduce((a, r) => a + n(r.n), 0),
        },
        roomsByPhase: [...roomByPhase.values()],
      };
    }),
  );
}
