// Users, roles and saved analyses.
//
// What is kept about a person: their email, role, who set the role, and when
// the row was created. Nothing else — no name, no activity log, no last visit.
//
// Postgres from DATABASE_URL (xhostd injects it into every non-static channel).
// Without it — local development only — an in-memory store with the same
// interface, which forgets everything on restart.

import pg from 'pg';
import { randomBytes } from 'node:crypto';

// Roles an admin can set. 'blocked' keeps a signed-in user out even when
// sign-up is open (removing them would not: they would sign up again).
export const ROLES = ['viewer', 'admin', 'blocked'];

// OPEN_SIGNUP=true: anyone who signs in with SSO becomes a viewer on the spot,
// with no admin approval. Off (the default), they wait as 'pending'.
export const OPEN_SIGNUP = /^(1|true|yes)$/i.test(process.env.OPEN_SIGNUP || '');

// Admins named in the environment are admins whatever the table says, and the
// UI cannot demote or remove them: there is always a way back in.
export const ENV_ADMINS = new Set(
  (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
);

const newId = () => randomBytes(9).toString('base64url'); // 12 chars, unguessable

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  email       text PRIMARY KEY,
  role        text NOT NULL,
  added_by    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS analyses (
  id          text PRIMARY KEY,
  owner       text NOT NULL,
  title       text NOT NULL,
  state       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analyses_owner ON analyses (owner, updated_at DESC);
-- The original role check did not know 'blocked'; replace it (idempotent).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('pending', 'viewer', 'admin', 'blocked'));
`;

function pgStore(url) {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const q = (sql, args) => pool.query(sql, args).then((r) => r.rows);
  return {
    kind: 'postgres',
    async init() { await pool.query(SCHEMA); },
    async getUser(email) { return (await q('SELECT * FROM users WHERE email = $1', [email]))[0] || null; },
    async addPending(email) {
      // A first visit by someone without access leaves a 'pending' row, so the
      // admin sees who asked instead of being told by mail. Written once.
      await q(`INSERT INTO users (email, role) VALUES ($1, 'pending') ON CONFLICT (email) DO NOTHING`, [email]);
    },
    listUsers() { return q('SELECT email, role, added_by, created_at FROM users ORDER BY role, email'); },
    async setUser(email, role, by) {
      await q(`INSERT INTO users (email, role, added_by) VALUES ($1, $2, $3)
               ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, added_by = EXCLUDED.added_by`, [email, role, by]);
    },
    async deleteUser(email) { await q('DELETE FROM users WHERE email = $1', [email]); },
    listAnalyses(owner) {
      return q(`SELECT id, title, created_at, updated_at, state->'summary' AS summary FROM analyses
                WHERE owner = $1 ORDER BY updated_at DESC`, [owner]);
    },
    async getAnalysis(id) { return (await q('SELECT * FROM analyses WHERE id = $1', [id]))[0] || null; },
    async createAnalysis(owner, title, state) {
      const id = newId();
      await q('INSERT INTO analyses (id, owner, title, state) VALUES ($1, $2, $3, $4)', [id, owner, title, state]);
      return id;
    },
    async updateAnalysis(id, title, state) {
      await q('UPDATE analyses SET title = $2, state = $3, updated_at = now() WHERE id = $1', [id, title, state]);
    },
    async deleteAnalysis(id) { await q('DELETE FROM analyses WHERE id = $1', [id]); },
  };
}

function memoryStore() {
  const users = new Map();
  const analyses = new Map();
  const now = () => new Date().toISOString();
  return {
    kind: 'memory',
    async init() {},
    async getUser(email) { return users.get(email) || null; },
    async addPending(email) {
      if (!users.has(email)) users.set(email, { email, role: 'pending', added_by: null, created_at: now() });
    },
    async listUsers() { return [...users.values()]; },
    async setUser(email, role, by) {
      const u = users.get(email) || { email, created_at: now() };
      users.set(email, { ...u, role, added_by: by });
    },
    async deleteUser(email) { users.delete(email); },
    async listAnalyses(owner) {
      return [...analyses.values()].filter((a) => a.owner === owner)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map(({ id, title, created_at, updated_at, state }) => ({ id, title, created_at, updated_at, summary: state.summary }));
    },
    async getAnalysis(id) { return analyses.get(id) || null; },
    async createAnalysis(owner, title, state) {
      const id = newId();
      analyses.set(id, { id, owner, title, state, created_at: now(), updated_at: now() });
      return id;
    },
    async updateAnalysis(id, title, state) { Object.assign(analyses.get(id), { title, state, updated_at: now() }); },
    async deleteAnalysis(id) { analyses.delete(id); },
  };
}

export function createStore() {
  return process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : memoryStore();
}

// The effective role: environment admins first, then the table.
// 'blocked' and null both mean no access; the gate tells them apart.
export function roleOf(email, row) {
  if (ENV_ADMINS.has(email)) return 'admin';
  return row && ROLES.includes(row.role) ? row.role : null;
}
