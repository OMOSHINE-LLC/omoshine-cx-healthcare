import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { createWorld, expectStatus, type World } from './helpers.js';
import { config } from '../src/config.js';
import { checkConnectorBaseUrl } from '../src/connectors.js';
import { decryptSecret, encryptSecret } from '../src/crypto.js';

let w: World;
let server: Server;
let base: string;
const calls: { method: string; url: string; headers: IncomingHttpHeaders; body: any }[] = [];
let nextId = 1000;
let failPaths: RegExp | null = null;

beforeAll(async () => {
  w = await createWorld();
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method!, url: req.url!, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (failPaths?.test(req.url!)) { res.statusCode = 422; return res.end(JSON.stringify({ errors: 'type_id is required' })); }
      res.statusCode = req.method === 'POST' ? 201 : 200;
      // Procore returns the item at the top level; ACC wraps nothing either, but some responses use data.id.
      res.end(JSON.stringify(req.url!.includes('/construction/') ? { data: { id: `acc-${nextId++}` } } : { id: nextId++ }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  config.connectorAllowAnyHost = false;
  await new Promise((r) => server.close(r));
  await w.close();
});

const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 8, min)).toISOString();

describe('BAS trend import', () => {
  it('rejects unknown rooms, points and bad values with row numbers', async () => {
    const csv = 'timestamp,room_number,point,value\n2026-11-01T08:00:00Z,NOPE,pressure_in_wc,-0.02\n2026-11-01T08:00:00Z,ISO-12,co2,400\n2026-11-01T08:00:00Z,ISO-12,temp_f,\n';
    const r = await w.as.tab.post(`/projects/${w.ids.project}/imports/bas-trend`, { csv });
    expect(r.status).toBe(422);
    expect(r.body.errors.map((e: { row: number }) => e.row)).toEqual([2, 3, 4]);
  });

  it('summarises time in compliance and excursions, and records the median as a BAS measurement', async () => {
    const iso = [-0.02, -0.02, 0.002, 0.001, -0.02, -0.02, -0.02, -0.02];
    const lines = ['timestamp,room_number,point,value'];
    iso.forEach((v, i) => lines.push(`${at(i * 15)},ISO-12,pressure_in_wc,${v}`));
    [44, 46, 45, 47].forEach((v, i) => lines.push(`${at(i * 15)},OR-04,rh_pct,${v}`));
    [68, 68, 69, 68].forEach((v, i) => lines.push(`${at(i * 15)},OR-04,temp_f,${v}`));
    const r = expectStatus(await w.as.tab.post(`/projects/${w.ids.project}/imports/bas-trend`, { csv: lines.join('\n'), intervalMin: 15 }), 201);
    expect(r.rowsRead).toBe(16);
    const iso12 = r.rooms.find((x: { roomNumber: string }) => x.roomNumber === 'ISO-12');
    const p = iso12.points.find((x: { point: string }) => x.point === 'pressure_in_wc');
    expect(p.pctOfTimeCompliant).toBe(75);
    expect(p.excursions).toHaveLength(1);
    expect(p.excursions[0].minutes).toBe(30);
    expect(r.rooms[0].roomNumber).toBe('ISO-12'); // worst room first
    const sheet = expectStatus(await w.as.cxa.get(`/rooms/${w.ids.aiir}/data-sheet`), 200);
    expect(sheet.latest.source).toBe('bas');
    expect(Number(sheet.latest.readings.pressureDiffInWc)).toBe(-0.02);
    const history = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/imports/bas-trend`), 200);
    expect(history[0]).toMatchObject({ rows_read: 16, imported_by_name: 'Riley TAB' });
  });

  it('only roles that record measurements can import', async () => {
    expect((await w.as.clinical.post(`/projects/${w.ids.project}/imports/bas-trend`, { csv: 'timestamp,room_number,point,value\n' })).status).toBe(403);
  });
});

describe('COBie export', () => {
  it('lists sheets and returns CSV with spaces, components and safe cells', async () => {
    expectStatus(await w.as.cxa.post(`/departments/${w.ids.dept}/rooms`, { number: 'CL-01', name: '=HYPERLINK("x")', spaceTypeId: 'patient_room', volumeCuft: 900 }), 201);
    const idx = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/exports/cobie`), 200);
    expect(idx.sheets.map((s: { sheet: string }) => s.sheet)).toEqual(['Contact', 'Facility', 'Floor', 'Space', 'Zone', 'Type', 'Component', 'System']);
    const space = await w.as.cxa.get(`/projects/${w.ids.project}/exports/cobie/Space.csv`);
    expect(space.status).toBe(200);
    expect(space.text.split('\r\n')[0]).toBe('Name,CreatedBy,CreatedOn,Category,FloorName,Description,RoomTag,GrossArea');
    expect(space.text).toMatch(/OR-04,.*Operating room/);
    expect(space.text).toContain(`"'=HYPERLINK(""x"")"`);
    const comp = await w.as.cxa.get(`/projects/${w.ids.project}/exports/cobie/Component.csv`);
    expect(comp.text).toMatch(/ATS-LS-1,.*EES life_safety branch/);
    expect((await w.as.cxa.get(`/projects/${w.ids.project}/exports/cobie/Secrets.csv`)).status).toBe(404);
    expect((await w.as.outsider.get(`/projects/${w.ids.project}/exports/cobie/Space.csv`)).status).toBe(403);
  });
});

describe('Procore and ACC issue sync', () => {
  let procoreId: string;
  let accId: string;

  it('only allows the providers’ own https hosts unless a sandbox override is set', () => {
    expect(() => checkConnectorBaseUrl('procore', 'https://evil.example.com', false)).toThrow(/api.procore.com/);
    expect(() => checkConnectorBaseUrl('acc', 'http://developer.api.autodesk.com', false)).toThrow();
    expect(checkConnectorBaseUrl('procore', 'https://sandbox.procore.com/whatever', false)).toBe('https://sandbox.procore.com');
  });

  it('stores the access token encrypted and never returns it', async () => {
    config.connectorAllowAnyHost = true;
    const c = expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/connections`, {
      provider: 'procore', baseUrl: base, externalProjectId: '562949953', settings: { companyId: 8089, observationTypeId: 17 }, accessToken: 'procore-token-abcdef',
    }), 201);
    procoreId = c.id;
    expect(JSON.stringify(c)).not.toContain('procore-token');
    expect(c.token_ciphertext).toBeUndefined();
    const db = new pg.Client({ connectionString: w.adminUrl });
    await db.connect();
    try {
      const row = (await db.query('SELECT token_ciphertext FROM external_connection WHERE id = $1', [procoreId])).rows[0];
      expect(row.token_ciphertext).toMatch(/^v1\./);
      expect(decryptSecret(row.token_ciphertext)).toBe('procore-token-abcdef');
    } finally {
      await db.end();
    }
    // Tampering with the ciphertext fails authentication.
    const [v, iv, tag, ct] = encryptSecret('some secret').split('.');
    const flipped = Buffer.from(ct!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => decryptSecret([v, iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
    expect((await w.as.gc.post(`/projects/${w.ids.project}/connections`, { provider: 'acc', baseUrl: base, externalProjectId: 'p', accessToken: 'xxxxxxxxxxxx' })).status).toBe(403);
  });

  it('creates Procore observations for open issues, then sends only changes', async () => {
    const ls = expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/issues`, { title: 'AIIR reading positive', roomId: w.ids.aiir, lifeSafety: true, priority: 'critical' }), 201);
    calls.length = 0;
    const first = expectStatus(await w.as.cxa.post(`/connections/${procoreId}/sync-issues`), 200);
    expect(first.failed).toBe(0);
    expect(first.created).toBeGreaterThanOrEqual(1);
    const call = calls.find((c) => c.body?.observation?.name?.includes('AIIR reading positive'))!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/rest/v1.0/observations/items?project_id=562949953');
    expect(call.headers.authorization).toBe('Bearer procore-token-abcdef');
    expect(call.headers['procore-company-id']).toBe('8089');
    expect(call.body.observation).toMatchObject({ status: 'initiated', priority: 'Urgent', type_id: 17 });
    expect(call.body.observation.name).toMatch(/^\[LIFE SAFETY\] CX-\d+: AIIR reading positive$/);
    expect(call.body.observation.description).toContain('Room: ISO-12');

    calls.length = 0;
    const second = expectStatus(await w.as.cxa.post(`/connections/${procoreId}/sync-issues`), 200);
    expect(second).toMatchObject({ created: 0, updated: 0, failed: 0 });
    expect(calls).toHaveLength(0);

    expectStatus(await w.as.cxa.patch(`/issues/${ls.id}`, { status: 'closed', comment: 'Rebalanced; reading -0.02' }), 200);
    const third = expectStatus(await w.as.cxa.post(`/connections/${procoreId}/sync-issues`), 200);
    expect(third.updated).toBe(1);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toMatch(/^\/rest\/v1\.0\/observations\/items\/\d+\?project_id=562949953$/);
    expect(calls[0]!.body.observation.status).toBe('closed');
  });

  it('creates ACC issues with the subtype, and reports provider errors without losing links', async () => {
    accId = expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/connections`, {
      provider: 'acc', baseUrl: base, externalProjectId: 'b.1234-abcd', settings: { issueSubtypeId: 'subtype-1' }, accessToken: 'acc-token-0123456789',
    }), 201).id;
    expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/issues`, { title: 'Door closer missing at OR-04' }), 201);
    calls.length = 0;
    const r = expectStatus(await w.as.cxa.post(`/connections/${accId}/sync-issues`), 200);
    expect(r.created).toBe(1);
    expect(r.failed).toBe(0);
    expect(calls[0]!.url).toBe('/construction/issues/v1/projects/b.1234-abcd/issues');
    expect(calls[0]!.body).toMatchObject({ status: 'open', issueSubtypeId: 'subtype-1' });
    const list = expectStatus(await w.as.cxa.get(`/projects/${w.ids.project}/connections`), 200);
    expect(list.find((c: { id: string }) => c.id === accId)).toMatchObject({ provider: 'acc', last_sync_result: { failed: 0 } });

    expectStatus(await w.as.cxa.post(`/projects/${w.ids.project}/issues`, { title: 'New after first sync' }), 201);
    failPaths = /\/construction\//;
    const bad = expectStatus(await w.as.cxa.post(`/connections/${accId}/sync-issues`), 200);
    failPaths = null;
    expect(bad.failed).toBe(1);
    expect(bad.results.find((x: { action: string }) => x.action === 'failed').error).toMatch(/HTTP 422/);
    const retry = expectStatus(await w.as.cxa.post(`/connections/${accId}/sync-issues`), 200);
    expect(retry).toMatchObject({ created: 1, failed: 0 });
  });

  it('a paused connection does not sync', async () => {
    expectStatus(await w.as.cxa.patch(`/connections/${accId}`, { active: false }), 200);
    expect((await w.as.cxa.post(`/connections/${accId}/sync-issues`)).status).toBe(409);
  });
});
