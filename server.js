// The app server: the site itself is open to everyone, with no sign-in. The
// analysis runs in the browser against OVER; favourites live in the viewer's
// browser and a shared link carries the analysis in its #fragment, so the
// server keeps nothing about visitors.
//
// xhostd sign-in (Google SSO) remains for two things only: the admin page, and
// analyses that were saved to an account before the site was opened (their
// owners can still list and delete them; their ?analysis=<id> links still open
// for anyone).

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

// Security headers on every answer, the sign-in redirect included. No framing
// (clickjacking of the admin page); the referrer policy keeps the browser
// default explicit — OSM's tile servers require a Referer, and it sends them
// only the origin, never a shared link's path.
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});


// ── who is asking (optional) ────────────────────────────────────────────────
// Express 4 does not catch a rejected promise: every async handler goes
// through this, so a bad cookie or a database hiccup answers 500, not a hang.
const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error(e);
  if (!res.headersSent) res.status(500).json({ error: 'server error' });
});

// Nothing is written here: a visit, signed in or not, leaves no row behind.
app.use(safe(async (req, res, next) => {
  const who = await identity(req);
  req.user = who ? { email: who.email, role: roleOf(who.email, await store.getUser(who.email)) } : null;
  next();
}));

// A page navigation is sent to sign in; an API call gets a plain 401.
const signedIn = (req, res, next) => {
  if (req.user) return next();
  if (req.method === 'GET' && !req.originalUrl.startsWith('/api/')) return res.redirect(302, loginUrl(req.originalUrl));
  return res.status(401).json({ error: 'not signed in', login: loginUrl('/') });
};
const adminOnly = [signedIn, (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'admins only' }))];

// Bodies are read only from admins (the user list is the only thing posted).
app.use('/api/users', adminOnly, express.json({ limit: '10kb' }));
const validEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

// ── API ─────────────────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ signed_in: false, login: loginUrl('/') });
  res.json({ signed_in: true, email: req.user.email, role: req.user.role, logout: LOGOUT_URL, store: store.kind });
});

app.get('/api/users', adminOnly, safe(async (req, res) => {
  const rows = await store.listUsers();
  const byEmail = new Map(rows.map((u) => [u.email, u]));
  for (const e of ENV_ADMINS) if (!byEmail.has(e)) byEmail.set(e, { email: e, role: 'admin', added_by: null, created_at: null });
  res.json([...byEmail.values()].map((u) => ({ ...u, role: roleOf(u.email, u) || 'viewer', env_admin: ENV_ADMINS.has(u.email) })));
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

// Analyses saved to an account before the site was opened. New ones are saved
// in the browser instead, so there is no create or update here: the owner can
// list and delete theirs, and anyone with a link (an unguessable id) opens it.
// The reply does not say who saved it, only whether it is yours.
app.get('/api/analyses', signedIn, safe(async (req, res) => res.json(await store.listAnalyses(req.user.email))));

app.get('/api/analyses/:id', safe(async (req, res) => {
  const a = await store.getAnalysis(String(req.params.id));
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json({ id: a.id, title: a.title, state: a.state, created_at: a.created_at, updated_at: a.updated_at, mine: a.owner === req.user?.email });
}));

app.delete('/api/analyses/:id', signedIn, safe(async (req, res) => {
  const a = await store.getAnalysis(String(req.params.id));
  if (!a) return res.status(404).json({ error: 'not found' });
  if (a.owner !== req.user.email && req.user.role !== 'admin') return res.status(403).json({ error: 'only the owner can delete it' });
  await store.deleteAnalysis(a.id);
  res.json({ ok: true });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'no such route' }));

// ── pages and static files ──────────────────────────────────────────────────
// admin.html is static too, but it is only the page: everything it shows comes
// from /api/users, which is admins only.
app.get(['/admin', '/admin.html'], adminOnly, (req, res) => res.sendFile(join(ROOT, 'admin.html')));
app.use(express.static(ROOT, {
  index: 'index.html',
  extensions: ['html'], // /terms serves terms.html
  setHeaders(res, path) {
    // HTML always revalidates; versioned assets (?v=) and tiles may be cached.
    if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'private, max-age=86400');
  },
}));

// xhostd renamed XHOST_* to XHOSTD_* (2026-10); the old name and PORT stay as fallbacks.
const port = Number(process.env.XHOSTD_HTTP_PORT || process.env.XHOST_HTTP_PORT || process.env.PORT || 5190);
app.listen(port, '0.0.0.0', () => console.log(`listening on 0.0.0.0:${port} (store: ${store.kind}, env admins: ${ENV_ADMINS.size}, open to all)`));
