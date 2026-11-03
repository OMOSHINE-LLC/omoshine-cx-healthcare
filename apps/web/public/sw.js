/*
 * OMOSHINE CX Planner service worker.
 * - App shell and built assets are cached so the app opens without a connection.
 * - API reads are network-first; the last good response is kept per signed-in person
 *   and served only when the network is unavailable. Signing out clears them.
 * - Writes always go to the network; the app itself queues allowed field entries offline.
 * No patient information is handled by this product.
 */
const VERSION = 'v1';
const SHELL = `omoshine-shell-${VERSION}`;
const API = `omoshine-api-${VERSION}`;
const SHELL_FILES = ['/', '/index.html', '/omoshine-logo.png', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(SHELL_FILES);
    // Precache the built scripts and styles the shell references, so the app opens offline.
    const html = await (await cache.match('/index.html')).text();
    const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))];
    await cache.addAll(assets);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== API) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'clear-api-cache') event.waitUntil(caches.delete(API));
});

/** Cache key that includes the person, so one person's cached reads are never shown to another on a shared device. */
function apiKey(request) {
  const auth = request.headers.get('authorization') || '';
  let sub = 'anon';
  try { sub = JSON.parse(atob(auth.slice(7).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub || 'anon'; } catch (e) { /* api key or none */ }
  const u = new URL(request.url);
  u.searchParams.set('__omoshine_user', sub);
  return u.toString();
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin || req.method !== 'GET') return;

  if (url.pathname.startsWith('/api/')) {
    if (url.pathname.startsWith('/api/v1/auth/') || url.pathname.endsWith('/report') || url.pathname.includes('/exports/')) return;
    event.respondWith((async () => {
      const key = apiKey(req);
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(API)).put(key, res.clone());
        return res;
      } catch (e) {
        const hit = await (await caches.open(API)).match(key, { ignoreVary: true });
        if (hit) return hit;
        return new Response(JSON.stringify({ title: 'You are offline and this page has not been opened on this device yet', status: 503 }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
    })());
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(async () => (await caches.open(SHELL)).match('/index.html', { ignoreVary: true })));
    return;
  }

  if (url.pathname.startsWith('/assets/') || SHELL_FILES.includes(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(url.pathname, { ignoreVary: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(url.pathname, res.clone());
      return res;
    })());
  }
});
