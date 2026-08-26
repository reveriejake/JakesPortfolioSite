/* =================================================================
   Authentication: scrypt password hashing and server-side sessions.

   No dependencies beyond node:crypto. The session id is random and
   opaque, the cookie is HttpOnly, and every admin route checks the
   session against the database — so the browser holds a bearer token
   and nothing else. Losing the cookie logs you out; it grants nothing
   on its own if the row is gone.
   ================================================================= */
'use strict';

const crypto = require('crypto');
const db = require('./db');

const SESSION_COOKIE = 'jf_sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // two weeks

/* ---- passwords ------------------------------------------------ */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('hex'), key.toString('hex')].join('$');
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, keyHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch (err) {
    return false;
  }
}

/* ---- login throttling ------------------------------------------ */

// In-memory is the right scope here: one process, and a restart clearing
// the counters is not a weakness worth a table.
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

function attemptKey(req) {
  return clientIp(req);
}

function tooManyAttempts(req) {
  const rec = attempts.get(attemptKey(req));
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(attemptKey(req));
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(req) {
  const key = attemptKey(req);
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

function clearFailures(req) {
  attempts.delete(attemptKey(req));
}

/* ---- cookies --------------------------------------------------- */

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function secureCookies() {
  // Behind nginx the app itself speaks http; trust proxy makes req.secure
  // reflect X-Forwarded-Proto, but the flag is also forced in production.
  return process.env.NODE_ENV === 'production' || process.env.FORCE_SECURE_COOKIE === '1';
}

function setSessionCookie(res, sid) {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(sid)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (secureCookies()) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(res) {
  const bits = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secureCookies()) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

/* ---- session lifecycle ----------------------------------------- */

function startSession(res, user, userAgent) {
  const sid = crypto.randomBytes(32).toString('base64url');
  db.createSession(sid, user.id, SESSION_TTL_MS, userAgent);
  db.touchLogin(user.id);
  setSessionCookie(res, sid);
  return sid;
}

function endSession(req, res) {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (sid) db.deleteSession(sid);
  clearSessionCookie(res);
}

/**
 * Attaches req.user when the request carries a live session. Never rejects —
 * routes decide what to do with an anonymous request, because the admin
 * routes and the API want different failure modes.
 */
function attachUser(req, res, next) {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  req.user = null;
  req.sessionId = null;
  if (sid) {
    const session = db.findSession(sid);
    if (session) {
      const user = db.findUserById(session.user_id);
      if (user) {
        req.user = user;
        req.sessionId = sid;
      }
    }
  }
  next();
}

/** For JSON APIs: an honest 401. */
function requireApiAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

/**
 * For admin pages and their assets: a 404, not a 401. An anonymous visitor
 * gets the same response they would for any path that doesn't exist, so the
 * console isn't advertised to anyone who hasn't signed in.
 */
function requireAdminPage(req, res, next) {
  if (!req.user) return next('router');
  next();
}

/* ---- misc ------------------------------------------------------ */

function clientIp(req) {
  // app.set('trust proxy') makes req.ip honour X-Forwarded-For from nginx.
  return req.ip || req.connection?.remoteAddress || '0.0.0.0';
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  tooManyAttempts,
  recordFailure,
  clearFailures,
  parseCookies,
  startSession,
  endSession,
  attachUser,
  requireApiAuth,
  requireAdminPage,
  clientIp
};
