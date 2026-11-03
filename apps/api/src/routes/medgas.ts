import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ENGINE_VERSION,
  MED_GASES,
  MEDGAS_TESTS,
  PIPING_LIMITS,
  evaluateMedGasTest,
  findMedGasTest,
  medGasZoneStatus,
  requiredMedGasTests,
  type MedGas,
  type MedGasTestType,
} from '@omoshine/rules';
import { appendAudit } from '../audit.js';
import { verifyReauthToken } from '../auth.js';
import { canonicalJson, sha256 } from '../crypto.js';
import type { Db, Tx } from '../db.js';
import { HttpError, forbidden, notFound, requirePermission, tenantTx } from '../http.js';

const uuid = z.string().uuid();
const GAS_KEYS = Object.keys(MED_GASES) as [MedGas, ...MedGas[]];
const TEST_KEYS = MEDGAS_TESTS.map((t) => t.key) as [MedGasTestType, ...MedGasTestType[]];

interface ZoneRow { id: string; project_id: string; department_id: string | null; name: string; zone_valve_tag: string; gases: MedGas[] }
interface OutletRow { id: string; zone_id: string; room_id: string | null; label: string; gas: MedGas; room_number?: string | null }
interface TestRow {
  id: string; outlet_id: string | null; gas: string | null; test_type: string; overall: 'pass' | 'fail' | 'incomplete'; tested_at: Date;
  evaluation: unknown; readings: unknown; verifier_credential: string; instrument: string | null; notes: string | null; recorded_by_name?: string;
}

async function loadZone(tx: Tx, id: string): Promise<ZoneRow> {
  const r = await tx.query<ZoneRow>('SELECT * FROM medgas_zone WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound('Medical gas zone');
  return r.rows[0];
}
const zoneScope = (z: ZoneRow) => ({ projectId: z.project_id, departmentId: z.department_id });

async function zoneState(tx: Tx, zone: ZoneRow) {
  const outlets = (await tx.query<OutletRow>(
    `SELECT o.*, r.number AS room_number FROM medgas_outlet o LEFT JOIN room r ON r.id = o.room_id WHERE o.zone_id = $1 ORDER BY o.label`, [zone.id])).rows;
  const tests = (await tx.query<TestRow>(
    `SELECT t.*, u.name AS recorded_by_name FROM medgas_test t JOIN app_user u ON u.id = t.recorded_by WHERE t.zone_id = $1 ORDER BY t.tested_at, t.recorded_at`, [zone.id])).rows;
  const required = requiredMedGasTests(zone.gases, outlets);
  const status = medGasZoneStatus(required, tests.map((t) => ({
    testType: t.test_type, gas: t.gas, outletId: t.outlet_id, overall: t.overall, testedAt: t.tested_at.toISOString(),
  })));
  // Attach the id of the result each requirement currently rests on.
  const latestId = new Map<string, string>();
  for (const t of tests) latestId.set([t.test_type, t.gas ?? '-', t.outlet_id ?? '-'].join(':'), t.id);
  const items = status.items.map((i) => ({ ...i, latestTestId: latestId.get(i.key) ?? null }));
  // The certification binds the zone definition, its outlets, and the exact results relied on.
  const digest = sha256(canonicalJson({
    id: zone.id, name: zone.name, zone_valve_tag: zone.zone_valve_tag, gases: [...zone.gases].sort(),
    outlets: outlets.map((o) => ({ id: o.id, label: o.label, gas: o.gas })),
    results: items.map((i) => ({ key: i.key, testId: i.latestTestId })),
  }));
  const sigs = (await tx.query<{ signer_name: string; signed_at: Date; record_sha256: string }>(
    `SELECT signer_name, signed_at, record_sha256 FROM signature WHERE record_type = 'medgas_zone' AND record_id = $1 AND signer_role = 'medgas_verifier' ORDER BY signed_at DESC`,
    [zone.id])).rows;
  const current = sigs.find((s) => s.record_sha256 === digest);
  const certification = current
    ? { status: 'certified' as const, by: current.signer_name, at: current.signed_at }
    : { status: sigs.length ? ('recertification_required' as const) : ('not_certified' as const), by: null, at: null };
  return { outlets, tests, items, summary: status.summary, readyToCertify: status.readyToCertify, digest, certification };
}

export async function medgasRoutes(api: FastifyInstance, db: Db) {
  api.get('/medgas/catalog', async () => ({ gases: MED_GASES, tests: MEDGAS_TESTS, pipingLimits: PIPING_LIMITS, verified: false }));

  api.post('/projects/:id/medgas-zones', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({
        name: z.string().min(1),
        departmentId: uuid.optional(),
        zoneValveTag: z.string().default(''),
        gases: z.array(z.enum(GAS_KEYS)).min(1),
      }).parse(req.body);
      await requirePermission(tx, p, { projectId: id, departmentId: b.departmentId }, 'medgas.manage');
      const gases = [...new Set(b.gases)];
      const zone = (await tx.query<ZoneRow>(
        `INSERT INTO medgas_zone (tenant_id, project_id, department_id, name, zone_valve_tag, gases, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [p.tenantId, id, b.departmentId ?? null, b.name, b.zoneValveTag, gases, p.userId],
      )).rows[0]!;
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'medgas.zone.create', entityType: 'medgas_zone', entityId: zone.id, data: b });
      reply.status(201);
      return zone;
    }),
  );

  api.get('/projects/:id/medgas-zones', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      await requirePermission(tx, p, { projectId: id }, 'read');
      const zones = (await tx.query<ZoneRow & { department_name: string | null }>(
        `SELECT z.*, d.name AS department_name FROM medgas_zone z LEFT JOIN department d ON d.id = z.department_id WHERE z.project_id = $1 ORDER BY z.name`, [id])).rows;
      const out = [];
      for (const zone of zones) {
        const s = await zoneState(tx, zone);
        out.push({ ...zone, outletCount: s.outlets.length, summary: s.summary, readyToCertify: s.readyToCertify, certification: s.certification });
      }
      return out;
    }),
  );

  api.get('/medgas-zones/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const zone = await loadZone(tx, id);
      await requirePermission(tx, p, zoneScope(zone), 'read');
      const { digest: _d, ...s } = await zoneState(tx, zone);
      return { ...zone, ...s, tests: s.tests.slice().reverse() };
    }),
  );

  api.post('/medgas-zones/:id/outlets', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({
        outlets: z.array(z.object({ label: z.string().min(1), gas: z.enum(GAS_KEYS), roomId: uuid.optional() })).min(1).max(500),
      }).parse(req.body);
      const zone = await loadZone(tx, id);
      await requirePermission(tx, p, zoneScope(zone), 'medgas.manage');
      const bad = b.outlets.find((o) => !zone.gases.includes(o.gas));
      if (bad) throw new HttpError(400, `Zone ${zone.name} does not carry ${MED_GASES[bad.gas].label} (outlet ${bad.label})`, 'validation');
      const created = [];
      for (const o of b.outlets) {
        const r = await tx.query<OutletRow>(
          `INSERT INTO medgas_outlet (tenant_id, zone_id, room_id, label, gas) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (zone_id, label) DO NOTHING RETURNING *`, [p.tenantId, id, o.roomId ?? null, o.label, o.gas]);
        if (r.rows[0]) created.push(r.rows[0]);
      }
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'medgas.outlets.add', entityType: 'medgas_zone', entityId: id, data: { count: created.length } });
      reply.status(201);
      return { created: created.length, skipped: b.outlets.length - created.length, outlets: created };
    }),
  );

  /** Record one verification result. Results are append-only; a failure opens a critical life safety issue. */
  api.post('/medgas-zones/:id/tests', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({
        testType: z.enum(TEST_KEYS),
        gas: z.enum(GAS_KEYS).optional(),
        outletId: uuid.optional(),
        readings: z.record(z.union([z.number(), z.boolean()])),
        verifierCredential: z.string().min(3),
        instrument: z.string().optional(),
        notes: z.string().max(4000).optional(),
        testedAt: z.string().datetime({ offset: true }).optional(),
      }).parse(req.body);
      const zone = await loadZone(tx, id);
      await requirePermission(tx, p, zoneScope(zone), 'medgas.test');
      const def = findMedGasTest(b.testType)!;
      let gas: MedGas | null = null;
      let outlet: OutletRow | null = null;
      if (def.per === 'outlet') {
        if (!b.outletId) throw new HttpError(400, `${def.label} is recorded per outlet; outletId is required`, 'validation');
        outlet = (await tx.query<OutletRow>('SELECT * FROM medgas_outlet WHERE id = $1 AND zone_id = $2', [b.outletId, id])).rows[0] ?? null;
        if (!outlet) throw notFound('Outlet in this zone');
        gas = outlet.gas;
      } else if (def.per === 'gas') {
        if (!b.gas || !zone.gases.includes(b.gas)) throw new HttpError(400, `${def.label} needs one of this zone's gases: ${zone.gases.join(', ')}`, 'validation');
        gas = b.gas;
      }
      if (def.positiveOnly && gas && MED_GASES[gas].kind !== 'positive') throw new HttpError(400, `${def.label} does not apply to ${MED_GASES[gas].label}`, 'validation');
      const outletCount = Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM medgas_outlet WHERE zone_id = $1', [id])).rows[0]!.n);
      const ev = evaluateMedGasTest({ testType: b.testType, gas, readings: b.readings, zoneOutletCount: outletCount });
      const test = (await tx.query<TestRow>(
        `INSERT INTO medgas_test (tenant_id, zone_id, outlet_id, gas, test_type, readings, evaluation, overall, verifier_credential, instrument, notes, tested_at, engine_version, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [p.tenantId, id, outlet?.id ?? null, gas, b.testType, JSON.stringify(b.readings), JSON.stringify(ev.checks), ev.overall, b.verifierCredential,
          b.instrument ?? null, b.notes ?? null, b.testedAt ?? new Date().toISOString(), ENGINE_VERSION, p.userId],
      )).rows[0]!;
      let issueId: string | null = null;
      if (ev.overall === 'fail') {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`issue:${zone.project_id}`]);
        const next = (await tx.query<{ n: number }>('SELECT COALESCE(max(number), 0) + 1 AS n FROM issue WHERE project_id = $1', [zone.project_id])).rows[0]!.n;
        const failed = ev.checks.filter((c) => c.status === 'fail').map((c) => `- ${c.label}${c.reason ? `: ${c.reason}` : ''}`).join('\n');
        const what = outlet ? `outlet ${outlet.label}` : gas ? MED_GASES[gas].label : 'zone';
        issueId = (await tx.query<{ id: string }>(
          `INSERT INTO issue (tenant_id, project_id, number, title, description, room_id, priority, life_safety, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,'critical',true,$7) RETURNING id`,
          [p.tenantId, zone.project_id, next, `Med gas ${zone.name}: ${def.label} failed (${what})`,
            `${failed}${b.notes ? `\n\nVerifier notes: ${b.notes}` : ''}\n\nThe zone cannot be certified until a retest passes.`, outlet?.room_id ?? null, p.userId],
        )).rows[0]!.id;
        await tx.query(`INSERT INTO issue_event (tenant_id, issue_id, kind, payload, actor_id) VALUES ($1,$2,'created',$3,$4)`,
          [p.tenantId, issueId, JSON.stringify({ source: 'medgas_test', testId: test.id }), p.userId]);
      }
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'medgas.test', entityType: 'medgas_zone', entityId: id, data: { testId: test.id, testType: b.testType, gas, overall: ev.overall, issueId } });
      reply.status(201);
      return { test, evaluation: ev, issueId };
    }),
  );

  /** The verifier certifies the zone once every required test passes (e-signature with re-authentication). */
  api.post('/medgas-zones/:id/certify', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const token = req.headers['x-reauth-token'];
      if (typeof token !== 'string') throw new HttpError(401, 'Re-authentication required to sign', 'reauth_required');
      let method: string;
      try { method = (await verifyReauthToken(token, p.userId)).method; } catch { throw new HttpError(401, 'Re-authentication expired; sign in again to sign', 'reauth_required'); }
      const zone = await loadZone(tx, id);
      const roles = await requirePermission(tx, p, zoneScope(zone), 'medgas.test');
      if (!roles.includes('medgas_verifier')) throw forbidden('Only the medical gas verifier can certify a zone');
      const s = await zoneState(tx, zone);
      if (s.certification.status === 'certified') throw new HttpError(409, 'This zone is already certified as it stands', 'conflict');
      if (!s.readyToCertify) {
        const open = s.items.filter((i) => i.status !== 'pass').slice(0, 5).map((i) => `${i.label} (${i.status.replace('_', ' ')})`);
        throw new HttpError(409, `Not every required test has passed: ${open.join('; ')}${s.items.length - s.summary.passed > 5 ? ' …' : ''}`, 'conflict');
      }
      const user = (await tx.query<{ name: string }>('SELECT name FROM app_user WHERE id = $1', [p.userId])).rows[0]!;
      const sig = (await tx.query(
        `INSERT INTO signature (tenant_id, record_type, record_id, record_sha256, signer_id, signer_name, signer_role, meaning, reauth_method)
         VALUES ($1,'medgas_zone',$2,$3,$4,$5,'medgas_verifier','approved',$6) RETURNING *`,
        [p.tenantId, id, s.digest, p.userId, user.name, method],
      )).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'medgas.zone.certify', entityType: 'medgas_zone', entityId: id, data: { digest: s.digest, tests: s.summary.required } });
      reply.status(201);
      return sig;
    }),
  );
}
