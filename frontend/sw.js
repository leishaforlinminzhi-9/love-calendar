// Lets the app open like an installed one, even with no network.
// Strategy: the network first, always revalidated, so a file the host has since replaced is never served from here;
// the stored copy is only used when the network is not available. Backend calls (another origin) are never touched,
// and neither is version.json, because the update check has to see the real answer.

const CACHE = 'love-shell';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // never stored: the update check, this file itself, and the backend when it is served from the same origin (a local run)
  if (/\/(version\.json|sw\.js)$/.test(url.pathname) || url.pathname.includes('/api/')) return;
  event.respondWith(networkThenStored(event, request, url));
});

async function networkThenStored(event, request, url) {
  const cache = await caches.open(CACHE);
  const isPage = request.mode === 'navigate';
  const key = isPage ? new Request(url.origin + url.pathname) : request; // ?v=… or ?debug on the page's address does not matter
  try {
    const res = await fetch(request, { cache: 'no-cache' });
    if (res.status === 200 && res.type === 'basic') event.waitUntil(keep(cache, key, res.clone(), isPage ? null : url));
    return res;
  } catch {
    return (await cache.match(key)) ?? (await cache.match(key, { ignoreSearch: true })) ?? Response.error();
  }
}

// keep one version of every file: drop the same file stored under an older ?v= stamp
async function keep(cache, key, res, assetUrl) {
  await cache.put(key, res);
  if (!assetUrl) return;
  for (const old of await cache.keys()) {
    const u = new URL(old.url);
    if (u.pathname === assetUrl.pathname && u.search !== assetUrl.search) await cache.delete(old);
  }
}
