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

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
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
