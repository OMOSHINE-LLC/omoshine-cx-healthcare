import type { FastifyInstance } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { ROLES } from '../access.js';
import { appendAudit } from '../audit.js';
import { config } from '../config.js';
import { sha256 } from '../crypto.js';
import type { Db, Tx } from '../db.js';
import { HttpError, notFound, requireTenantAdmin, tenantTx } from '../http.js';
import { EVENT_NAMES } from '../webhooks.js';

const uuid = z.string().uuid();

/** API key format: omk_<12-char prefix>_<secret>. Only the SHA-256 of the secret is stored. */
export const API_KEY_PATTERN = /^omk_([a-z0-9]{12})_([A-Za-z0-9_-]{32,})$/;

/** Webhook targets must be https and not point at private or loopback addresses (unless explicitly allowed for development). */
export function checkWebhookUrl(raw: string, allowInsecure = config.webhookAllowInsecure): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(400, 'Webhook URL is not a valid URL', 'validation'); }
  if (u.username || u.password) throw new HttpError(400, 'Webhook URL must not contain credentials', 'validation');
  if (allowInsecure) {
    if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'Webhook URL must use http or https', 'validation');
    return u;
  }
  if (u.protocol !== 'https:') throw new HttpError(400, 'Webhook URL must use https', 'validation');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const privateV4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') ||
      (isIP(host) === 4 && privateV4.test(host)) || (isIP(host) === 6 && /^(::1|f[cd]|fe80)/i.test(host))) {
    throw new HttpError(400, 'Webhook URL must be a public address', 'validation');
  }
  return u;
}

async function loadWebhook(tx: Tx, id: string) {
  const r = await tx.query('SELECT id, project_id, url, events, active, description, created_at FROM webhook WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound('Webhook');
  return r.rows[0];
}

export async function integrationRoutes(api: FastifyInstance, db: Db) {
  api.get('/integrations/events', async () => ({ events: EVENT_NAMES }));

  // --- API keys ------------------------------------------------------------------
  api.post('/integration-keys', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      await requireTenantAdmin(tx, p);
      const b = z.object({ name: z.string().min(2).max(80), projectId: uuid, role: z.enum(ROLES).default('design_engineer') }).parse(req.body);
      const proj = await tx.query('SELECT id FROM project WHERE id = $1', [b.projectId]);
      if (!proj.rows[0]) throw notFound('Project');
      const org = (await tx.query<{ organization_id: string | null }>('SELECT organization_id FROM app_user WHERE id = $1', [p.userId])).rows[0]!.organization_id;
      const user = (await tx.query<{ id: string }>(
        `INSERT INTO app_user (tenant_id, organization_id, email, name, is_service) VALUES ($1,$2,$3,$4,true) RETURNING id`,
        [p.tenantId, org, `svc-${randomUUID()}@integrations.omoshine.invalid`, `Integration: ${b.name}`])).rows[0]!;
      await tx.query(
        `INSERT INTO role_assignment (tenant_id, user_id, project_id, role, scope_type, scope_id) VALUES ($1,$2,$3,$4,'project',$3)`,
        [p.tenantId, user.id, b.projectId, b.role]);
      const prefix = randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 12);
      const secret = randomBytes(32).toString('base64url');
      const key = (await tx.query<{ id: string; created_at: Date }>(
        `INSERT INTO api_key (tenant_id, user_id, name, prefix, secret_sha256, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
        [p.tenantId, user.id, b.name, prefix, sha256(secret), p.userId])).rows[0]!;
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'integration.key.create', entityType: 'api_key', entityId: key.id, data: { name: b.name, projectId: b.projectId, role: b.role, prefix } });
      reply.status(201);
      return { id: key.id, name: b.name, prefix, role: b.role, projectId: b.projectId, token: `omk_${prefix}_${secret}`, note: 'Store this token now; it is not shown again.' };
    }),
  );

  api.get('/integration-keys', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      await requireTenantAdmin(tx, p);
      return (await tx.query(
        `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at, ra.project_id, ra.role
           FROM api_key k LEFT JOIN role_assignment ra ON ra.user_id = k.user_id ORDER BY k.created_at DESC`)).rows;
    }),
  );

  api.delete('/integration-keys/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      await requireTenantAdmin(tx, p);
      const { id } = z.object({ id: uuid }).parse(req.params);
      const r = await tx.query('UPDATE api_key SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id', [id]);
      if (!r.rows[0]) throw notFound('Active API key');
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'integration.key.revoke', entityType: 'api_key', entityId: id, data: {} });
      return { revoked: true };
    }),
  );

  // --- Webhooks ------------------------------------------------------------------
  const events = z.array(z.enum(EVENT_NAMES as [string, ...string[]])).min(1);

  api.post('/webhooks', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      await requireTenantAdmin(tx, p);
      const b = z.object({ url: z.string(), events, projectId: uuid.optional(), description: z.string().max(200).default('') }).parse(req.body);
      const url = checkWebhookUrl(b.url).toString();
      const secret = `whsec_${randomBytes(24).toString('base64url')}`;
      const hook = (await tx.query(
        `INSERT INTO webhook (tenant_id, project_id, url, secret, events, description, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, project_id, url, events, active, description, created_at`,
        [p.tenantId, b.projectId ?? null, url, secret, [...new Set(b.events)], b.description, p.userId])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'integration.webhook.create', entityType: 'webhook', entityId: hook.id, data: { url, events: b.events, projectId: b.projectId ?? null } });
      reply.status(201);
      return { ...hook, secret, note: 'Store this signing secret now; it is not shown again.' };
    }),
  );

  api.get('/webhooks', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      await requireTenantAdmin(tx, p);
      return (await tx.query(
        `SELECT w.id, w.project_id, w.url, w.events, w.active, w.description, w.created_at,
                count(d.*) FILTER (WHERE d.status = 'failed') AS failed, count(d.*) FILTER (WHERE d.status = 'pending') AS pending,
                max(d.delivered_at) AS last_delivered_at
           FROM webhook w LEFT JOIN webhook_delivery d ON d.webhook_id = w.id GROUP BY w.id ORDER BY w.created_at DESC`)).rows;
    }),
  );

  api.patch('/webhooks/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      await requireTenantAdmin(tx, p);
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({ url: z.string().optional(), events: events.optional(), active: z.boolean().optional(), description: z.string().max(200).optional() }).parse(req.body);
      const cur = await loadWebhook(tx, id);
      const url = b.url ? checkWebhookUrl(b.url).toString() : cur.url;
      const row = (await tx.query(
        `UPDATE webhook SET url = $2, events = $3, active = $4, description = $5 WHERE id = $1 RETURNING id, project_id, url, events, active, description, created_at`,
        [id, url, b.events ?? cur.events, b.active ?? cur.active, b.description ?? cur.description])).rows[0];
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'integration.webhook.update', entityType: 'webhook', entityId: id, data: b });
      return row;
    }),
  );

  /** Queue a test event so the receiver can check its signature verification. */
  api.post('/webhooks/:id/ping', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      await requireTenantAdmin(tx, p);
      const { id } = z.object({ id: uuid }).parse(req.params);
      const hook = await loadWebhook(tx, id);
      const deliveryId = randomUUID();
      const payload = { id: deliveryId, event: 'ping', occurredAt: new Date().toISOString(), projectId: hook.project_id, entity: { type: 'webhook', id }, actorId: p.userId, data: { message: 'OMOSHINE CX Planner webhook test' } };
      await tx.query(`INSERT INTO webhook_delivery (id, tenant_id, webhook_id, event, payload) VALUES ($1,$2,$3,'ping',$4)`, [deliveryId, p.tenantId, id, JSON.stringify(payload)]);
      reply.status(202);
      return { deliveryId };
    }),
  );

  api.get('/webhooks/:id/deliveries', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      await requireTenantAdmin(tx, p);
      const { id } = z.object({ id: uuid }).parse(req.params);
      await loadWebhook(tx, id);
      return (await tx.query(
        `SELECT id, event, status, attempts, last_status_code, last_error, next_attempt_at, delivered_at, created_at
           FROM webhook_delivery WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 100`, [id])).rows;
    }),
  );

  /** Send a delivery again (a new delivery with the same payload). */
  api.post('/webhook-deliveries/:id/redeliver', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      await requireTenantAdmin(tx, p);
      const { id } = z.object({ id: uuid }).parse(req.params);
      const d = (await tx.query<{ webhook_id: string; event: string; payload: Record<string, unknown> }>('SELECT webhook_id, event, payload FROM webhook_delivery WHERE id = $1', [id])).rows[0];
      if (!d) throw notFound('Delivery');
      const deliveryId = randomUUID();
      await tx.query(`INSERT INTO webhook_delivery (id, tenant_id, webhook_id, event, payload) VALUES ($1,$2,$3,$4,$5)`,
        [deliveryId, p.tenantId, d.webhook_id, d.event, JSON.stringify({ ...d.payload, id: deliveryId, redeliveryOf: id })]);
      reply.status(202);
      return { deliveryId };
    }),
  );
}
