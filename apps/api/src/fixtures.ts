import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { hashPin } from './crypto.js';

export interface SeededTenant {
  tenantId: string;
  orgs: Record<'owner' | 'cxa' | 'gc' | 'tab' | 'ahj' | 'elec', string>;
  users: Record<'admin' | 'cxa' | 'gc' | 'tab' | 'ahj' | 'clinical' | 'outsider', { id: string; email: string }>;
  pin: string;
}

/**
 * Create a tenant with organisations and users using the OWNER connection
 * (bypasses RLS). Used by tests and the demo seed script.
 */
export async function seedTenant(adminUrl: string, label = randomUUID().slice(0, 8), pin = '2468'): Promise<SeededTenant> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const tenantId = (await c.query<{ id: string }>('INSERT INTO tenant (name, license_key) VALUES ($1,$2) RETURNING id', [`Hospital ${label}`, `HC-${label}-${randomUUID()}`])).rows[0]!.id;
    const org = async (name: string, kind: string) =>
      (await c.query<{ id: string }>('INSERT INTO organization (tenant_id, name, kind) VALUES ($1,$2,$3) RETURNING id', [tenantId, name, kind])).rows[0]!.id;
    const orgs = {
      owner: await org('Riverside Health – Facilities', 'owner'),
      cxa: await org('Meridian Commissioning', 'cxa'),
      gc: await org('Summit Builders', 'gc'),
      tab: await org('Precision Air Balance', 'tab'),
      ahj: await org('County Fire Marshal', 'ahj'),
      elec: await org('Volt Electrical', 'trade'),
    };
    const pinHash = hashPin(pin);
    const user = async (key: string, name: string, orgId: string, admin = false) => {
      const email = `${key}.${label}@example.test`;
      const id = (await c.query<{ id: string }>(
        'INSERT INTO app_user (tenant_id, organization_id, email, name, is_tenant_admin, signing_pin_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [tenantId, orgId, email, name, admin, pinHash],
      )).rows[0]!.id;
      return { id, email };
    };
    const users = {
      admin: await user('admin', 'Dana Facilities', orgs.owner, true),
      cxa: await user('cxa', 'Avery CxA', orgs.cxa),
      gc: await user('gc', 'Jordan GC', orgs.gc),
      tab: await user('tab', 'Riley TAB', orgs.tab),
      ahj: await user('ahj', 'Morgan Inspector', orgs.ahj),
      clinical: await user('clinical', 'Casey Charge Nurse', orgs.owner),
      outsider: await user('outsider', 'Pat Unassigned', orgs.gc),
    };
    return { tenantId, orgs, users, pin };
  } finally {
    await c.end();
  }
}
