import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyOverlays, describeRequired, citationFor, evaluateRoom, findSpaceType, requirementsForSpaceType } from '@omoshine/rules';
import { scopeOfRoom } from '../access.js';
import { appendAudit } from '../audit.js';
import type { Db, Tx } from '../db.js';
import { HttpError, notFound, overlaysForProject, requirePermission, tenantTx } from '../http.js';

const uuid = z.string().uuid();

export const measurementSchema = z.object({
  source: z.enum(['tab', 'bas', 'manual']).default('manual'),
  measuredAt: z.string().datetime({ offset: true }).optional(),
  supplyCfm: z.number().nonnegative().optional(),
  returnCfm: z.number().nonnegative().optional(),
  exhaustCfm: z.number().nonnegative().optional(),
  oaCfm: z.number().nonnegative().optional(),
  pressureDiffInWc: z.number().min(-1).max(1).optional(),
  tempF: z.number().min(30).max(120).optional(),
  rhPct: z.number().min(0).max(100).optional(),
  allExhaust: z.boolean().optional(),
  recircRoomUnits: z.boolean().optional(),
});
export type MeasurementInput = z.infer<typeof measurementSchema>;

interface RoomRow { id: string; number: string; name: string; space_type_id: string; volume_cuft: string; department_id: string }

async function loadRoom(tx: Tx, id: string): Promise<RoomRow> {
  const r = await tx.query<RoomRow>('SELECT * FROM room WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound('Room');
  return r.rows[0];
}

/** Evaluate and store one measurement. Shared by manual entry and TAB import. */
export async function recordMeasurement(tx: Tx, tenantId: string, userId: string, room: RoomRow, projectId: string, m: MeasurementInput) {
  const { source, measuredAt, ...readings } = m;
  const ev = evaluateRoom({
    spaceTypeId: room.space_type_id,
    volumeCuft: Number(room.volume_cuft),
    measurement: readings,
    overlays: await overlaysForProject(tx, projectId),
  });
  const row = (await tx.query(
    `INSERT INTO room_measurement (tenant_id, room_id, source, measured_at, readings, evaluation, overall, life_safety_failure, engine_version, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [tenantId, room.id, source, measuredAt ?? new Date().toISOString(), JSON.stringify(readings),
      JSON.stringify({ results: ev.results, computed: ev.computed }), ev.overall, ev.lifeSafetyFailure, ev.engineVersion, userId],
  )).rows[0];
  await appendAudit(tx, tenantId, { actorId: userId, action: 'room.measure', entityType: 'room', entityId: room.id, data: { measurementId: row.id, overall: ev.overall, source } });
  return { measurement: row, evaluation: ev };
}

/** Minimal CSV parser supporting quoted fields. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '', row: string[] = [], quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const num = (s: string | undefined) => (s === undefined || s === '' ? undefined : Number(s));
const bool = (s: string | undefined) => (s === undefined || s === '' ? undefined : /^(true|yes|y|1)$/i.test(s));

export async function roomRoutes(api: FastifyInstance, db: Db) {
  api.get('/rooms/:id/data-sheet', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const scope = await scopeOfRoom(tx, id);
      await requirePermission(tx, p, scope, 'read');
      const room = (await tx.query(
        `SELECT rm.*, d.name AS department_name, ph.name AS phase_name, pr.state_code, pr.name AS project_name, pr.facility_name
           FROM room rm JOIN department d ON d.id = rm.department_id JOIN floor f ON f.id = d.floor_id
           JOIN building b ON b.id = f.building_id JOIN project pr ON pr.id = b.project_id
           LEFT JOIN phase ph ON ph.id = rm.phase_id WHERE rm.id = $1`, [id])).rows[0];
      const st = findSpaceType(room.space_type_id)!;
      const requirements = applyOverlays(requirementsForSpaceType(st), await overlaysForProject(tx, scope!.projectId)).map((r) => ({
        key: r.key, parameter: r.parameter, description: r.description, required: describeRequired(r), citation: citationFor(r.sectionId), severity: r.severity, verified: r.verified,
      }));
      const measurements = (await tx.query(
        `SELECT m.*, u.name AS recorded_by_name FROM room_measurement m JOIN app_user u ON u.id = m.recorded_by
          WHERE m.room_id = $1 ORDER BY m.measured_at DESC, m.recorded_at DESC LIMIT 20`, [id])).rows;
      const issues = (await tx.query(
        `SELECT i.id, i.number, i.title, i.status, i.life_safety, i.requirement_key, o.name AS ball_in_court_name
           FROM issue i LEFT JOIN organization o ON o.id = i.ball_in_court_org_id WHERE i.room_id = $1 ORDER BY i.number DESC`, [id])).rows;
      const latest = measurements[0] ?? null;
      return {
        room,
        spaceType: st,
        requirements,
        latest,
        overall: latest?.overall ?? 'not_tested',
        lifeSafetyFailure: latest?.life_safety_failure ?? false,
        history: measurements,
        issues,
      };
    }),
  );

  api.post('/rooms/:id/measurements', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const m = measurementSchema.parse(req.body);
      const scope = await scopeOfRoom(tx, id);
      await requirePermission(tx, p, scope, 'measurement.record');
      const out = await recordMeasurement(tx, p.tenantId, p.userId, await loadRoom(tx, id), scope!.projectId, m);
      reply.status(201);
      return out;
    }),
  );

  /** Compliance grid: every room with its latest result. */
  api.get('/projects/:id/room-compliance', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const q = z.object({ status: z.enum(['pass', 'fail', 'incomplete', 'not_tested']).optional(), departmentId: uuid.optional() }).parse(req.query);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const rows = (await tx.query(
        `SELECT rm.id, rm.number, rm.name, rm.space_type_id, d.id AS department_id, d.name AS department_name, ph.name AS phase_name,
                latest.overall, latest.life_safety_failure, latest.evaluation, latest.measured_at
           FROM room rm JOIN department d ON d.id = rm.department_id JOIN floor f ON f.id = d.floor_id JOIN building b ON b.id = f.building_id
           LEFT JOIN phase ph ON ph.id = rm.phase_id
           LEFT JOIN LATERAL (SELECT overall, life_safety_failure, evaluation, measured_at FROM room_measurement m
                               WHERE m.room_id = rm.id ORDER BY measured_at DESC, recorded_at DESC LIMIT 1) latest ON true
          WHERE b.project_id = $1 AND ($2::uuid IS NULL OR d.id = $2) ORDER BY rm.number`,
        [id, q.departmentId ?? null],
      )).rows.map((r) => ({
        ...r,
        overall: r.overall ?? 'not_tested',
        spaceTypeName: findSpaceType(r.space_type_id)?.name,
        parameters: Object.fromEntries(((r.evaluation?.results ?? []) as { parameter: string; status: string; measured: unknown }[]).map((x) => [x.parameter, { status: x.status, measured: x.measured }])),
      }));
      return q.status ? rows.filter((r) => r.overall === q.status) : rows;
    }),
  );

  /**
   * TAB report import (CSV). Columns: room_number, supply_cfm, return_cfm, exhaust_cfm, oa_cfm,
   * pressure_in_wc, temp_f, rh_pct, all_exhaust, recirc_room_units, measured_at.
   * Rows are validated first; nothing is written unless every row is valid.
   */
  api.post('/projects/:id/imports/tab', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ csv: z.string().min(1).max(5_000_000) }).parse(req.body);
      await requirePermission(tx, p, { projectId: id }, 'measurement.record');
      const rows = parseCsv(b.csv);
      if (!rows.length) throw new HttpError(400, 'CSV has no data rows', 'validation');
      if (!('room_number' in rows[0]!)) throw new HttpError(400, 'CSV must include a room_number column', 'validation');
      const rooms = (await tx.query<RoomRow>(
        `SELECT rm.* FROM room rm JOIN department d ON d.id = rm.department_id JOIN floor f ON f.id = d.floor_id
           JOIN building b ON b.id = f.building_id WHERE b.project_id = $1`, [id])).rows;
      const byNumber = new Map(rooms.map((r) => [r.number.toLowerCase(), r]));
      const errors: { row: number; error: string }[] = [];
      const parsed = rows.map((r, i) => {
        const room = byNumber.get((r.room_number ?? '').toLowerCase());
        if (!room) errors.push({ row: i + 2, error: `Unknown room ${r.room_number}` });
        const m = measurementSchema.safeParse({
          source: 'tab',
          measuredAt: r.measured_at ? new Date(r.measured_at).toISOString() : undefined,
          supplyCfm: num(r.supply_cfm), returnCfm: num(r.return_cfm), exhaustCfm: num(r.exhaust_cfm), oaCfm: num(r.oa_cfm),
          pressureDiffInWc: num(r.pressure_in_wc), tempF: num(r.temp_f), rhPct: num(r.rh_pct),
          allExhaust: bool(r.all_exhaust), recircRoomUnits: bool(r.recirc_room_units),
        });
        if (!m.success) errors.push({ row: i + 2, error: m.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
        return { room, m: m.success ? m.data : undefined };
      });
      if (errors.length) {
        reply.status(422);
        return { imported: 0, errors };
      }
      const results = [];
      for (const r of parsed) {
        const out = await recordMeasurement(tx, p.tenantId, p.userId, r.room!, id, r.m!);
        results.push({ roomId: r.room!.id, roomNumber: r.room!.number, overall: out.evaluation.overall, lifeSafetyFailure: out.evaluation.lifeSafetyFailure });
      }
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'import.tab', entityType: 'project', entityId: id, data: { rows: results.length } });
      reply.status(201);
      return { imported: results.length, failed: results.filter((r) => r.overall === 'fail').length, results };
    }),
  );
}
