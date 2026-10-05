// The server's gate, roles and saved analyses, end to end, on an in-memory
// store. Two servers: one with a dev identity (localhost only), one without.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function start(port, env) {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: '', XHOST_HTTP_PORT: String(port), ADMIN_EMAILS: 'boss@example.com, second@example.com', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(p); });
    p.stderr.on('data', (d) => reject(new Error(String(d))));
    setTimeout(() => reject(new Error('server did not start')), 8000);
  });
}

const call = async (port, method, path, body) => {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method, redirect: 'manual',
    headers: { Accept: path.startsWith('/api') ? 'application/json' : 'text/html', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text, location: res.headers.get('location') };
};

test('without a signed-in identity nothing is served', async (t) => {
  const s = await start(5301, {});
  t.after(() => s.kill());
  const page = await call(5301, 'GET', '/');
  assert.equal(page.status, 302);
  assert.match(page.location, /^\/xhost-auth\/login\?return_to=/);
  const js = await fetch('http://localhost:5301/js/app.js', { redirect: 'manual', headers: { Accept: '*/*' } });
  assert.equal(js.status, 401);
  assert.equal((await call(5301, 'GET', '/api/me')).status, 401);
});

test('an env admin manages users; a viewer cannot', async (t) => {
  const s = await start(5302, { DEV_USER_EMAIL: 'Boss@Example.com' });
  t.after(() => s.kill());
  const me = await call(5302, 'GET', '/api/me');
  assert.equal(me.json.role, 'admin');
  assert.equal(me.json.email, 'boss@example.com');
  assert.equal((await call(5302, 'GET', '/')).status, 200);

  assert.equal((await call(5302, 'POST', '/api/users', { email: 'a@b.co', role: 'viewer' })).status, 200);
  assert.equal((await call(5302, 'POST', '/api/users', { email: 'nope', role: 'viewer' })).status, 400);
  assert.equal((await call(5302, 'POST', '/api/users', { email: 'a@b.co', role: 'owner' })).status, 400);
  // Env admins cannot be demoted or removed from the UI.
  assert.equal((await call(5302, 'POST', '/api/users', { email: 'second@example.com', role: 'viewer' })).status, 409);
  assert.equal((await call(5302, 'DELETE', '/api/users/second%40example.com')).status, 409);
  const users = (await call(5302, 'GET', '/api/users')).json;
  assert.ok(users.find((u) => u.email === 'a@b.co' && u.role === 'viewer'));
  assert.ok(users.find((u) => u.email === 'second@example.com' && u.env_admin));
});

test('a signed-in user without a role is told so and recorded as pending', async (t) => {
  const s = await start(5303, { DEV_USER_EMAIL: 'stranger@example.com' });
  t.after(() => s.kill());
  const page = await call(5303, 'GET', '/');
  assert.equal(page.status, 403);
  assert.match(page.text, /stranger@example.com/);
  assert.equal((await call(5303, 'GET', '/api/analyses')).status, 403);
});

test('saved analyses: create, list, open by link, update, delete', async (t) => {
  const s = await start(5304, { DEV_USER_EMAIL: 'boss@example.com' });
  t.after(() => s.kill());
  const state = { areas: [{ id: 'a1', name: 'אזור 1', geom: null }], filters: {}, summary: { areas: ['אזור 1'] } };
  assert.equal((await call(5304, 'POST', '/api/analyses', { title: 'x', state: { nope: 1 } })).status, 400);
  const { id } = (await call(5304, 'POST', '/api/analyses', { title: 'צפון מול דרום', state })).json;
  assert.match(id, /^[\w-]{12}$/);
  const list = (await call(5304, 'GET', '/api/analyses')).json;
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'צפון מול דרום');
  const opened = (await call(5304, 'GET', `/api/analyses/${id}`)).json;
  assert.equal(opened.mine, true);
  assert.deepEqual(opened.state.areas[0].name, 'אזור 1');
  assert.equal((await call(5304, 'PUT', `/api/analyses/${id}`, { title: 'חדש', state })).status, 200);
  assert.equal((await call(5304, 'GET', `/api/analyses/${id}`)).json.title, 'חדש');
  assert.equal((await call(5304, 'DELETE', `/api/analyses/${id}`)).status, 200);
  assert.equal((await call(5304, 'GET', `/api/analyses/${id}`)).status, 404);
});

test('the health check (GET / with no Accept header) gets a redirect, not an error', async (t) => {
  const s = await start(5305, {});
  t.after(() => s.kill());
  const res = await fetch('http://localhost:5305/', { redirect: 'manual', headers: { Accept: '' } });
  assert.equal(res.status, 302);
});

test('a malformed or forged identity cookie is treated as signed out', async (t) => {
  const s = await start(5306, {});
  t.after(() => s.kill());
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const forged = `${b({ alg: 'none', typ: 'JWT' })}.${b({ iss: 'https://auth.xhostd.com', aud: 'localhost', email: 'boss@example.com', exp: 9999999999 })}.`;
  for (const value of ['%E0%A4%A', forged]) {
    const res = await fetch('http://localhost:5306/api/me', { headers: { Cookie: `__Host-xhost_id=${value}` } });
    assert.equal(res.status, 401);
  }
});

test('open sign-up: a new signed-in user becomes a viewer at once', async (t) => {
  const s = await start(5307, { DEV_USER_EMAIL: 'newcomer@example.com', OPEN_SIGNUP: 'true' });
  t.after(() => s.kill());
  const me = await call(5307, 'GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.role, 'viewer');
  assert.equal(me.json.open_signup, true);
  assert.equal((await call(5307, 'GET', '/api/users')).status, 403); // a viewer is not an admin
});

test('a blocked user stays out even with open sign-up', async (t) => {
  // One dev identity per process, so this checks the admin side: a user can be
  // set to blocked, an env admin cannot.
  const s = await start(5308, { DEV_USER_EMAIL: 'boss@example.com', OPEN_SIGNUP: 'true' });
  t.after(() => s.kill());
  assert.equal((await call(5308, 'POST', '/api/users', { email: 'bad@example.com', role: 'blocked' })).status, 200);
  assert.equal((await call(5308, 'POST', '/api/users', { email: 'second@example.com', role: 'blocked' })).status, 409);
  const users = (await call(5308, 'GET', '/api/users')).json;
  assert.equal(users.find((u) => u.email === 'bad@example.com').role, 'blocked');
});

test('only the email is kept about a user, and a shared link does not name its owner', async (t) => {
  const s = await start(5307, { DEV_USER_EMAIL: 'boss@example.com' });
  t.after(() => s.kill());
  const me = (await call(5307, 'GET', '/api/me')).json;
  assert.equal(me.name, undefined);
  for (const u of (await call(5307, 'GET', '/api/users')).json) {
    assert.deepEqual(Object.keys(u).sort(), ['added_by', 'created_at', 'email', 'env_admin', 'role']);
  }
  const state = { areas: [], filters: {}, summary: {} };
  const { id } = (await call(5307, 'POST', '/api/analyses', { title: 'x', state })).json;
  assert.equal((await call(5307, 'GET', `/api/analyses/${id}`)).json.owner, undefined);
});

test('every answer carries the security headers, the sign-in redirect included', async (t) => {
  const s = await start(5308, {});
  t.after(() => s.kill());
  const res = await fetch('http://localhost:5308/', { redirect: 'manual' });
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});
