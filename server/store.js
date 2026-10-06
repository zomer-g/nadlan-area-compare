// Users, roles and saved analyses.
//
// What is kept about a person: only someone an admin added (or who saved an
// analysis to an account before the site was opened) has a row — their email,
// role, who set the role, and when. Nothing else; a visit writes nothing.
//
// Postgres from DATABASE_URL (xhostd injects it into every non-static channel).
// Without it — local development only — an in-memory store with the same
// interface, which forgets everything on restart.

import pg from 'pg';

// Roles an admin can set. The site is open to everyone, so the only role that
// changes anything is 'admin' (user management); 'viewer' is a plain account.
export const ROLES = ['viewer', 'admin'];

// Admins named in the environment are admins whatever the table says, and the
// UI cannot demote or remove them: there is always a way back in.
export const ENV_ADMINS = new Set(
  (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
);


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
    async deleteAnalysis(id) { await q('DELETE FROM analyses WHERE id = $1', [id]); },
  };
}

function memoryStore() {
  const users = new Map();
  const analyses = new Map();
  const now = () => new Date().toISOString();
  return {
    kind: 'memory',
    // Tests only: TEST_SEED_ANALYSES (JSON array) stands in for analyses saved
    // before the site was opened — the server no longer creates any.
    async init() {
      for (const a of JSON.parse(process.env.TEST_SEED_ANALYSES || '[]')) analyses.set(a.id, { created_at: now(), updated_at: now(), ...a });
    },
    async getUser(email) { return users.get(email) || null; },
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
    async deleteAnalysis(id) { analyses.delete(id); },
  };
}

export function createStore() {
  return process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : memoryStore();
}

// The effective role: environment admins first, then the table.
// A row left from before (pending, blocked) counts as a plain account.
export function roleOf(email, row) {
  if (ENV_ADMINS.has(email)) return 'admin';
  return row && ROLES.includes(row.role) ? row.role : null;
}
