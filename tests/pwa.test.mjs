// The installable app: the manifest, the icons, the service worker's routing
// (OVER and the server's own API are never intercepted), the stamp that ties
// its cache to the deploy, and how server.js serves the two.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('..', import.meta.url));
const pub = (p) => `${root}public/${p}`;
const read = (p) => readFileSync(pub(p), 'utf8');

test('the manifest has what Chrome needs to install, in Hebrew and RTL', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.lang, 'he');
  assert.equal(m.dir, 'rtl');
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.match(m.name, /[֐-׿]/);
  assert.match(m.short_name, /[֐-׿]/);
  // The colours are the stylesheet's --accent and --bg.
  const css = read('css/style.css');
  assert.ok(css.includes(`--accent: ${m.theme_color};`));
  assert.ok(css.includes(`--bg: ${m.background_color};`));
  const want = [['192x192', 'any', 192], ['512x512', 'any', 512], ['512x512', 'maskable', 512]];
  for (const [sizes, purpose, px] of want) {
    const icon = m.icons.find((i) => i.sizes === sizes && i.purpose === purpose);
    assert.ok(icon, `${sizes} ${purpose}`);
    const png = readFileSync(pub(icon.src.slice(1)));
    assert.equal(png.readUInt32BE(16), px); // IHDR width
    assert.equal(png.readUInt32BE(20), px); // IHDR height
  }
});

test('every page links the manifest, the theme colour and the Apple tags', () => {
  for (const page of ['index.html', 'admin.html', 'terms.html']) {
    const html = read(page);
    for (const tag of ['rel="manifest" href="/manifest.webmanifest"', 'name="theme-color"', 'rel="apple-touch-icon"', 'name="apple-mobile-web-app-capable"', 'name="apple-mobile-web-app-title"']) {
      assert.ok(html.includes(tag), `${page}: ${tag}`);
    }
  }
  assert.ok(existsSync(pub('icons/apple-touch-icon.png')));
  const offline = read('offline.html');
  assert.match(offline, /<html lang="he" dir="rtl">/);
});

test('the service worker is stamped with the deploy hash, and everything it precaches exists', () => {
  const sw = read('sw.js');
  const v = sw.match(/^const VERSION = '([0-9a-f]{10})';$/m)?.[1];
  assert.ok(v, 'run npm run stamp');
  assert.ok(read('index.html').includes(`js/app.js?v=${v}`), 'sw.js and index.html carry the same stamp');
  const shell = JSON.parse(sw.match(/^const SHELL = (\[.*\]);$/m)[1]);
  for (const u of shell) {
    if (u === '/') continue;
    const [path, q] = u.slice(1).split('?');
    const file = existsSync(pub(path)) ? path : `${path}.html`;
    assert.ok(existsSync(pub(file)), u);
    if (q) assert.equal(q, `v=${v}`, u);
  }
  for (const must of ['/', '/offline.html', '/js/app.js', '/js/over.js', '/js/pwa.js', '/css/style.css', '/data/layers/manifest.json']) {
    assert.ok(shell.some((u) => u.split('?')[0] === must), must);
  }
  assert.ok(!shell.some((u) => /admin|\/api\/|xhost-auth/.test(u)), 'nothing signed-in is precached');
});

// Load sw.js in a sandbox and see which requests it answers.
function loadWorker() {
  const listeners = {};
  const self = {
    location: new URL('https://nadlan.example/sw.js'),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting() {}, clients: { claim() {} },
  };
  vm.runInNewContext(read('sw.js'), { self, URL, Request, Response, caches: {}, fetch() { throw new Error('no fetch in test'); } });
  return (url, { method = 'GET', mode = 'cors' } = {}) => {
    let answered = false;
    listeners.fetch({ request: { url, method, mode }, respondWith(p) { answered = true; p?.catch?.(() => {}); } });
    return answered;
  };
}

test('OVER, the API, sign-in and admin always go to the network untouched', () => {
  const handles = loadWorker();
  for (const url of [
    'https://www.over.org.il/api/deals/stats',
    'https://over.org.il/api/append/abc/sql',
    'https://www.over.org.il/data?q=xyz',
    'https://nadlan.example/api/over/sql',
    'https://nadlan.example/api/me',
    'https://nadlan.example/api/analyses/123',
    'https://nadlan.example/xhost-auth/login?return_to=%2F',
    'https://nadlan.example/xhost-auth/logout?return_to=/',
    'https://nadlan.example/admin',
    'https://nadlan.example/admin.html',
    'https://a.tile.openstreetmap.org/12/1/2.png',
    'https://nominatim.openstreetmap.org/search?q=x',
  ]) {
    assert.equal(handles(url), false, url);
    assert.equal(handles(url, { mode: 'navigate' }), false, `${url} (navigation)`);
  }
  assert.equal(handles('https://nadlan.example/api/over/sql', { method: 'POST' }), false);
});

test('the shell, the layers and pages are answered by the worker', () => {
  const handles = loadWorker();
  for (const url of [
    'https://nadlan.example/js/app.js?v=0123456789',
    'https://nadlan.example/css/style.css?v=0123456789',
    'https://nadlan.example/data/layers/nbr/345_314.json?v=2026-10-02',
    'https://nadlan.example/data/layers/manifest.json',
    'https://nadlan.example/data/external/sources.json',
    'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
  ]) assert.equal(handles(url), true, url);
  assert.equal(handles('https://nadlan.example/?analysis=abc', { mode: 'navigate' }), true);
  assert.equal(handles('https://nadlan.example/terms', { mode: 'navigate' }), true);
  assert.equal(handles('https://cdn.jsdelivr.net/npm/something-else@1/x.js'), false);
});

test('server.js serves the manifest as application/manifest+json and the worker with no-cache', async (t) => {
  const port = 5311;
  const p = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: '', XHOST_HTTP_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => p.kill());
  await new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
    p.stderr.on('data', (d) => reject(new Error(String(d))));
    setTimeout(() => reject(new Error('server did not start')), 8000);
  });
  const m = await fetch(`http://localhost:${port}/manifest.webmanifest`);
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type'), /^application\/manifest\+json/);
  const sw = await fetch(`http://localhost:${port}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
  const off = await fetch(`http://localhost:${port}/offline.html`);
  assert.equal(off.status, 200);
  const js = await fetch(`http://localhost:${port}/js/app.js`);
  assert.equal(js.headers.get('cache-control'), 'private, max-age=86400');
});
