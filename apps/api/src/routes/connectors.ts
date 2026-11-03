import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MED_GASES, TREND_POINTS, findSpaceType, summarizeTrendPoint, type MedGas, type PointSummary, type TrendPoint } from '@omoshine/rules';
import { appendAudit } from '../audit.js';
import { canonicalJson, decryptSecret, encryptSecret, sha256 } from '../crypto.js';
import { withTenant, type Db, type Tx } from '../db.js';
import { HttpError, notFound, overlaysForProject, requirePermission, tenantTx } from '../http.js';
import { buildRequest, checkConnectorBaseUrl, externalIdFrom, type ConnectionInfo, type Provider, type SyncIssue } from '../connectors.js';
import { parseCsv, recordMeasurement } from './rooms.js';

const uuid = z.string().uuid();

interface RoomRow { id: string; number: string; name: string; space_type_id: string; volume_cuft: string; department_id: string }

// ---------------------------------------------------------------------------
// COBie (Construction Operations Building information exchange) export
// ---------------------------------------------------------------------------

export const COBIE_SHEETS = ['Contact', 'Facility', 'Floor', 'Space', 'Zone', 'Type', 'Component', 'System'] as const;
type Sheet = (typeof COBIE_SHEETS)[number];

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  // Quote when needed; neutralise spreadsheet formula injection.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

async function cobieSheet(tx: Tx, projectId: string, sheet: Sheet): Promise<{ header: string[]; rows: unknown[][] }> {
  const project = (await tx.query('SELECT p.*, u.email AS created_by_email FROM project p LEFT JOIN app_user u ON u.id = p.created_by WHERE p.id = $1', [projectId])).rows[0];
  const by = project.created_by_email ?? 'omoshine@invalid';
  const on = project.created_at;
  switch (sheet) {
    case 'Contact': {
      const rows = (await tx.query(
        `SELECT DISTINCT u.email, u.name, o.name AS org, o.kind FROM role_assignment ra JOIN app_user u ON u.id = ra.user_id
           LEFT JOIN organization o ON o.id = u.organization_id WHERE ra.project_id = $1 AND NOT u.is_service ORDER BY u.email`, [projectId])).rows;
      return { header: ['Email', 'CreatedBy', 'CreatedOn', 'Category', 'Company', 'GivenName', 'FamilyName'],
        rows: rows.map((r) => { const [given, ...rest] = String(r.name).split(' '); return [r.email, by, on, r.kind ?? '', r.org ?? '', given, rest.join(' ')]; }) };
    }
    case 'Facility':
      return { header: ['Name', 'CreatedBy', 'CreatedOn', 'Category', 'ProjectName', 'SiteName', 'LinearUnits', 'AreaUnits', 'Description'],
        rows: [[project.facility_name, by, on, 'Health care', project.name, project.facility_name, 'feet', 'square feet', `State ${project.state_code}; accreditor ${project.accreditor}`]] };
    case 'Floor': {
      const rows = (await tx.query(
        `SELECT f.name, f.level, b.name AS building FROM floor f JOIN building b ON b.id = f.building_id WHERE b.project_id = $1 ORDER BY b.name, f.level`, [projectId])).rows;
      return { header: ['Name', 'CreatedBy', 'CreatedOn', 'Category', 'Description', 'Elevation'], rows: rows.map((r) => [`${r.building} ${r.name}`, by, on, 'Floor', `Level ${r.level}`, '']) };
    }
    case 'Space': {
      const rows = (await tx.query(
        `SELECT rm.number, rm.name, rm.space_type_id, rm.area_sqft, f.name AS floor, b.name AS building
           FROM room rm JOIN department d ON d.id = rm.department_id JOIN floor f ON f.id = d.floor_id JOIN building b ON b.id = f.building_id
          WHERE b.project_id = $1 ORDER BY rm.number`, [projectId])).rows;
      return { header: ['Name', 'CreatedBy', 'CreatedOn', 'Category', 'FloorName', 'Description', 'RoomTag', 'GrossArea'],
        rows: rows.map((r) => [r.number, by, on, findSpaceType(r.space_type_id)?.name ?? r.space_type_id, `${r.building} ${r.floor}`, r.name, r.number, r.area_sqft ?? '']) };
    }
    case 'Zone': {
      const rows = (await tx.query(
        `SELECT d.name AS dept, rm.number FROM room rm JOIN department d ON d.id = rm.department_id JOIN floor f ON f.id = d.floor_id
           JOIN building b ON b.id = f.building_id WHERE b.project_id = $1 ORDER BY d.name, rm.number`, [projectId])).rows;
      const mg = (await tx.query(
        `SELECT z.name, r.number FROM medgas_zone z JOIN medgas_outlet o ON o.zone_id = z.id JOIN room r ON r.id = o.room_id WHERE z.project_id = $1 GROUP BY z.name, r.number ORDER BY z.name, r.number`, [projectId])).rows;
      return { header: ['Name', 'CreatedBy', 'CreatedOn', 'Category', 'SpaceNames'],
        rows: [...rows.map((r) => [r.dept, by, on, 'Department', r.number]), ...mg.map((r) => [r.name, by, on, 'Medical gas zone', r.number])] };
    }
    case 'Type': {
      const rows = (await tx.query(
        `SELECT DISTINCT a.asset_type, a.manufacturer, a.model FROM asset a JOIN system s ON s.id = a.system_id WHERE s.project_id = $1 ORDER BY 1, 2, 3`, [projectId])).rows;
      return { header: ['Name', 'CreatedBy', 'CreatedOn', 'Category', 'Manufacturer', 'ModelNumber'],
        rows: rows.map((r) => [[r.asset_type, r.manufacturer, r.model].filter(Boolean).join(' '), by, on, r.asset_type, r.manufacturer ?? '', r.model ?? '']) };
    }
    case 'Component': {
      const rows = (await tx.query(
        `SELECT a.tag, a.asset_type, a.manufacturer, a.model, a.serial, a.attributes, rm.number AS room
           FROM asset a JOIN system s ON s.id = a.system_id LEFT JOIN room rm ON rm.id = a.room_id WHERE s.project_id = $1 ORDER BY a.tag`, [projectId])).rows;
      const outlets = (await tx.query(
        `SELECT o.label, o.gas, r.number AS room FROM medgas_outlet o JOIN medgas_zone z ON z.id = o.zone_id LEFT JOIN room r ON r.id = o.room_id WHERE z.project_id = $1 ORDER BY o.label`, [projectId])).rows;
      return { header: ['Name', 'CreatedBy', 'CreatedOn', 'TypeName', 'Space', 'Description', 'SerialNumber'],
        rows: [
          ...rows.map((r) => [r.tag, by, on, [r.asset_type, r.manufacturer, r.model].filter(Boolean).join(' '), r.room ?? '', r.attributes?.branch ? `EES ${r.attributes.branch} branch` : '', r.serial ?? '']),
          ...outlets.map((o) => [o.label, by, on, `medgas_outlet ${MED_GASES[o.gas as MedGas]?.label ?? o.gas}`, o.room ?? '', 'Medical gas outlet / inlet', '']),
        ] };
    }
    case 'System': {
      const rows = (await tx.query(
        `SELECT s.name, s.system_type, string_agg(a.tag, ',' ORDER BY a.tag) AS tags FROM system s LEFT JOIN asset a ON a.system_id = s.id WHERE s.project_id = $1 GROUP BY s.id ORDER BY s.name`, [projectId])).rows;
      return { header: ['Name', 'CreatedBy', 'CreatedOn', 'Category', 'ComponentNames'], rows: rows.map((r) => [r.name, by, on, r.system_type, r.tags ?? '']) };
    }
  }
}

// ---------------------------------------------------------------------------
// Connections (Procore / ACC)
// ---------------------------------------------------------------------------

const publicConnection = (c: Record<string, unknown>) => {
  const { token_ciphertext: _t, ...rest } = c;
  return rest;
};

export async function connectorRoutes(api: FastifyInstance, db: Db, fetchImpl: () => typeof fetch = () => fetch) {
  // --- BAS trend import -------------------------------------------------------------
  /**
   * CSV columns: timestamp, room_number, point, value. Points: pressure_in_wc, temp_f, rh_pct, supply_cfm, exhaust_cfm, oa_cfm.
   * Each room's trend is summarised (time in compliance, excursions, data gaps) and its median values are recorded as a
   * BAS measurement, so the compliance grid reflects the trend, not just one TAB visit.
   */
  api.post('/projects/:id/imports/bas-trend', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ csv: z.string().min(1).max(20_000_000), intervalMin: z.number().int().min(1).max(240).default(15), recordMeasurements: z.boolean().default(true) }).parse(req.body);
      await requirePermission(tx, p, { projectId: id }, 'measurement.record');
      const rows = parseCsv(b.csv);
      if (!rows.length) throw new HttpError(400, 'CSV has no data rows', 'validation');
      for (const col of ['timestamp', 'room_number', 'point', 'value']) {
        if (!(col in rows[0]!)) throw new HttpError(400, `CSV must include columns timestamp, room_number, point, value (missing ${col})`, 'validation');
      }
      const rooms = (await tx.query<RoomRow>(
        `SELECT rm.* FROM room rm JOIN department d ON d.id = rm.department_id JOIN floor f ON f.id = d.floor_id
           JOIN building b ON b.id = f.building_id WHERE b.project_id = $1`, [id])).rows;
      const byNumber = new Map(rooms.map((r) => [r.number.toLowerCase(), r]));
      const errors: { row: number; error: string }[] = [];
      const series = new Map<string, Map<TrendPoint, { t: string; value: number }[]>>();
      let minT = Infinity, maxT = -Infinity;
      rows.forEach((r, i) => {
        const room = byNumber.get((r.room_number ?? '').toLowerCase());
        const point = (r.point ?? '').toLowerCase() as TrendPoint;
        const t = Date.parse(r.timestamp ?? '');
        const value = Number(r.value);
        if (!room) return void errors.push({ row: i + 2, error: `Unknown room ${r.room_number}` });
        if (!(point in TREND_POINTS)) return void errors.push({ row: i + 2, error: `Unknown point ${r.point}` });
        if (!Number.isFinite(t)) return void errors.push({ row: i + 2, error: `Bad timestamp ${r.timestamp}` });
        if (r.value === '' || !Number.isFinite(value)) return void errors.push({ row: i + 2, error: `Bad value ${r.value}` });
        minT = Math.min(minT, t); maxT = Math.max(maxT, t);
        const m = series.get(room.id) ?? new Map();
        const list = m.get(point) ?? [];
        list.push({ t: new Date(t).toISOString(), value });
        m.set(point, list);
        series.set(room.id, m);
      });
      if (errors.length) {
        reply.status(422);
        return { imported: 0, errors: errors.slice(0, 200), errorCount: errors.length };
      }
      const overlays = await overlaysForProject(tx, id);
      const roomsOut = [];
      for (const [roomId, points] of series) {
        const room = rooms.find((r) => r.id === roomId)!;
        const summaries: PointSummary[] = [...points].map(([point, samples]) =>
          summarizeTrendPoint({ point, samples, spaceTypeId: room.space_type_id, volumeCuft: Number(room.volume_cuft), overlays, intervalMin: b.intervalMin }));
        let overall: string | null = null;
        if (b.recordMeasurements) {
          const med = (pt: TrendPoint) => summaries.find((s) => s.point === pt)?.median;
          const last = Math.max(...[...points.values()].flat().map((x) => Date.parse(x.t)));
          const out = await recordMeasurement(tx, p.tenantId, p.userId, room, id, {
            source: 'bas', measuredAt: new Date(last).toISOString(),
            pressureDiffInWc: med('pressure_in_wc'), tempF: med('temp_f'), rhPct: med('rh_pct'),
            supplyCfm: med('supply_cfm'), exhaustCfm: med('exhaust_cfm'), oaCfm: med('oa_cfm'),
          });
          overall = out.evaluation.overall;
        }
        roomsOut.push({
          roomId, roomNumber: room.number, roomName: room.name, overallAtMedian: overall,
          worstPctCompliant: summaries.reduce<number | null>((m, s) => (s.pctOfTimeCompliant === null ? m : m === null ? s.pctOfTimeCompliant : Math.min(m, s.pctOfTimeCompliant)), null),
          points: summaries,
        });
      }
      roomsOut.sort((a, b2) => (a.worstPctCompliant ?? 101) - (b2.worstPctCompliant ?? 101));
      const summary = { rooms: roomsOut };
      const imp = (await tx.query<{ id: string }>(
        `INSERT INTO bas_trend_import (tenant_id, project_id, window_start, window_end, rows_read, summary, imported_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [p.tenantId, id, new Date(minT), new Date(maxT), rows.length, JSON.stringify(summary), p.userId])).rows[0]!;
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'import.bas_trend', entityType: 'project', entityId: id, data: { importId: imp.id, rows: rows.length, rooms: roomsOut.length } });
      reply.status(201);
      return { importId: imp.id, rowsRead: rows.length, windowStart: new Date(minT).toISOString(), windowEnd: new Date(maxT).toISOString(), rooms: roomsOut };
    }),
  );

  api.get('/projects/:id/imports/bas-trend', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      return (await tx.query(
        `SELECT i.id, i.window_start, i.window_end, i.rows_read, i.imported_at, u.name AS imported_by_name, i.summary
           FROM bas_trend_import i JOIN app_user u ON u.id = i.imported_by WHERE i.project_id = $1 ORDER BY i.imported_at DESC LIMIT 20`, [id])).rows;
    }),
  );

  // --- COBie ------------------------------------------------------------------------
  api.get('/projects/:id/exports/cobie', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const counts: Record<string, number> = {};
      for (const s of COBIE_SHEETS) counts[s] = (await cobieSheet(tx, id, s)).rows.length;
      return { format: 'COBie-style CSV, one file per sheet', sheets: COBIE_SHEETS.map((s) => ({ sheet: s, rows: counts[s], path: `/projects/${id}/exports/cobie/${s}.csv` })) };
    }),
  );

  api.get('/projects/:id/exports/cobie/:sheet', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id, sheet } = z.object({ id: uuid, sheet: z.string() }).parse(req.params);
      const name = sheet.replace(/\.csv$/i, '') as Sheet;
      if (!COBIE_SHEETS.includes(name)) throw notFound(`COBie sheet ${name}`);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const { header, rows } = await cobieSheet(tx, id, name);
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'export.cobie', entityType: 'project', entityId: id, data: { sheet: name, rows: rows.length } });
      reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="COBie-${name}.csv"`);
      return toCsv(header, rows);
    }),
  );

  // --- Procore / ACC connections ------------------------------------------------------
  const connBody = z.object({
    provider: z.enum(['procore', 'acc']),
    baseUrl: z.string(),
    externalProjectId: z.string().min(1).max(100),
    settings: z.record(z.union([z.string(), z.number()])).default({}),
    accessToken: z.string().min(10).max(8000),
  });

  api.post('/projects/:id/connections', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = connBody.parse(req.body);
      await requirePermission(tx, p, { projectId: id }, 'project.manage');
      const base = checkConnectorBaseUrl(b.provider, b.baseUrl);
      const row = (await tx.query(
        `INSERT INTO external_connection (tenant_id, project_id, provider, base_url, external_project_id, settings, token_ciphertext, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [p.tenantId, id, b.provider, base, b.externalProjectId, JSON.stringify(b.settings), encryptSecret(b.accessToken), p.userId])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'integration.connection.create', entityType: 'external_connection', entityId: row.id, data: { provider: b.provider, base, externalProjectId: b.externalProjectId } });
      reply.status(201);
      return publicConnection(row);
    }),
  );

  api.get('/projects/:id/connections', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const rows = (await tx.query(
        `SELECT c.*, (SELECT count(*) FROM external_issue_link l WHERE l.connection_id = c.id) AS linked_issues
           FROM external_connection c WHERE c.project_id = $1 ORDER BY c.provider`, [id])).rows;
      return rows.map(publicConnection);
    }),
  );

  api.patch('/connections/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ accessToken: z.string().min(10).max(8000).optional(), active: z.boolean().optional(), settings: z.record(z.union([z.string(), z.number()])).optional() }).parse(req.body);
      const c = (await tx.query('SELECT * FROM external_connection WHERE id = $1', [id])).rows[0];
      if (!c) throw notFound('Connection');
      await requirePermission(tx, p, { projectId: c.project_id }, 'project.manage');
      const row = (await tx.query(
        `UPDATE external_connection SET token_ciphertext = $2, active = $3, settings = $4 WHERE id = $1 RETURNING *`,
        [id, b.accessToken ? encryptSecret(b.accessToken) : c.token_ciphertext, b.active ?? c.active, JSON.stringify(b.settings ?? c.settings)])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'integration.connection.update', entityType: 'external_connection', entityId: id, data: { tokenChanged: !!b.accessToken, active: b.active, settings: b.settings } });
      return publicConnection(row);
    }),
  );

  /** Push new and changed issues to the construction platform. Calls happen outside the database transaction. */
  api.post('/connections/:id/sync-issues', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const pr = (req as { principal?: { tenantId: string; userId: string } }).principal!;
    const prep = await tenantTx(db, req, async (tx, p) => {
      const c = (await tx.query('SELECT * FROM external_connection WHERE id = $1', [id])).rows[0];
      if (!c) throw notFound('Connection');
      await requirePermission(tx, p, { projectId: c.project_id }, 'project.manage');
      if (!c.active) throw new HttpError(409, 'Connection is paused', 'conflict');
      const issues = (await tx.query<SyncIssue & { external_id: string | null; pushed_sha256: string | null }>(
        `SELECT i.id, i.number, i.title, i.description, i.status, i.priority, i.life_safety, i.due_date::text, i.requirement_key,
                rm.number AS room_number, l.external_id, l.pushed_sha256
           FROM issue i LEFT JOIN room rm ON rm.id = i.room_id
           LEFT JOIN external_issue_link l ON l.issue_id = i.id AND l.connection_id = $2
          WHERE i.project_id = $1 AND (l.id IS NOT NULL OR i.status <> 'closed') ORDER BY i.number`, [c.project_id, id])).rows;
      return { c, issues, token: decryptSecret(c.token_ciphertext) };
    });
    const conn: ConnectionInfo = { provider: prep.c.provider as Provider, base_url: prep.c.base_url, external_project_id: prep.c.external_project_id, settings: prep.c.settings };
    const results: { issueNumber: number; action: 'created' | 'updated' | 'unchanged' | 'failed'; externalId?: string | null; error?: string; sha?: string; issueId: string }[] = [];
    for (const i of prep.issues) {
      const { external_id, pushed_sha256, ...issue } = i;
      const sha = sha256(canonicalJson(issue));
      if (external_id && sha === pushed_sha256) { results.push({ issueId: i.id, issueNumber: i.number, action: 'unchanged', externalId: external_id }); continue; }
      try {
        const r = buildRequest(conn, issue, external_id);
        const res = await fetchImpl()(r.url, {
          method: r.method,
          headers: { ...r.headers, authorization: `Bearer ${prep.token}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(r.body),
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
        let json: unknown = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
        const ext = external_id ?? externalIdFrom(conn.provider, json);
        if (!ext) throw new Error('Provider response had no item id');
        results.push({ issueId: i.id, issueNumber: i.number, action: external_id ? 'updated' : 'created', externalId: ext, sha });
      } catch (x) {
        results.push({ issueId: i.id, issueNumber: i.number, action: 'failed', error: (x as Error).message });
      }
    }
    const summary = { created: 0, updated: 0, unchanged: 0, failed: 0 };
    for (const r of results) summary[r.action]++;
    await withTenant(db, pr.tenantId, async (tx) => {
      for (const r of results.filter((x) => x.action === 'created' || x.action === 'updated')) {
        await tx.query(
          `INSERT INTO external_issue_link (tenant_id, connection_id, issue_id, external_id, pushed_sha256) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (connection_id, issue_id) DO UPDATE SET pushed_sha256 = EXCLUDED.pushed_sha256, pushed_at = now()`,
          [pr.tenantId, id, r.issueId, r.externalId, r.sha]);
      }
      await tx.query('UPDATE external_connection SET last_sync_at = now(), last_sync_result = $2 WHERE id = $1', [id, JSON.stringify(summary)]);
      await appendAudit(tx, pr.tenantId, { actorId: pr.userId, action: 'integration.connection.sync', entityType: 'external_connection', entityId: id, data: summary });
    });
    return { ...summary, results: results.map(({ sha: _s, issueId: _i, ...r }) => r) };
  });
}
