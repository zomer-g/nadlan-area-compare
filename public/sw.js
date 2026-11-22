// The service worker: makes the site installable and lets the page itself open
// with no network. Registered from js/pwa.js, served from the site root with
// Cache-Control: no-cache (server.js) so a deploy is seen on the next visit.
//
// What it touches, and what it never does:
//   • The app shell (pages, js/, css/, icons, the layer manifest and the
//     external tables) is precached into one cache named after VERSION.
//     VERSION and SHELL are written by scripts/stamp.mjs, the same hash that
//     goes into every ?v= — so each deploy that changes a file installs a new
//     cache and the old one is deleted on activate.
//   • Deal data is live. Requests to OVER (over.org.il), to this server's
//     /api/ (which includes the OVER SQL proxy), to sign-in (/xhost-auth/) and
//     to /admin are not intercepted at all: no respondWith, so the browser
//     sends them exactly as before and js/over.js keeps its own timeout and
//     error handling. Nothing from them is ever written to a cache.
//   • Map tiles from OpenStreetMap / Esri and Nominatim search are left alone too.

const VERSION = '3de6768137';
const SHELL = ["/","/terms","/offline.html","/manifest.webmanifest","/css/style.css?v=3de6768137","/js/analysis.js?v=3de6768137","/js/app.js?v=3de6768137","/js/brush.js?v=3de6768137","/js/external.js?v=3de6768137","/js/layers.js?v=3de6768137","/js/over.js?v=3de6768137","/js/parcels.js?v=3de6768137","/js/pwa.js?v=3de6768137","/js/statexport.js?v=3de6768137","/js/stats.js?v=3de6768137","/js/util.js?v=3de6768137","/icons/apple-touch-icon.png","/icons/icon-192.png","/icons/icon-512.png","/icons/icon-maskable-512.png","/data/layers/manifest.json","/data/external/building_year_period.csv","/data/external/computed_parameters.csv","/data/external/gush_neighborhood.csv","/data/external/month_quarter.csv","/data/external/nature_asset_type.csv","/data/external/nature_use.csv","/data/external/settlements_cbs.csv","/data/external/size_groups.csv","/data/external/sources.json"];
const CACHE = `nadlan-shell-${VERSION}`;
const PREFIX = 'nadlan-shell-';
const OFFLINE = '/offline.html';

// Leaflet, Turf and Chart.js, exactly as index.html loads them (SRI, CORS).
// Versioned URLs, so cache-first is safe. Best effort: a CDN hiccup at install
// must not block the rest of the shell.
const CDN = [
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/@turf/turf@7.2.0/turf.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js',
];

// Paths that must always reach the server and are never cached.
const BYPASS = [/^\/api\//, /^\/xhost-auth\//, /^\/admin(\.html)?(\/|$)/];
// Re-checked every time the network is there (the page asks for them with
// cache: 'no-cache'); the cached copy is only for offline.
const REVALIDATE = [/^\/data\/external\//, /^\/data\/layers\/manifest\.json$/];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' skips the HTTP cache, so the precache is the deployed files.
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    await Promise.all(CDN.map((u) => cache.add(new Request(u, { mode: 'cors', credentials: 'omit' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === 'https://cdn.jsdelivr.net') {
    if (CDN.includes(url.href)) event.respondWith(cacheFirst(req));
    return;
  }
  if (url.origin !== self.location.origin) return; // OVER, map tiles, Nominatim: network only
  if (BYPASS.some((re) => re.test(url.pathname))) return;

  if (req.mode === 'navigate') return event.respondWith(page(req, url));
  if (REVALIDATE.some((re) => re.test(url.pathname))) return event.respondWith(networkFirst(req));
  event.respondWith(cacheFirst(req));
});

// A page: the cached copy (the query is ignored, so /?analysis=… and shared
// links open the cached index), else the network, else the offline page.
async function page(req, url) {
  const cache = await caches.open(CACHE);
  const path = url.pathname === '/index.html' ? '/' : url.pathname;
  const hit = await cache.match(path, { ignoreSearch: true })
    || (!path.endsWith('.html') && await cache.match(`${path}.html`, { ignoreSearch: true }));
  if (hit) return hit;
  try {
    return await fetch(req);
  } catch {
    return (await cache.match(OFFLINE)) || new Response('אין חיבור לרשת', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

// Shell files and layer tiles (tiles carry ?v=<build date>, so a rebuilt layer
// is a new URL). A miss is fetched and kept in this version's cache.
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && (res.type === 'basic' || res.type === 'cors')) cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}
