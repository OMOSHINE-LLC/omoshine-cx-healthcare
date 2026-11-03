import pg from 'pg';
import { config } from './config.js';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url = config.databaseUrl): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

/**
 * Run fn in a transaction scoped to one tenant. Row-level security policies
 * read app.tenant_id, so a query can never see another tenant's rows.
 */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
