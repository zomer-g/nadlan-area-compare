// The app server: the site behind xhostd sign-in (Google SSO), user roles,
// and saved / shared analyses.
//
// Every request — page, script, data tile, API — passes the gate below. The
// platform blocks nothing at the edge, so a route that skipped it would be
// open to the internet.

import express from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { identity, loginUrl, LOGOUT_URL } from './server/auth.js';
import { createStore, roleOf, ROLES, ENV_ADMINS } from './server/store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'public');
const store = createStore();
await store.init();

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(compression()); // tiles and the deals payload are JSON: ~5x smaller

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Only a page navigation (Accept: text/html) is sent to sign in; scripts, tiles
// and API calls get a plain 401.
const wantsHtml = (req) => req.method === 'GET' && !req.path.startsWith('/api/') && (req.headers.accept || '').includes('text/html');

function page(title, body) {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>body{font-family:system-ui,Arial,sans-serif;max-width:560px;margin:12vh auto;padding:0 16px;line-height:1.6;color:#1f2937}
a,button{color:#2563eb}code{background:#f3f4f6;padding:0 .3rem;border-radius:4px}</style></head><body>${body}</body></html>`;
}

// ── the gate ────────────────────────────────────────────────────────────────
// Express 4 does not catch a rejected promise: every async handler goes
// through this, so a bad cookie or a database hiccup answers 500, not a hang.
const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error(e);
  if (!res.headersSent) res.status(500).json({ error: 'server error' });
});

app.use(safe(async (req, res, next) => {
  const who = await identity(req);
  if (!who) {
    if (wantsHtml(req)) return res.redirect(302, loginUrl(req.originalUrl));
    return res.status(401).json({ error: 'not signed in', login: loginUrl('/') });
  }
  const row = await store.getUser(who.email);
  const role = roleOf(who.email, row);
  await store.touch(who.email, who.name).catch(() => {});
  if (!role) {
    const body = `<h1>אין לך עדיין גישה</h1>
      <p>נכנסת בתור <code>${esc(who.email)}</code>. הבקשה שלך נרשמה, ומנהל/ת יכול/ה לאשר אותה בממשק ניהול המשתמשים.</p>
      <p><a href="${LOGOUT_URL}">התנתקות</a> (למשל כדי להיכנס בחשבון אחר)</p>`;
    if (wantsHtml(req)) return res.status(403).type('html').send(page('אין גישה', body));
    return res.status(403).json({ error: 'no access', email: who.email });
  }
  req.user = { ...who, role };
  next();
}));

// Bodies are read only for signed-in users with access.
app.use(express.json({ limit: '3mb' })); // a saved analysis carries its area polygons

const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'admins only' }));
const validEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

// ── API ─────────────────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  res.json({ email: req.user.email, name: req.user.name, role: req.user.role, logout: LOGOUT_URL, store: store.kind });
});

app.get('/api/users', adminOnly, safe(async (req, res) => {
  const rows = await store.listUsers();
  const byEmail = new Map(rows.map((u) => [u.email, u]));
  for (const e of ENV_ADMINS) if (!byEmail.has(e)) byEmail.set(e, { email: e, role: 'admin', name: '', created_at: null, last_seen: null });
  res.json([...byEmail.values()].map((u) => ({ ...u, role: roleOf(u.email, u) || 'pending', env_admin: ENV_ADMINS.has(u.email) })));
}));

app.post('/api/users', adminOnly, safe(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = req.body?.role;
  if (!validEmail(email)) return res.status(400).json({ error: 'כתובת מייל לא תקינה' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'role must be viewer or admin' });
  if (ENV_ADMINS.has(email) && role !== 'admin') return res.status(409).json({ error: 'מנהל שמוגדר במשתני הסביבה (ADMIN_EMAILS) — אי אפשר לשנות מהממשק' });
  await store.setUser(email, role, req.user.email);
  res.json({ ok: true });
}));

app.delete('/api/users/:email', adminOnly, safe(async (req, res) => {
  const email = String(req.params.email).toLowerCase();
  if (ENV_ADMINS.has(email)) return res.status(409).json({ error: 'מנהל שמוגדר במשתני הסביבה (ADMIN_EMAILS) — אי אפשר להסיר מהממשק' });
  if (email === req.user.email) return res.status(409).json({ error: 'אי אפשר להסיר את עצמך' });
  await store.deleteUser(email);
  res.json({ ok: true });
}));

// Saved analyses. Listing is per owner ("my analyses"); opening one by id is
// open to every user with access — that is what a shared link is.
const validState = (s) => s && typeof s === 'object' && Array.isArray(s.areas) && s.areas.length <= 50;
const cleanTitle = (t) => String(t || '').trim().slice(0, 120) || 'ניתוח ללא שם';

app.get('/api/analyses', safe(async (req, res) => res.json(await store.listAnalyses(req.user.email))));

app.get('/api/analyses/:id', safe(async (req, res) => {
  const a = await store.getAnalysis(String(req.params.id));
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json({ id: a.id, title: a.title, owner: a.owner, state: a.state, created_at: a.created_at, updated_at: a.updated_at, mine: a.owner === req.user.email });
}));

app.post('/api/analyses', safe(async (req, res) => {
  if (!validState(req.body?.state)) return res.status(400).json({ error: 'invalid analysis' });
  const id = await store.createAnalysis(req.user.email, cleanTitle(req.body.title), req.body.state);
  res.json({ id });
}));

app.put('/api/analyses/:id', safe(async (req, res) => {
  const a = await store.getAnalysis(String(req.params.id));
  if (!a) return res.status(404).json({ error: 'not found' });
  if (a.owner !== req.user.email) return res.status(403).json({ error: 'only the owner can change it' });
  if (!validState(req.body?.state)) return res.status(400).json({ error: 'invalid analysis' });
  await store.updateAnalysis(a.id, cleanTitle(req.body.title), req.body.state);
  res.json({ ok: true });
}));

app.delete('/api/analyses/:id', safe(async (req, res) => {
  const a = await store.getAnalysis(String(req.params.id));
  if (!a) return res.status(404).json({ error: 'not found' });
  if (a.owner !== req.user.email && req.user.role !== 'admin') return res.status(403).json({ error: 'only the owner can delete it' });
  await store.deleteAnalysis(a.id);
  res.json({ ok: true });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'no such route' }));

// ── pages and static files (after the gate) ─────────────────────────────────
app.get('/admin', adminOnly, (req, res) => res.sendFile(join(ROOT, 'admin.html')));
app.use(express.static(ROOT, {
  index: 'index.html',
  setHeaders(res, path) {
    // HTML always revalidates; versioned assets (?v=) and tiles may be cached.
    if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'private, max-age=86400');
  },
}));

const port = Number(process.env.XHOST_HTTP_PORT || process.env.PORT || 5190);
app.listen(port, '0.0.0.0', () => console.log(`listening on 0.0.0.0:${port} (store: ${store.kind}, env admins: ${ENV_ADMINS.size})`));
