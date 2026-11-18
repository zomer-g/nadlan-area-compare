// The browser's SQL to OVER goes through here. Since OVER closed its free SQL
// to anonymous callers (APPEND_SQL_REQUIRE_AUTH), a query needs a token, and a
// token cannot live in the page. This server adds it.
//
//   * OVER_SQL_TOKEN (a secret, the same value as OVER's SQL_PROXY_TOKEN) goes
//     in the Authorization header. It never reaches the browser or the log.
//   * Every visitor arrives at OVER from this server's one address, so each
//     request also carries X-Over-Client: a keyed hash of the visitor's IP.
//     OVER rate-limits and caps running queries per that id (120 a minute, 4 at
//     once), as it does per IP for direct callers. The hash key is random per
//     process, so the id is not the IP, cannot be reversed to it, and changes
//     on every restart; nothing about the visitor is stored here.
//   * OVER's answer (status, body, Retry-After) is passed back as is, so the
//     page's error handling is unchanged.

import express from 'express';
import { createHmac, randomBytes } from 'node:crypto';

const OVER = (process.env.OVER_URL || 'https://www.over.org.il').replace(/\/$/, '');
const DEALS_DATASET = 'fd06f5ae-8a4f-4120-b275-8a514ad23499';
const TOKEN = process.env.OVER_SQL_TOKEN || '';
const TIMEOUT_MS = 50000; // a little over the page's own 45 s, so the page's message wins
const MAX_SQL = 1_000_000; // a detailed drawn area is a few hundred KB of WKT

const visitorKey = randomBytes(32);
const visitorId = (ip) => createHmac('sha256', visitorKey).update(String(ip || '')).digest('base64url').slice(0, 22);

export const overSqlConfigured = Boolean(TOKEN);

export function mountOverProxy(app) {
  app.post('/api/over/sql', express.json({ limit: '2mb' }), async (req, res) => {
    const sql = req.body?.sql;
    if (typeof sql !== 'string' || !sql.trim() || sql.length > MAX_SQL) {
      return res.status(400).json({ detail: 'sql חסר או ארוך מדי' });
    }
    let upstream;
    try {
      upstream = await fetch(`${OVER}/api/append/${DEALS_DATASET}/sql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Over-Client': visitorId(req.ip),
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        },
        body: JSON.stringify({ sql }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
      return res.status(timedOut ? 504 : 502).json({
        detail: timedOut ? 'OVER לא ענה בזמן' : 'אין תקשורת בין האתר ל-OVER',
      });
    }
    const retry = upstream.headers.get('retry-after');
    if (retry) res.setHeader('Retry-After', retry);
    res.setHeader('Cache-Control', 'no-store');
    res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  });
}
