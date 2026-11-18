// /api/over/sql: the browser's SQL reaches OVER with the site's token and a
// per-visitor id, and OVER's answer comes back unchanged. A fake OVER records
// what it was sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'site-token-for-tests-' + 'z'.repeat(40);

function fakeOver(port) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, client: req.headers['x-over-client'], body: JSON.parse(body) });
      if (body.includes('busy')) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '7' });
        return res.end(JSON.stringify({ detail: 'busy' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rows: [{ n: 1 }] }));
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ srv, seen })));
}

function start(port, env) {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: '', XHOST_HTTP_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(p); });
    p.stderr.on('data', (d) => reject(new Error(String(d))));
    setTimeout(() => reject(new Error('server did not start')), 8000);
  });
}

const post = (port, body) => fetch(`http://localhost:${port}/api/over/sql`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('SQL goes to OVER with the token and a visitor id, and the answer comes back', async (t) => {
  const over = await fakeOver(5401);
  const s = await start(5402, { OVER_URL: 'http://127.0.0.1:5401', OVER_SQL_TOKEN: TOKEN });
  t.after(() => { s.kill(); over.srv.close(); });

  const ok = await post(5402, { sql: 'SELECT 1 AS n' });
  assert.equal(ok.status, 200);
  const text = await ok.text();
  assert.deepEqual(JSON.parse(text), { rows: [{ n: 1 }] });
  assert.ok(!text.includes(TOKEN));

  const sent = over.seen[0];
  assert.equal(sent.url, '/api/append/fd06f5ae-8a4f-4120-b275-8a514ad23499/sql');
  assert.equal(sent.auth, `Bearer ${TOKEN}`);
  assert.match(sent.client, /^[A-Za-z0-9_-]{22}$/); // what OVER accepts as an id
  assert.ok(!sent.client.includes('127.0.0.1'));
  assert.equal(sent.body.sql, 'SELECT 1 AS n');

  await post(5402, { sql: 'SELECT 2' });
  assert.equal(over.seen[1].client, sent.client); // the same visitor keeps one id

  const busy = await post(5402, { sql: 'SELECT busy' });
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get('retry-after'), '7');
});

test('a missing or empty query is refused here, not sent', async (t) => {
  const over = await fakeOver(5403);
  const s = await start(5404, { OVER_URL: 'http://127.0.0.1:5403', OVER_SQL_TOKEN: TOKEN });
  t.after(() => { s.kill(); over.srv.close(); });
  assert.equal((await post(5404, {})).status, 400);
  assert.equal((await post(5404, { sql: '   ' })).status, 400);
  assert.equal(over.seen.length, 0);
});

test('OVER unreachable is a 502, not a hang', async (t) => {
  const s = await start(5405, { OVER_URL: 'http://127.0.0.1:5409', OVER_SQL_TOKEN: TOKEN });
  t.after(() => s.kill());
  assert.equal((await post(5405, { sql: 'SELECT 1' })).status, 502);
});
