import { createHmac, randomUUID } from 'node:crypto';
import type { AuditEntry } from './audit.js';
import type { Db, Tx } from './db.js';

/**
 * Outbound webhooks. Events are derived from audit-log actions, written to an
 * outbox in the same transaction as the change, and delivered by a dispatcher
 * with an HMAC-SHA256 signature and exponential back-off.
 */
export const WEBHOOK_EVENTS: Record<string, string> = {
  'issue.create': 'issue.created',
  'issue.update': 'issue.updated',
  'issue.comment': 'issue.commented',
  'test_run.submit': 'test_run.submitted',
  'test_run.sign': 'test_run.signed',
  'room.measure': 'room.measured',
  'ees.ats_test': 'ees.test_recorded',
  'ees.generator_test': 'ees.test_recorded',
  'icra.zone.approve': 'icra.zone_approved',
  'icra.log': 'icra.log_recorded',
  'ilsm.assess': 'ilsm.assessment_created',
  'ilsm.update': 'ilsm.assessment_updated',
  'ilsm.fire_watch': 'ilsm.fire_watch_logged',
  'medgas.test': 'medgas.test_recorded',
  'medgas.zone.certify': 'medgas.zone_certified',
  'binder.generate': 'binder.generated',
  'import.bas_trend': 'bas.trend_imported',
  'ls.inspect': 'life_safety.inspection_recorded',
  'pfi.create': 'soc.pfi_created',
  'pfi.resolve': 'soc.pfi_resolved',
  'phase.ready': 'phase.signed_ready',
  'phase.occupied': 'phase.occupied',
};
export const EVENT_NAMES = [...new Set(Object.values(WEBHOOK_EVENTS))].sort();

/** How to find the project an audited entity belongs to. */
const PROJECT_OF: Record<string, string> = {
  project: 'SELECT $1::uuid AS project_id',
  issue: 'SELECT project_id FROM issue WHERE id = $1',
  test_run: 'SELECT project_id FROM test_run WHERE id = $1',
  icra_zone: 'SELECT project_id FROM icra_zone WHERE id = $1',
  ilsm_assessment: 'SELECT project_id FROM ilsm_assessment WHERE id = $1',
  medgas_zone: 'SELECT project_id FROM medgas_zone WHERE id = $1',
  room: `SELECT b.project_id FROM room rm JOIN department d ON d.id = rm.department_id JOIN floor f ON f.id = d.floor_id
          JOIN building b ON b.id = f.building_id WHERE rm.id = $1`,
  ls_item: 'SELECT project_id FROM ls_item WHERE id = $1',
  pfi_item: 'SELECT project_id FROM pfi_item WHERE id = $1',
  phase: 'SELECT project_id FROM phase WHERE id = $1',
  activation_item: 'SELECT ph.project_id FROM activation_item a JOIN phase ph ON ph.id = a.phase_id WHERE a.id = $1',
  asset: 'SELECT s.project_id FROM asset a JOIN system s ON s.id = a.system_id WHERE a.id = $1',
};

/** Called from appendAudit inside the same transaction. Cheap when no webhook is configured. */
export async function enqueueWebhooks(tx: Tx, tenantId: string, e: AuditEntry, data: unknown, at: Date): Promise<void> {
  const event = WEBHOOK_EVENTS[e.action];
  if (!event) return;
  const hooks = (await tx.query<{ id: string; project_id: string | null }>(
    `SELECT id, project_id FROM webhook WHERE tenant_id = $1 AND active AND $2 = ANY(events)`, [tenantId, event])).rows;
  if (!hooks.length) return;
  const sql = PROJECT_OF[e.entityType];
  const projectId = sql ? (await tx.query<{ project_id: string }>(sql, [e.entityId])).rows[0]?.project_id ?? null : null;
  for (const h of hooks) {
    if (h.project_id && h.project_id !== projectId) continue;
    const deliveryId = randomUUID();
    const payload = { id: deliveryId, event, occurredAt: at.toISOString(), projectId, entity: { type: e.entityType, id: e.entityId }, actorId: e.actorId, data };
    await tx.query(
      `INSERT INTO webhook_delivery (id, tenant_id, webhook_id, event, payload) VALUES ($1,$2,$3,$4,$5)`,
      [deliveryId, tenantId, h.id, event, JSON.stringify(payload)],
    );
  }
}

/** Signature header value: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">. */
export function signWebhook(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Verify a signature (for receivers, and for our tests). Rejects signatures older than `toleranceSec`. */
export function verifyWebhookSignature(secret: string, body: string, header: string, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec || !parts.v1) return false;
  return signWebhook(secret, body, t) === header;
}

export const MAX_ATTEMPTS = 8;
/** Back-off before the next attempt, in seconds: 30 s, 2 min, 8 min, … capped at 6 h. */
export const retryDelaySec = (attempt: number) => Math.min(30 * 4 ** (attempt - 1), 6 * 3600);

export interface DispatchOptions { fetchImpl?: typeof fetch; limit?: number; timeoutMs?: number }

/** Deliver due webhooks once. Returns how many were attempted and delivered. */
export async function dispatchWebhooks(db: Db, opts: DispatchOptions = {}): Promise<{ attempted: number; delivered: number }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const due = (await db.query<{ id: string; event: string; payload: unknown; attempts: number; url: string; secret: string }>(
    'SELECT * FROM claim_webhook_deliveries($1, $2)', [opts.limit ?? 50, 120])).rows;
  let delivered = 0;
  for (const d of due) {
    const body = JSON.stringify(d.payload);
    let ok = false, status: number | null = null, error: string | null = null;
    try {
      const res = await doFetch(d.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'OMOSHINE-CX-Planner-Webhooks/1.0',
          'x-omoshine-event': d.event,
          'x-omoshine-delivery': d.id,
          'x-omoshine-signature': signWebhook(d.secret, body, Math.floor(Date.now() / 1000)),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      status = res.status;
      ok = res.status >= 200 && res.status < 300;
      if (!ok) error = `HTTP ${res.status}`;
    } catch (x) {
      error = (x as Error).message;
    }
    const retry = ok || d.attempts >= MAX_ATTEMPTS ? null : retryDelaySec(d.attempts);
    await db.query('SELECT complete_webhook_delivery($1,$2,$3,$4,$5)', [d.id, ok, status, error, retry]);
    if (ok) delivered++;
  }
  return { attempted: due.length, delivered };
}

/** Background loop for the API server. */
export function startWebhookDispatcher(db: Db, intervalMs = 10_000, log: (e: unknown) => void = console.error): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await dispatchWebhooks(db); } catch (e) { log(e); } finally { running = false; }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
