// Cache-busting for a static site with no build step.
//
// The host sends no Cache-Control header, so browsers apply heuristic caching
// and can keep an old app.js next to a new index.html (seen 2026-09-30: the new
// page ran yesterday's module). This stamps ?v=<hash of every asset> onto the
// stylesheet and script in index.html and onto every relative module import,
// so each deploy that changes any file changes every URL.
//
// The same hash names the service worker's cache (public/sw.js: VERSION), and
// the list of files it precaches (SHELL) is written here too, with the stamped
// URLs. A deploy that changes any file therefore changes sw.js, the browser
// installs the new worker, and it drops the previous version's cache.
//
//   node scripts/stamp.mjs        (run before each commit that ships)

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const jsFiles = readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`);
const icons = readdirSync(join(root, 'icons')).filter((f) => f.endsWith('.png')).map((f) => `icons/${f}`);
const external = readdirSync(join(root, 'data', 'external')).filter((f) => /\.(csv|json)$/.test(f)).map((f) => `data/external/${f}`);
const hashed = [...jsFiles, 'css/style.css', 'index.html', 'admin.html', 'terms.html', 'offline.html', 'manifest.webmanifest', 'sw.js', 'data/layers/manifest.json', ...external];

// Hash the contents with any previous stamps removed, so re-running is stable.
const unstampSw = (s) => s.replace(/^const VERSION = '[^']*';$/m, "const VERSION = '';").replace(/^const SHELL = \[[^\]]*\];$/m, 'const SHELL = [];');
const unstamp = (s) => unstampSw(s.replace(/\?v=[0-9a-f]{10}/g, ''));
const h = createHash('sha256');
for (const f of hashed.sort()) h.update(unstamp(readFileSync(join(root, f), 'utf8')));
for (const f of icons.sort()) h.update(readFileSync(join(root, f)));
const v = h.digest('hex').slice(0, 10);

for (const f of jsFiles) {
  const p = join(root, f);
  const src = unstamp(readFileSync(p, 'utf8'));
  writeFileSync(p, src.replace(/((?:from|import)\s+'\.\/[\w-]+\.js)'/g, `$1?v=${v}'`));
}
for (const [html, script] of [['index.html', 'js/app.js'], ['admin.html', 'js/admin.js'], ['terms.html', null]]) {
  const ip = join(root, html);
  writeFileSync(ip, unstamp(readFileSync(ip, 'utf8'))
    .replace(`src="${script}"`, `src="${script}?v=${v}"`)
    .replace('href="css/style.css"', `href="css/style.css?v=${v}"`));
}

// The service worker's precache: what the main page and its modules request,
// at the exact URLs they request (so cache hits need no query matching). Not
// admin (signed-in only, never cached) and not the layer tiles: those are 20 MB,
// so they are cached as the map asks for them, not all up front.
const shell = [
  '/', '/terms', '/offline.html', '/manifest.webmanifest', `/css/style.css?v=${v}`,
  ...jsFiles.filter((f) => f !== 'js/admin.js').map((f) => `/${f}?v=${v}`),
  ...icons.map((f) => `/${f}`),
  '/data/layers/manifest.json', ...external.map((f) => `/${f}`),
];
const sw = join(root, 'sw.js');
const swSrc = unstampSw(readFileSync(sw, 'utf8'));
if (!swSrc.includes("const VERSION = '';") || !swSrc.includes('const SHELL = [];')) throw new Error('sw.js: VERSION / SHELL lines not found');
writeFileSync(sw, swSrc
  .replace("const VERSION = '';", `const VERSION = '${v}';`)
  .replace('const SHELL = [];', `const SHELL = ${JSON.stringify(shell)};`));
console.log(`stamped v=${v} (service worker precache: ${shell.length} files)`);
