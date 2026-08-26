/* =================================================================
   SQLite storage. One file on disk, no external database to run.

   Three concerns live here:
     content_versions  every save, so a bad edit is one click from undone
     events            the analytics log, one row per recorded action
     users / sessions  who may reach the admin
   ================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'site.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// WAL lets the analytics writes and the admin reads stop blocking each other.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS content_versions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    data       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    author     TEXT,
    note       TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    type     TEXT    NOT NULL,
    label    TEXT,
    path     TEXT,
    referrer TEXT,
    device   TEXT,
    visitor  TEXT,
    session  TEXT,
    seconds  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts      ON events (ts);
  CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events (type, ts);
  CREATE INDEX IF NOT EXISTS idx_events_visitor ON events (visitor, ts);

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL UNIQUE,
    pass_hash  TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    last_login INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

/* ---- settings ------------------------------------------------- */

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

function getSetting(key) {
  const row = getSettingStmt.get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  setSettingStmt.run(key, String(value));
}

/**
 * The salt used to derive visitor hashes, rotated every UTC day. Rotating it
 * means yesterday's hashes can't be matched against today's, so the log can't
 * be walked back into a per-person history — the visitor id is only stable for
 * as long as it takes to count a day's uniques.
 */
function dailySalt() {
  const day = new Date().toISOString().slice(0, 10);
  const key = 'salt:' + day;
  let salt = getSetting(key);
  if (!salt) {
    salt = crypto.randomBytes(32).toString('hex');
    setSetting(key, salt);
    // Keep a couple of days for late-arriving beacons, drop the rest.
    db.prepare("DELETE FROM settings WHERE key LIKE 'salt:%' AND key < ?").run('salt:' + shiftDay(day, -2));
  }
  return salt;
}

function shiftDay(isoDay, days) {
  const d = new Date(isoDay + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ---- content -------------------------------------------------- */

const latestContentStmt = db.prepare(
  'SELECT id, data, created_at, author, note FROM content_versions ORDER BY id DESC LIMIT 1'
);
const insertContentStmt = db.prepare(
  'INSERT INTO content_versions (data, created_at, author, note) VALUES (?, ?, ?, ?)'
);
const listVersionsStmt = db.prepare(
  'SELECT id, created_at, author, note, length(data) AS size FROM content_versions ORDER BY id DESC LIMIT ?'
);
const getVersionStmt = db.prepare('SELECT id, data, created_at, author, note FROM content_versions WHERE id = ?');

function getLatestContent() {
  const row = latestContentStmt.get();
  if (!row) return null;
  return { id: row.id, createdAt: row.created_at, author: row.author, note: row.note, data: JSON.parse(row.data) };
}

function saveContent(data, author, note) {
  const json = JSON.stringify(data);
  const info = insertContentStmt.run(json, Date.now(), author || null, note || null);
  pruneVersions();
  return info.lastInsertRowid;
}

function listVersions(limit) {
  return listVersionsStmt.all(limit || 50);
}

function getVersion(id) {
  const row = getVersionStmt.get(id);
  if (!row) return null;
  return { id: row.id, createdAt: row.created_at, author: row.author, note: row.note, data: JSON.parse(row.data) };
}

// Keep history useful without letting it grow forever.
const MAX_VERSIONS = 200;
function pruneVersions() {
  db.prepare(
    'DELETE FROM content_versions WHERE id NOT IN (SELECT id FROM content_versions ORDER BY id DESC LIMIT ?)'
  ).run(MAX_VERSIONS);
}

/* ---- events --------------------------------------------------- */

const insertEventStmt = db.prepare(`
  INSERT INTO events (ts, type, label, path, referrer, device, visitor, session, seconds)
  VALUES (@ts, @type, @label, @path, @referrer, @device, @visitor, @session, @seconds)
`);

function insertEvent(evt) {
  insertEventStmt.run({
    ts: evt.ts,
    type: evt.type,
    label: evt.label || null,
    path: evt.path || null,
    referrer: evt.referrer || null,
    device: evt.device || null,
    visitor: evt.visitor || null,
    session: evt.session || null,
    seconds: Number.isFinite(evt.seconds) ? evt.seconds : null
  });
}

/** Drop events older than the retention window (default 400 days). */
function pruneEvents(days) {
  const cutoff = Date.now() - (days || 400) * 86400000;
  return db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff).changes;
}

/* ---- users & sessions ----------------------------------------- */

const findUserByEmailStmt = db.prepare('SELECT * FROM users WHERE email = ?');
const findUserByIdStmt = db.prepare('SELECT id, email, created_at, last_login FROM users WHERE id = ?');
const insertUserStmt = db.prepare(
  'INSERT INTO users (email, pass_hash, created_at) VALUES (?, ?, ?)'
);
const updatePassStmt = db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?');
const touchLoginStmt = db.prepare('UPDATE users SET last_login = ? WHERE id = ?');
const countUsersStmt = db.prepare('SELECT COUNT(*) AS n FROM users');

const insertSessionStmt = db.prepare(
  'INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)'
);
const findSessionStmt = db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?');
const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE id = ?');
const deleteUserSessionsStmt = db.prepare('DELETE FROM sessions WHERE user_id = ?');

function countUsers() { return countUsersStmt.get().n; }
function findUserByEmail(email) { return findUserByEmailStmt.get(String(email).toLowerCase().trim()); }
function findUserById(id) { return findUserByIdStmt.get(id); }
function createUser(email, passHash) {
  return insertUserStmt.run(String(email).toLowerCase().trim(), passHash, Date.now()).lastInsertRowid;
}
function setPassword(userId, passHash) {
  updatePassStmt.run(passHash, userId);
  // Changing the password logs every other device out.
  deleteUserSessionsStmt.run(userId);
}
function touchLogin(userId) { touchLoginStmt.run(Date.now(), userId); }

function createSession(id, userId, ttlMs, userAgent) {
  const now = Date.now();
  insertSessionStmt.run(id, userId, now, now + ttlMs, userAgent || null);
}
function findSession(id) { return findSessionStmt.get(id, Date.now()); }
function deleteSession(id) { deleteSessionStmt.run(id); }
function pruneSessions() {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()).changes;
}

module.exports = {
  db,
  DB_PATH,
  getSetting, setSetting, dailySalt,
  getLatestContent, saveContent, listVersions, getVersion,
  insertEvent, pruneEvents,
  countUsers, findUserByEmail, findUserById, createUser, setPassword, touchLogin,
  createSession, findSession, deleteSession, pruneSessions
};
