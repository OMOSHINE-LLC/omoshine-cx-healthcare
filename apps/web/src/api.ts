import { enqueue, isOffline, offlineRouteFor } from './offline';
const TOKEN_KEY = 'omoshine.session';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: session lasts for this page only */
  }
}

/** Returned instead of the server's response when a field entry was saved on the device to send later. */
export interface QueuedOffline { queuedOffline: true; label: string }
export const OFFLINE_SAVED = 'Saved on this device while offline. It will be sent when the connection returns.';
export const isQueued = (r: unknown): r is QueuedOffline => !!r && typeof r === 'object' && (r as QueuedOffline).queuedOffline === true;

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean } = {}): Promise<T> {
  const token = getToken();
  const method = init.method ?? (init.body ? 'POST' : 'GET');
  if (method === 'POST' && isOffline() && offlineRouteFor(path) && !init.headers?.['x-reauth-token']) {
    const e = await enqueue(path, (init.body ?? {}) as Record<string, unknown>, token);
    return { queuedOffline: true, label: e.label } as T;
  }
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    setToken(null);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).title ?? msg;
    } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  if (init.raw) return (await res.text()) as T;
  return res.json() as Promise<T>;
}

/** Fetch an authenticated HTML report and open it in a new tab. */
export async function openReport(path: string) {
  const html = await api<string>(path, { raw: true });
  const url = URL.createObjectURL(new Blob([html.replace(/\/brand\/logo\.png/g, `${location.origin}/brand/logo.png`)], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
}

/** Fetch an authenticated file and save it with the given name. */
export async function download(path: string, filename: string) {
  const res = await fetch(`/api/v1${path}`, { headers: { authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
