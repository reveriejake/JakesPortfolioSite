/* =================================================================
   Portfolio site server: static site + content API + analytics.

   Layout note — the admin console lives in server/private/, which is
   NOT under the static root. Express can't serve it by accident; the
   only way to it is through routes that check a session first, and an
   anonymous request gets a 404 rather than a 401 so the console isn't
   advertised.
   ================================================================= */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const db = require('./lib/db');
const auth = require('./lib/auth');
const stats = require('./lib/stats');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
// The static root is a directory that contains ONLY publishable files.
// It deliberately does not contain server/, data/, deploy/, or Reference/ —
// a static root that sits above your source and your database will serve
// both the moment someone guesses a path.
const SITE_ROOT = process.env.SITE_ROOT || path.join(__dirname, '..', 'public');
const PRIVATE_DIR = path.join(__dirname, 'private');
const SEED_FILE = process.env.SEED_FILE || path.join(__dirname, '..', 'content.json');

const app = express();

// nginx sits in front, so honour X-Forwarded-* for req.ip and req.secure.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' }));
app.use(auth.attachUser);

/* =============================================================
   Security headers
   ============================================================= */

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});

/* =============================================================
   Content
   ============================================================= */

function currentContent() {
  const row = db.getLatestContent();
  if (row) return row;
  // First boot: fall back to the file in the repo so the site is never blank.
  try {
    return { id: 0, createdAt: null, author: null, note: 'seed', data: JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) };
  } catch (err) {
    return null;
  }
}

function sendContent(req, res) {
  const current = currentContent();
  if (!current) return res.status(503).json({ error: 'No content available' });
  res.set('Cache-Control', 'no-cache');
  res.set('ETag', 'W/"content-' + current.id + '"');
  res.json(current.data);
}

// The public site fetches content.json; serving it from the database means
// the file on disk stays the seed and the two can never silently diverge.
app.get('/content.json', sendContent);
app.get('/api/content', sendContent);

app.put('/api/content', auth.requireApiAuth, (req, res) => {
  const data = req.body && req.body.content;
  if (!data || typeof data !== 'object' || !data.projects || !data.reel) {
    return res.status(400).json({ error: 'Body must be {content: {...}} with at least reel and projects' });
  }
  const id = db.saveContent(data, req.user.email, (req.body.note || '').slice(0, 200));
  res.json({ ok: true, version: id });
});

app.get('/api/content/versions', auth.requireApiAuth, (req, res) => {
  res.json({ versions: db.listVersions(Number(req.query.limit) || 50) });
});

app.get('/api/content/versions/:id', auth.requireApiAuth, (req, res) => {
  const version = db.getVersion(Number(req.params.id));
  if (!version) return res.status(404).json({ error: 'No such version' });
  res.json(version);
});

app.post('/api/content/rollback', auth.requireApiAuth, (req, res) => {
  const version = db.getVersion(Number(req.body && req.body.version));
  if (!version) return res.status(404).json({ error: 'No such version' });
  // Rolling back writes a new version rather than deleting history, so the
  // rollback itself is undoable too.
  const id = db.saveContent(version.data, req.user.email, 'rollback to #' + version.id);
  res.json({ ok: true, version: id });
});

/* =============================================================
   Analytics ingest
   ============================================================= */

const EVENT_TYPES = new Set([
  'pageview', 'session_end', 'section_view', 'project_click',
  'video_play', 'resume_download', 'outbound_click', 'anchor_click', 'email_click'
]);

const BOT_RE = /bot|crawl|spider|slurp|bingpreview|headless|lighthouse|pingdom|uptime|curl|wget|python-requests|axios|monitor/i;

function str(value, max) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, max || 200);
}

/**
 * Visitor identity is derived, never stored on the device: a hash of
 * IP + user agent + a salt that rotates daily. No cookie, no localStorage
 * id, nothing to consent to — and because the salt rotates, the hashes
 * can't be chained across days into a profile.
 */
function visitorHash(req) {
  const salt = db.dailySalt();
  const ua = req.get('user-agent') || '';
  return crypto.createHash('sha256').update(salt + '|' + auth.clientIp(req) + '|' + ua)
    .digest('hex').slice(0, 16);
}

// A cheap ceiling on how much one address can write, so the table can't be
// flooded by anyone who found the endpoint.
const ingestCounts = new Map();
const INGEST_LIMIT = 240;          // events per window
const INGEST_WINDOW = 60 * 1000;

function ingestAllowed(req) {
  const key = auth.clientIp(req);
  const now = Date.now();
  const rec = ingestCounts.get(key);
  if (!rec || now - rec.start > INGEST_WINDOW) {
    ingestCounts.set(key, { start: now, count: 1 });
    return true;
  }
  rec.count += 1;
  return rec.count <= INGEST_LIMIT;
}

app.post('/api/events', (req, res) => {
  // Always 204: the beacon is fire-and-forget, and telling a caller why it
  // was dropped only helps someone probing the endpoint.
  res.status(204);

  try {
    const ua = req.get('user-agent') || '';
    if (BOT_RE.test(ua)) return res.end();
    if (!ingestAllowed(req)) return res.end();
    if (req.user) return res.end();  // don't count your own admin browsing

    const body = req.body || {};
    const batch = Array.isArray(body.events) ? body.events : [body];
    const visitor = visitorHash(req);
    const now = Date.now();

    for (const raw of batch.slice(0, 25)) {
      const type = str(raw.type, 40);
      if (!type || !EVENT_TYPES.has(type)) continue;

      // Trust the client for what happened, never for when — a supplied
      // timestamp is only honoured if it's recent and not in the future.
      let ts = Number(raw.t);
      if (!Number.isFinite(ts) || ts > now + 60000 || ts < now - 6 * 3600 * 1000) ts = now;

      let seconds = Number(raw.sec);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) seconds = null;

      db.insertEvent({
        ts,
        type,
        label: str(raw.label, 200),
        path: str(raw.path, 300),
        referrer: str(raw.ref, 200),
        device: str(raw.dev, 20),
        visitor,
        session: str(raw.sid, 40),
        seconds
      });
    }
  } catch (err) {
    // Analytics must never take the site down.
    console.error('[events] ingest failed:', err.message);
  }
  res.end();
});

/* =============================================================
   Analytics read
   ============================================================= */

app.get('/api/stats', auth.requireApiAuth, (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 730);
  const tz = Number(req.query.tz) || 0;
  res.json(stats.summary(days === 0 ? 0 : days, tz));
});

app.get('/api/stats/export.csv', auth.requireApiAuth, (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 730);
  const rows = stats.exportRows(days);
  const cols = ['ts', 'iso', 'type', 'label', 'path', 'referrer', 'device', 'visitor', 'session', 'seconds'];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  for (const row of rows) {
    lines.push(cols.map((c) => esc(c === 'iso' ? new Date(row.ts).toISOString() : row[c])).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="analytics-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
});

/* =============================================================
   Auth
   ============================================================= */

app.post('/api/auth/login', (req, res) => {
  const email = String((req.body && req.body.email) || '').toLowerCase().trim();
  const password = String((req.body && req.body.password) || '');

  if (auth.tooManyAttempts(req)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }

  const user = email ? db.findUserByEmail(email) : null;
  // Hash even when the user is unknown, so a missing account and a wrong
  // password take the same time to answer.
  const ok = user
    ? auth.verifyPassword(password, user.pass_hash)
    : auth.verifyPassword(password, auth.hashPassword('decoy'));

  if (!user || !ok) {
    auth.recordFailure(req);
    return res.status(401).json({ error: 'Wrong email or password.' });
  }

  auth.clearFailures(req);
  auth.startSession(res, user, req.get('user-agent'));
  res.json({ ok: true, email: user.email });
});

app.post('/api/auth/logout', (req, res) => {
  auth.endSession(req, res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ email: req.user.email, lastLogin: req.user.last_login });
});

app.post('/api/auth/password', auth.requireApiAuth, (req, res) => {
  const current = String((req.body && req.body.current) || '');
  const next = String((req.body && req.body.next) || '');
  if (next.length < 10) return res.status(400).json({ error: 'Use at least 10 characters.' });

  const full = db.findUserByEmail(req.user.email);
  if (!auth.verifyPassword(current, full.pass_hash)) {
    return res.status(401).json({ error: 'Current password is wrong.' });
  }
  db.setPassword(req.user.id, auth.hashPassword(next));
  auth.endSession(req, res);
  res.json({ ok: true, note: 'Password changed. Every device has been signed out.' });
});

/* =============================================================
   Admin console — private assets, session required
   ============================================================= */

function sendPrivate(res, file, type) {
  res.set('Cache-Control', 'no-store');
  res.type(type);
  res.send(fs.readFileSync(path.join(PRIVATE_DIR, file), 'utf8'));
}

app.get('/admin', (req, res) => {
  if (!req.user) return sendPrivate(res, 'login.html', 'html');
  sendPrivate(res, 'admin.html', 'html');
});

// The console's own JS and CSS are only reachable with a session; without
// one these fall through to the 404 handler like any unknown path.
app.get('/admin/app.js', auth.requireAdminPage, (req, res) => sendPrivate(res, 'admin.js', 'js'));
app.get('/admin/app.css', auth.requireAdminPage, (req, res) => sendPrivate(res, 'admin.css', 'css'));

// The old client-gated console is gone; anyone with it bookmarked lands here.
app.get(['/admin.html', '/admin.js', '/admin.css'], (req, res) => res.redirect(302, '/admin'));

/* =============================================================
   Static site
   ============================================================= */

app.use(express.static(SITE_ROOT, {
  index: 'index.html',
  extensions: ['html'],
  dotfiles: 'deny',
  redirect: false,
  setHeaders(res, filePath) {
    if (/\.(png|jpe?g|webp|gif|svg|pdf|woff2?)$/i.test(filePath)) {
      res.set('Cache-Control', 'public, max-age=604800');
    } else {
      res.set('Cache-Control', 'no-cache');
    }
  }
}));

/* =============================================================
   Fallbacks
   ============================================================= */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).type('html').send(
    '<!doctype html><meta charset="utf-8"><title>Not found</title>' +
    '<body style="background:#08061a;color:#eee9ff;font:16px/1.6 system-ui;display:grid;place-items:center;height:100vh;margin:0">' +
    '<div style="text-align:center"><h1 style="font-size:3rem;margin:0">404</h1>' +
    '<p><a href="/" style="color:#e34ff0">Back to the site</a></p></div>'
  );
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'That content is too large.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON.' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong' });
});

/* =============================================================
   Housekeeping + boot
   ============================================================= */

function housekeeping() {
  try {
    const sessions = db.pruneSessions();
    const events = db.pruneEvents(Number(process.env.EVENT_RETENTION_DAYS || 400));
    if (sessions || events) {
      console.log(`[housekeeping] pruned ${sessions} sessions, ${events} events`);
    }
  } catch (err) {
    console.error('[housekeeping]', err.message);
  }
}

setInterval(housekeeping, 6 * 60 * 60 * 1000).unref();
housekeeping();

const server = app.listen(PORT, HOST, () => {
  console.log(`Portfolio server on http://${HOST}:${PORT}`);
  console.log(`  site root : ${SITE_ROOT}`);
  console.log(`  database  : ${db.DB_PATH}`);
  if (db.countUsers() === 0) {
    console.warn('  ⚠ no admin users yet — run: npm run create-user -- you@example.com');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

module.exports = app;
