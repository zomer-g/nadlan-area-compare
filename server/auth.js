// Sign-in through xhostd's identity gateway (Google SSO).
//
// xhostd runs the Google sign-in and sets the __Host-xhost_id cookie: an
// RS256 JWT signed by https://auth.xhostd.com, audience = the exact channel
// hostname. Nothing is blocked at the platform edge — this module is the only
// thing between an anonymous request and the app, so every route goes through
// it (see server.js).

import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = 'https://auth.xhostd.com';
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/xhost-auth/jwks`));
const COOKIE = '__Host-xhost_id';

// The hostnames this app answers on. The audience must match one of them; the
// Host header alone is not trusted to say which.
const HOSTS = (process.env.APP_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);

function cookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; } // malformed: as if absent
    }
  }
  return null;
}

export async function identity(req) {
  // Local development only: no xhostd gateway on localhost. Never with a real
  // database (every deployed channel has DATABASE_URL), and never for a request
  // that did not come from this machine — the Host header is the client's to set.
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  if (process.env.DEV_USER_EMAIL && !process.env.DATABASE_URL && loopback) {
    return { email: process.env.DEV_USER_EMAIL.toLowerCase(), name: 'dev', sub: 'dev' };
  }
  const token = cookie(req, COOKIE);
  if (!token) return null;
  const audience = HOSTS.length ? HOSTS : [req.hostname];
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER, audience, algorithms: ['RS256'] });
    if (!payload.email) return null;
    return { email: String(payload.email).toLowerCase(), name: payload.name || '', sub: payload.sub };
  } catch {
    return null; // expired, forged, or for another host
  }
}

export const loginUrl = (returnTo) => `/xhost-auth/login?return_to=${encodeURIComponent(returnTo || '/')}`;
export const LOGOUT_URL = '/xhost-auth/logout?return_to=/';
