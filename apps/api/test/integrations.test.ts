import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, createWorld, expectStatus, type World } from './helpers.js';
import { config } from '../src/config.js';
import { checkWebhookUrl } from '../src/routes/integrations.js';
import { dispatchWebhooks, retryDelaySec, signWebhook, verifyWebhookSignature } from '../src/webhooks.js';

let w: World;
let server: Server;
let base: string;
const received: { headers: IncomingHttpHeaders; body: string }[] = [];
let failNext = 0;

beforeAll(async () => {
  w = await createWorld();
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      if (failNext > 0) { failNext--; res.statusCode = 503; } else res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  config.webhookAllowInsecure = false;
  await new Promise((r) => server.close(r));
  await w.close();
});

describe('API keys', () => {
  let token: string;
  let keyId: string;

  it('only a tenant administrator can create a key; the token is shown once', async () => {
    expect((await w.as.cxa.post('/integration-keys', { name: 'BAS gateway', projectId: w.ids.project, role: 'tab' })).status).toBe(403);
    const k = expectStatus(await w.as.admin.post('/integration-keys', { name: 'BAS gateway', projectId: w.ids.project, role: 'tab' }), 201);
    expect(k.token).toMatch(/^omk_[a-z0-9]{12}_/);
    token = k.token;
    keyId = k.id;
    const list = expectStatus(await w.as.admin.get('/integration-keys'), 200);
    expect(list[0]).toMatchObject({ id: keyId, name: 'BAS gateway', role: 'tab', revoked_at: null });
    expect(JSON.stringify(list)).not.toContain(token.slice('omk_'.length + 13));
  });

  it('a key acts with its role on its project only, and cannot sign', async () => {
    const svc = new Client(w.app, token);
    expectStatus(await svc.get(`/projects/${w.ids.project}/room-compliance`), 200);
    expectStatus(await svc.post(`/rooms/${w.ids.or}/measurements`, { source: 'bas', supplyCfm: 2000, oaCfm: 400, pressureDiffInWc: 0.01, tempF: 68, rhPct: 45 }), 201);
    expect((await svc.post(`/projects/${w.ids.project}/issues`, { title: 'not allowed for TAB' })).status).toBe(403);
    expect((await svc.post('/auth/reauth', { pin: '2468' })).status).toBe(401);
    expect((await svc.get('/integration-keys')).status).toBe(403);
  });

  it('rejects wrong or revoked keys', async () => {
    expect((await new Client(w.app, token.slice(0, -2) + 'xx').get('/me')).status).toBe(401);
    expect((await new Client(w.app, 'omk_short_x').get('/me')).status).toBe(401);
    expectStatus(await w.as.admin.del(`/integration-keys/${keyId}`), 200);
    expect((await new Client(w.app, token).get('/me')).status).toBe(401);
  });
});

describe('webhooks', () => {
  let hookId: string;
  let secret: string;

  it('requires https to a public address unless development mode allows otherwise', () => {
    expect(() => checkWebhookUrl('http://example.com/hook', false)).toThrow(/https/);
    expect(() => checkWebhookUrl('https://127.0.0.1/hook', false)).toThrow(/public/);
    expect(() => checkWebhookUrl('https://10.1.2.3/hook', false)).toThrow(/public/);
    expect(() => checkWebhookUrl('https://user:pw@example.com/hook', false)).toThrow(/credentials/);
    expect(checkWebhookUrl('https://hooks.example.com/omoshine', false).hostname).toBe('hooks.example.com');
  });

  it('creates a subscription and returns the signing secret once', async () => {
    config.webhookAllowInsecure = true;
    expect((await w.as.admin.post('/webhooks', { url: `${base}/x`, events: ['not.an.event'] })).status).toBe(400);
    const h = expectStatus(await w.as.admin.post('/webhooks', { url: `${base}/hook`, events: ['issue.created', 'medgas.zone_certified'], projectId: w.ids.project }), 201);
    expect(h.secret).toMatch(/^whsec_/);
    hookId = h.id;
    secret = h.secret;
    expect(JSON.stringify(expectStatus(await w.as.admin.get('/webhooks'), 200))).not.toContain(secret);
  });

  it('delivers a signed event when an issue is created, in the same transaction as the change', async () => {
    received.length = 0;
    const issue = expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/issues`, { title: 'Webhook test issue', priority: 'high' }), 201);
    const r = await dispatchWebhooks(w.db);
    expect(r.delivered).toBeGreaterThanOrEqual(1);
    const got = received.find((x) => x.headers['x-omoshine-event'] === 'issue.created')!;
    expect(got).toBeDefined();
    expect(verifyWebhookSignature(secret, got.body, String(got.headers['x-omoshine-signature']))).toBe(true);
    expect(verifyWebhookSignature('whsec_wrong', got.body, String(got.headers['x-omoshine-signature']))).toBe(false);
    const payload = JSON.parse(got.body);
    expect(payload).toMatchObject({ event: 'issue.created', projectId: w.ids.project, entity: { type: 'issue', id: issue.id } });
    // Events the hook did not subscribe to are not sent.
    expect(received.some((x) => x.headers['x-omoshine-event'] === 'auth.login')).toBe(false);
  });

  it('retries with back-off after a failure and records each attempt', async () => {
    failNext = 1;
    expectStatus(await w.as.admin.post(`/webhooks/${hookId}/ping`), 202);
    await dispatchWebhooks(w.db);
    let d = expectStatus(await w.as.admin.get(`/webhooks/${hookId}/deliveries`), 200).find((x: { event: string }) => x.event === 'ping');
    expect(d).toMatchObject({ status: 'pending', attempts: 1, last_status_code: 503 });
    expect(new Date(d.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(retryDelaySec(1)).toBe(30);
    expect(retryDelaySec(3)).toBe(480);
    // Redelivery queues a fresh copy straight away.
    const again = expectStatus(await w.as.admin.post(`/webhook-deliveries/${d.id}/redeliver`), 202);
    await dispatchWebhooks(w.db);
    d = expectStatus(await w.as.admin.get(`/webhooks/${hookId}/deliveries`), 200).find((x: { id: string }) => x.id === again.deliveryId);
    expect(d).toMatchObject({ status: 'delivered', last_status_code: 204 });
  });

  it('paused hooks queue nothing, and other tenants never see the hook', async () => {
    expectStatus(await w.as.admin.patch(`/webhooks/${hookId}`, { active: false }), 200);
    received.length = 0;
    expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/issues`, { title: 'While paused' }), 201);
    await dispatchWebhooks(w.db);
    expect(received).toHaveLength(0);
    const other = await createWorld();
    try {
      expect(expectStatus(await other.as.admin.get('/webhooks'), 200)).toHaveLength(0);
      expect((await other.as.admin.get(`/webhooks/${hookId}/deliveries`)).status).toBe(404);
    } finally {
      await other.close();
    }
  });

  it('signature helper rejects stale timestamps', () => {
    const body = '{"a":1}';
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(verifyWebhookSignature('s', body, signWebhook('s', body, old))).toBe(false);
  });
});
