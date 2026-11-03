import { canonicalJson, sha256 } from './crypto.js';
import type { Tx } from './db.js';
import { enqueueWebhooks } from './webhooks.js';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEntry {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  data: unknown;
}

function entryHash(prevHash: string, tenantId: string, e: AuditEntry, at: Date): string {
  return sha256(
    prevHash +
      canonicalJson({ tenantId, actorId: e.actorId, action: e.action, entityType: e.entityType, entityId: e.entityId, data: e.data, at }),
  );
}

/**
 * Append to the tenant's hash-chained audit log inside the caller's transaction.
 * A per-tenant advisory lock serialises writers so the chain never forks.
 */
export async function appendAudit(tx: Tx, tenantId: string, e: AuditEntry): Promise<string> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${tenantId}`]);
  const prev = await tx.query<{ hash: string }>('SELECT hash FROM audit_log WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1', [tenantId]);
  const prevHash = prev.rows[0]?.hash ?? GENESIS_HASH;
  const at = new Date();
  // Round-trip through canonical JSON so what we hash is exactly what jsonb stores and returns.
  const data = JSON.parse(canonicalJson(e.data ?? {}));
  const hash = entryHash(prevHash, tenantId, { ...e, data }, at);
  await tx.query(
    `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, data, at, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [tenantId, e.actorId, e.action, e.entityType, e.entityId, JSON.stringify(data), at, prevHash, hash],
  );
  await enqueueWebhooks(tx, tenantId, e, data, at);
  return hash;
}

/** Recompute the whole chain; returns the first broken sequence number if any. */
export async function verifyAuditChain(tx: Tx, tenantId: string): Promise<{ ok: boolean; entries: number; brokenAt?: number }> {
  const rows = await tx.query<{
    seq: string; actor_id: string | null; action: string; entity_type: string; entity_id: string; data: unknown; at: Date; prev_hash: string; hash: string;
  }>('SELECT * FROM audit_log WHERE tenant_id = $1 ORDER BY seq', [tenantId]);
  let prev = GENESIS_HASH;
  for (const r of rows.rows) {
    const expected = entryHash(prev, tenantId, { actorId: r.actor_id, action: r.action, entityType: r.entity_type, entityId: r.entity_id, data: r.data }, r.at);
    if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, entries: rows.rows.length, brokenAt: Number(r.seq) };
    prev = r.hash;
  }
  return { ok: true, entries: rows.rows.length };
}
