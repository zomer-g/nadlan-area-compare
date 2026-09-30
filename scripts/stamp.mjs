// Cache-busting for a static site with no build step.
//
// The host sends no Cache-Control header, so browsers apply heuristic caching
// and can keep an old app.js next to a new index.html (seen 2026-09-30: the new
// page ran yesterday's module). This stamps ?v=<hash of every asset> onto the
// stylesheet and script in index.html and onto every relative module import,
// so each deploy that changes any file changes every URL.
//
//   node scripts/stamp.mjs        (run before each commit that ships)

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsFiles = readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js')).map((f) => join('js', f));
const hashed = [...jsFiles, 'css/style.css', 'index.html'];

// Hash the contents with any previous stamps removed, so re-running is stable.
const unstamp = (s) => s.replace(/\?v=[0-9a-f]{10}/g, '');
const h = createHash('sha256');
for (const f of hashed.sort()) h.update(unstamp(readFileSync(join(root, f), 'utf8')));
const v = h.digest('hex').slice(0, 10);

for (const f of jsFiles) {
  const p = join(root, f);
  const src = unstamp(readFileSync(p, 'utf8'));
  writeFileSync(p, src.replace(/(from\s+'\.\/[\w-]+\.js)'/g, `$1?v=${v}'`));
}
const ip = join(root, 'index.html');
writeFileSync(ip, unstamp(readFileSync(ip, 'utf8'))
  .replace('src="js/app.js"', `src="js/app.js?v=${v}"`)
  .replace('href="css/style.css"', `href="css/style.css?v=${v}"`));
console.log(`stamped v=${v}`);
