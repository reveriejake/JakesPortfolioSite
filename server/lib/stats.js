/* =================================================================
   Analytics aggregation. Everything is a SQL query against events —
   the admin receives finished numbers, never the raw log, so a busy
   month doesn't turn into a multi-megabyte response.
   ================================================================= */
'use strict';

const { db } = require('./db');

/**
 * Days are bucketed in the viewer's timezone, not UTC, so "yesterday" in the
 * dashboard means the same thing it means to the person reading it.
 * tzOffsetMinutes is what JS getTimezoneOffset() reports (minutes behind UTC).
 */
function dayExpr(tzOffsetMinutes) {
  const shiftMs = -Number(tzOffsetMinutes || 0) * 60000;
  return `date((ts + ${shiftMs}) / 1000, 'unixepoch')`;
}

function range(days) {
  const from = days ? Date.now() - days * 86400000 : 0;
  return { from, to: Date.now() };
}

function countOf(type, from) {
  return db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ? AND ts >= ?').get(type, from).n;
}

function totals(from) {
  const uniques = db
    .prepare('SELECT COUNT(DISTINCT visitor) AS v, COUNT(DISTINCT session) AS s FROM events WHERE ts >= ?')
    .get(from);

  const dwell = db
    .prepare("SELECT AVG(seconds) AS avg, COUNT(*) AS n FROM events WHERE type = 'session_end' AND seconds > 0 AND ts >= ?")
    .get(from);

  const bounced = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT session FROM events
      WHERE ts >= ? AND session IS NOT NULL
      GROUP BY session
      HAVING SUM(CASE WHEN type IN ('section_view','project_click','video_play','resume_download','outbound_click') THEN 1 ELSE 0 END) = 0
    )
  `).get(from).n;

  return {
    pageviews: countOf('pageview', from),
    visitors: uniques.v,
    sessions: uniques.s,
    avgSeconds: dwell.avg ? Math.round(dwell.avg) : 0,
    dwellSamples: dwell.n,
    bounceRate: uniques.s ? Math.round((bounced / uniques.s) * 100) : 0,
    resumeDownloads: countOf('resume_download', from),
    videoPlays: countOf('video_play', from),
    projectClicks: countOf('project_click', from),
    outboundClicks: countOf('outbound_click', from),
    emailClicks: countOf('email_click', from)
  };
}

/** Views and unique visitors per day, gap-filled so the chart has no holes. */
function series(from, days, tzOffsetMinutes) {
  const expr = dayExpr(tzOffsetMinutes);
  const rows = db.prepare(`
    SELECT ${expr} AS day,
           SUM(CASE WHEN type = 'pageview' THEN 1 ELSE 0 END) AS views,
           COUNT(DISTINCT visitor) AS visitors
    FROM events
    WHERE ts >= ?
    GROUP BY day
    ORDER BY day
  `).all(from);

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const span = days || (rows.length ? daysBetween(rows[0].day) + 1 : 1);
  const out = [];
  const shiftMs = -Number(tzOffsetMinutes || 0) * 60000;

  for (let i = span - 1; i >= 0; i--) {
    const stamp = new Date(Date.now() + shiftMs - i * 86400000);
    const key = stamp.toISOString().slice(0, 10);
    const hit = byDay.get(key);
    out.push({ day: key, views: hit ? hit.views : 0, visitors: hit ? hit.visitors : 0 });
  }
  return out;
}

function daysBetween(isoDay) {
  const then = new Date(isoDay + 'T00:00:00Z').getTime();
  return Math.max(0, Math.floor((Date.now() - then) / 86400000));
}

function breakdown(type, from, limit) {
  return db.prepare(`
    SELECT label AS bucket, COUNT(*) AS total
    FROM events
    WHERE type = ? AND ts >= ? AND label IS NOT NULL AND label <> ''
    GROUP BY label
    ORDER BY total DESC
    LIMIT ?
  `).all(type, from, limit || 12).map((r) => ({ label: r.bucket, value: r.total }));
}

function columnBreakdown(column, from, limit) {
  // Column name is never user input — callers pass a literal.
  //
  // Group by the real column, not by the `label` alias: `label` is also a
  // column on this table, and SQLite resolves the GROUP BY to the column,
  // which silently folds every row into one bucket.
  return db.prepare(`
    SELECT ${column} AS bucket, COUNT(*) AS total
    FROM events
    WHERE type = 'pageview' AND ts >= ? AND ${column} IS NOT NULL AND ${column} <> ''
    GROUP BY ${column}
    ORDER BY total DESC
    LIMIT ?
  `).all(from, limit || 12).map((r) => ({ label: r.bucket, value: r.total }));
}

function recent(from, limit) {
  return db.prepare(`
    SELECT ts, type, label, device, referrer, seconds
    FROM events
    WHERE ts >= ?
    ORDER BY ts DESC
    LIMIT ?
  `).all(from, limit || 40);
}

function summary(days, tzOffsetMinutes) {
  const { from } = range(days);
  return {
    range: { days: days || 0, from },
    totals: totals(from),
    series: series(from, days, tzOffsetMinutes),
    projects: breakdown('project_click', from),
    sections: breakdown('section_view', from),
    videos: breakdown('video_play', from),
    outbound: breakdown('outbound_click', from),
    referrers: columnBreakdown('referrer', from),
    devices: columnBreakdown('device', from),
    recent: recent(from, 40)
  };
}

/** Full event rows for CSV export. Capped so a huge range can't exhaust memory. */
function exportRows(days, limit) {
  const { from } = range(days);
  return db.prepare(`
    SELECT ts, type, label, path, referrer, device, visitor, session, seconds
    FROM events
    WHERE ts >= ?
    ORDER BY ts DESC
    LIMIT ?
  `).all(from, limit || 50000);
}

module.exports = { summary, exportRows, range };
