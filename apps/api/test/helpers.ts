import { inject } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createPool, type Db } from '../src/db.js';
import { seedTenant, type SeededTenant } from '../src/fixtures.js';

export interface Res<T = any> { status: number; body: T; text: string }

export class Client {
  constructor(private app: FastifyInstance, public token?: string) {}
  async req<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const r = await this.app.inject({
      method,
      url: url.startsWith('/') && !url.startsWith('/api') && !url.startsWith('/brand') ? `/api/v1${url}` : url,
      payload: payload as object | undefined,
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...headers },
    });
    let body: any = r.body;
    try { body = r.json(); } catch { /* html or empty */ }
    return { status: r.statusCode, body, text: r.body };
  }
  get<T = any>(url: string) { return this.req<T>('GET', url); }
  post<T = any>(url: string, payload?: unknown, headers?: Record<string, string>) { return this.req<T>('POST', url, payload ?? {}, headers); }
  put<T = any>(url: string, payload?: unknown) { return this.req<T>('PUT', url, payload ?? {}); }
  patch<T = any>(url: string, payload?: unknown) { return this.req<T>('PATCH', url, payload ?? {}); }
}

export interface World {
  app: FastifyInstance;
  db: Db;
  adminUrl: string;
  appUrl: string;
  tenant: SeededTenant;
  as: Record<keyof SeededTenant['users'], Client>;
  anon: Client;
  ids: {
    project: string; building: string; phase: string; floor: string; dept: string; or: string; aiir: string;
    ahu: string; eesLs: string; eesCrit: string; atsLs: string; atsCrit: string; gen: string;
  };
  close(): Promise<void>;
}

export function expectStatus(res: Res, status: number) {
  if (res.status !== status) throw new Error(`Expected ${status}, got ${res.status}: ${res.text}`);
  return res.body;
}

/** Build an app, a fresh tenant and a small hospital project through the API. */
export async function createWorld(): Promise<World> {
  const adminUrl = inject('adminUrl');
  const appUrl = inject('appUrl');
  const db = createPool(appUrl);
  const app = await buildApp({ db });
  const tenant = await seedTenant(adminUrl);
  const anon = new Client(app);

  const as = {} as World['as'];
  for (const key of Object.keys(tenant.users) as (keyof SeededTenant['users'])[]) {
    const r = await anon.post('/auth/dev-login', { email: tenant.users[key].email, pin: tenant.pin });
    as[key] = new Client(app, expectStatus(r, 200).token);
  }

  const project = expectStatus(await as.admin.post('/projects', {
    name: 'West Tower Surgical Expansion', facilityName: 'Riverside Medical Center', stateCode: 'CA', creatorRole: 'owner',
  }), 201).id as string;
  for (const [key, role] of [['cxa', 'cxa'], ['gc', 'gc'], ['tab', 'tab'], ['ahj', 'ahj'], ['clinical', 'clinical_rep'], ['ip', 'infection_prevention'], ['safety', 'safety_officer']] as const) {
    expectStatus(await as.admin.post(`/projects/${project}/role-assignments`, { userId: tenant.users[key].id, role }), 201);
  }
  const c = as.cxa;
  const building = expectStatus(await c.post(`/projects/${project}/buildings`, { name: 'West Tower' }), 201).id;
  const phase = expectStatus(await c.post(`/projects/${project}/phases`, { name: 'Phase 1 – Surgery', sequence: 1, targetOccupancyDate: '2027-03-01' }), 201).id;
  const floor = expectStatus(await c.post(`/buildings/${building}/floors`, { name: 'Level 2', level: 2 }), 201).id;
  const dept = expectStatus(await c.post(`/floors/${floor}/departments`, { name: 'Surgical Services', phaseId: phase }), 201).id;
  const or = expectStatus(await c.post(`/departments/${dept}/rooms`, { number: 'OR-04', name: 'Operating Room 4', spaceTypeId: 'or_class_bc', volumeCuft: 5000 }), 201).id;
  const aiir = expectStatus(await c.post(`/departments/${dept}/rooms`, { number: 'ISO-12', name: 'Isolation 12', spaceTypeId: 'aiir', volumeCuft: 1200 }), 201).id;
  const ahu = expectStatus(await c.post(`/projects/${project}/systems`, { name: 'AHU-1 Surgery', systemType: 'hvac' }), 201).id;
  const eesLs = expectStatus(await c.post(`/projects/${project}/systems`, { name: 'EES Life Safety Branch', discipline: 'electrical', systemType: 'ees_life_safety' }), 201).id;
  const eesCrit = expectStatus(await c.post(`/projects/${project}/systems`, { name: 'EES Critical Branch', discipline: 'electrical', systemType: 'ees_critical' }), 201).id;
  const atsLs = expectStatus(await c.post(`/systems/${eesLs}/assets`, { tag: 'ATS-LS-1', assetType: 'ats', attributes: { branch: 'life_safety', served_panel: 'LS-2A' } }), 201).id;
  const atsCrit = expectStatus(await c.post(`/systems/${eesCrit}/assets`, { tag: 'ATS-CR-1', assetType: 'ats', attributes: { branch: 'critical', served_panel: 'CR-2A' } }), 201).id;
  const gen = expectStatus(await c.post(`/systems/${eesLs}/assets`, { tag: 'GEN-1', assetType: 'generator', attributes: { rating_kw: 1500, mfr_min_exhaust_temp_f: 650 } }), 201).id;

  return {
    app, db, adminUrl, appUrl, tenant, as, anon,
    ids: { project, building, phase, floor, dept, or, aiir, ahu, eesLs, eesCrit, atsLs, atsCrit, gen },
    async close() {
      await app.close();
      await db.end();
    },
  };
}
