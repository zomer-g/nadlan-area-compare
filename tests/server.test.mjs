// The open site, admin roles and account analyses, end to end, on an in-memory
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

test('without signing in the whole site is served, and only admin routes ask for sign-in', async (t) => {
  const s = await start(5301, {});
  t.after(() => s.kill());
  assert.equal((await call(5301, 'GET', '/')).status, 200);
  const js = await fetch('http://localhost:5301/js/app.js', { headers: { Accept: '*/*' } });
  assert.equal(js.status, 200);
  const me = await call(5301, 'GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.signed_in, false);
  assert.match(me.json.login, /^\/xhost-auth\/login\?return_to=/);
  for (const path of ['/admin', '/admin.html']) {
    const page = await call(5301, 'GET', path);
    assert.equal(page.status, 302);
    assert.match(page.location, /^\/xhost-auth\/login\?return_to=/);
  }
  assert.equal((await call(5301, 'GET', '/api/users')).status, 401);
  assert.equal((await call(5301, 'POST', '/api/users', { email: 'a@b.co', role: 'admin' })).status, 401);
  assert.equal((await call(5301, 'GET', '/api/analyses')).status, 401);
  // The server no longer stores analyses: there is nothing to post to.
  assert.equal((await call(5301, 'POST', '/api/analyses', { title: 'x', state: { areas: [] } })).status, 404);
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

test('a signed-in user who is not an admin uses the site but not the admin page', async (t) => {
  const s = await start(5303, { DEV_USER_EMAIL: 'stranger@example.com' });
  t.after(() => s.kill());
  assert.equal((await call(5303, 'GET', '/')).status, 200);
  const me = (await call(5303, 'GET', '/api/me')).json;
  assert.equal(me.signed_in, true);
  assert.equal(me.role, null);
  assert.equal((await call(5303, 'GET', '/admin')).status, 403);
  assert.equal((await call(5303, 'GET', '/api/users')).status, 403);
  assert.deepEqual((await call(5303, 'GET', '/api/analyses')).json, []);
});

test('analyses saved to an account before: anyone opens the link, only the owner lists and deletes', async (t) => {
  const state = { areas: [{ id: 'a1', name: 'אזור 1', geom: null }], filters: {}, summary: { areas: ['אזור 1'] } };
  const seed = JSON.stringify([{ id: 'abcdefghijkl', owner: 'boss@example.com', title: 'צפון מול דרום', state }]);
  const anon = await start(5304, { TEST_SEED_ANALYSES: seed });
  t.after(() => anon.kill());
  const opened = (await call(5304, 'GET', '/api/analyses/abcdefghijkl')).json;
  assert.equal(opened.title, 'צפון מול דרום');
  assert.equal(opened.mine, false);
  assert.equal(opened.owner, undefined); // a shared link does not name who saved it
  assert.deepEqual(opened.state.areas[0].name, 'אזור 1');
  assert.equal((await call(5304, 'GET', '/api/analyses/nope')).status, 404);
  assert.equal((await call(5304, 'DELETE', '/api/analyses/abcdefghijkl')).status, 401);

  const owner = await start(5309, { TEST_SEED_ANALYSES: seed, DEV_USER_EMAIL: 'boss@example.com' });
  t.after(() => owner.kill());
  const list = (await call(5309, 'GET', '/api/analyses')).json;
  assert.equal(list.length, 1);
  assert.equal((await call(5309, 'GET', '/api/analyses/abcdefghijkl')).json.mine, true);
  assert.equal((await call(5309, 'DELETE', '/api/analyses/abcdefghijkl')).status, 200);
  assert.equal((await call(5309, 'GET', '/api/analyses/abcdefghijkl')).status, 404);
});

test('the health check (GET / with no Accept header) gets a 2xx', async (t) => {
  const s = await start(5305, {});
  t.after(() => s.kill());
  const res = await fetch('http://localhost:5305/', { redirect: 'manual', headers: { Accept: '' } });
  assert.equal(res.status, 200);
});

test('a malformed or forged identity cookie is treated as signed out', async (t) => {
  const s = await start(5306, {});
  t.after(() => s.kill());
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const forged = `${b({ alg: 'none', typ: 'JWT' })}.${b({ iss: 'https://auth.xhostd.com', aud: 'localhost', email: 'boss@example.com', exp: 9999999999 })}.`;
  for (const value of ['%E0%A4%A', forged]) {
    const res = await fetch('http://localhost:5306/api/users', { headers: { Cookie: `__Host-xhost_id=${value}` } });
    assert.equal(res.status, 401);
    const me = await (await fetch('http://localhost:5306/api/me', { headers: { Cookie: `__Host-xhost_id=${value}` } })).json();
    assert.equal(me.signed_in, false);
  }
});

test('only the email is kept about a user, and a visit writes nothing', async (t) => {
  const s = await start(5307, { DEV_USER_EMAIL: 'boss@example.com' });
  t.after(() => s.kill());
  const me = (await call(5307, 'GET', '/api/me')).json;
  assert.equal(me.name, undefined);
  const users = (await call(5307, 'GET', '/api/users')).json;
  // Only the two env admins: the visit itself left no row.
  assert.deepEqual(users.map((u) => u.email).sort(), ['boss@example.com', 'second@example.com']);
  for (const u of users) assert.deepEqual(Object.keys(u).sort(), ['added_by', 'created_at', 'email', 'env_admin', 'role']);
});

test('every answer carries the security headers', async (t) => {
  const s = await start(5308, {});
  t.after(() => s.kill());
  for (const path of ['/', '/admin']) {
    const res = await fetch(`http://localhost:5308${path}`, { redirect: 'manual' });
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
});
