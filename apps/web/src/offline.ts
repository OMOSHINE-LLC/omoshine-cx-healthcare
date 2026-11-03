/**
 * Offline field entries. Fire watch patrols, daily ICRA logs and life safety
 * inspections made while the device is offline are kept on the device and sent
 * when the connection returns, with the time they were actually recorded.
 *
 * Only requests that never left the device are queued (the browser reports
 * offline), so a replay can never duplicate an entry the server already has.
 * E-signatures are never queued: they need a live re-authentication.
 * Entries replay only for the person who recorded them.
 */

export interface QueuedEntry {
  id: string;
  userId: string;
  path: string;
  body: Record<string, unknown>;
  label: string;
  queuedAt: string;
  lastError?: string;
}

/** Field entries that may be recorded offline, and the body field that carries when they happened. */
const OFFLINE_ROUTES: { pattern: RegExp; timeField: string; label: string; timeKind: 'datetime' | 'date' }[] = [
  { pattern: /^\/ilsm-assessments\/[0-9a-f-]{36}\/fire-watch$/, timeField: 'patrolledAt', label: 'Fire watch patrol', timeKind: 'datetime' },
  { pattern: /^\/icra-zones\/[0-9a-f-]{36}\/logs$/, timeField: 'loggedAt', label: 'ICRA daily log', timeKind: 'datetime' },
  { pattern: /^\/ls-items\/[0-9a-f-]{36}\/inspections$/, timeField: 'performedOn', label: 'Life safety inspection', timeKind: 'date' },
];

export const offlineRouteFor = (path: string) => OFFLINE_ROUTES.find((r) => r.pattern.test(path));

// --- storage: IndexedDB, with an in-memory fallback when it is unavailable -----------
const DB = 'omoshine-offline';
const STORE = 'queue';
let memory: QueuedEntry[] = [];

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const r = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(r.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function allQueued(): Promise<QueuedEntry[]> {
  const rows = await withStore('readonly', (s) => s.getAll() as IDBRequest<QueuedEntry[]>).catch(() => null);
  return (rows ?? memory).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}
async function put(e: QueuedEntry) {
  const ok = await withStore('readwrite', (s) => s.put(e)).catch(() => null);
  if (ok === null) memory = [...memory.filter((m) => m.id !== e.id), e];
}
async function remove(id: string) {
  const ok = await withStore('readwrite', (s) => s.delete(id)).catch(() => null);
  if (ok === null) memory = memory.filter((m) => m.id !== id);
}

// --- queue -------------------------------------------------------------------------
type Listener = () => void;
const listeners = new Set<Listener>();
export const onQueueChange = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };
const changed = () => listeners.forEach((l) => l());

/** The signed-in person, from the session token (no verification needed: the server checks it on replay). */
export function userIdOf(token: string | null): string | null {
  if (!token) return null;
  try { return JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))).sub ?? null; } catch { return null; }
}

export function isOffline() { return typeof navigator !== 'undefined' && navigator.onLine === false; }

export async function enqueue(path: string, body: Record<string, unknown>, token: string | null): Promise<QueuedEntry> {
  const route = offlineRouteFor(path)!;
  const userId = userIdOf(token);
  if (!userId) throw new Error('Sign in again to record offline');
  const now = new Date().toISOString();
  const entry: QueuedEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, userId, path, label: route.label, queuedAt: now,
    // Keep the time the entry was actually made.
    body: { ...body, [route.timeField]: body[route.timeField] ?? (route.timeKind === 'date' ? localDate() : now) },
  };
  await put(entry);
  changed();
  return entry;
}

const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

let replaying: Promise<{ sent: number; failed: number }> | null = null;
/**
 * Send this person's queued entries, oldest first. A refusal from the server (for example the
 * assessment was resolved meanwhile) keeps the entry with its error so it can be reviewed and discarded.
 */
export function replay(send: (path: string, body: unknown) => Promise<void>, token: string | null): Promise<{ sent: number; failed: number }> {
  replaying ??= (async () => {
    let sent = 0, failed = 0;
    const me = userIdOf(token);
    for (const e of await allQueued()) {
      if (e.userId !== me) continue;
      if (isOffline()) break;
      try { await send(e.path, e.body); await remove(e.id); sent++; } catch (x) {
        if (x instanceof TypeError) break; // network dropped again
        await put({ ...e, lastError: (x as Error).message }); failed++;
      }
    }
    changed();
    return { sent, failed };
  })().finally(() => { replaying = null; });
  return replaying;
}

export async function discard(id: string) { await remove(id); changed(); }
