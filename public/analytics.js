/* =================================================================
   First-party analytics — no third-party scripts, no cookies, and
   nothing stored on the visitor's device.

   Events are POSTed to this site's own /api/events, which records
   them server-side. Visitors are counted by a hash the server derives
   from IP + user agent + a salt that rotates daily, so there is no id
   to persist here and nothing to ask consent for.

   Honours Do Not Track.
   ================================================================= */
(function (global) {
  'use strict';

  var ENDPOINT = '/api/events';
  var FLUSH_MS = 1500;   // batch window, so a burst of clicks is one request
  var MAX_BATCH = 20;

  function dnt() {
    var v = global.navigator.doNotTrack || global.doNotTrack || global.navigator.msDoNotTrack;
    return v === '1' || v === 'yes';
  }

  var enabled = !dnt();

  // Session id lives in sessionStorage only — it dies with the tab and never
  // identifies anyone; it exists so the server can group one visit's events.
  function sessionId() {
    try {
      var id = sessionStorage.getItem('jf.sid');
      if (!id) {
        id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
        sessionStorage.setItem('jf.sid', id);
      }
      return id;
    } catch (e) {
      return null; // private mode — the server still counts the pageview
    }
  }

  function device() {
    var w = global.innerWidth || 1024;
    if (w < 700) return 'mobile';
    if (w < 1100) return 'tablet';
    return 'desktop';
  }

  function referrer() {
    var r = document.referrer || '';
    if (!r) return 'direct';
    try {
      var h = new URL(r).hostname.replace(/^www\./, '');
      return h === location.hostname.replace(/^www\./, '') ? 'internal' : h;
    } catch (e) {
      return 'unknown';
    }
  }

  /* ---- batching -------------------------------------------------- */

  var queue = [];
  var timer = null;

  function post(batch, useBeacon) {
    var body = JSON.stringify({ events: batch });
    try {
      if (useBeacon && global.navigator.sendBeacon) {
        global.navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
        credentials: 'same-origin'
      }).catch(function () { /* analytics must never surface an error */ });
    } catch (e) { /* ditto */ }
  }

  function flush(useBeacon) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return;
    var batch = queue.splice(0, MAX_BATCH);
    post(batch, useBeacon);
  }

  function track(type, label, extra) {
    if (!enabled) return;
    var evt = {
      t: Date.now(),
      type: type,
      label: label || '',
      path: location.pathname + location.hash,
      ref: referrer(),
      dev: device(),
      sid: sessionId()
    };
    if (extra) Object.keys(extra).forEach(function (k) { evt[k] = extra[k]; });

    queue.push(evt);
    if (queue.length >= MAX_BATCH) return flush(false);
    if (!timer) timer = setTimeout(function () { flush(false); }, FLUSH_MS);
  }

  /* ---- auto-instrumentation --------------------------------------- */

  function autoTrack() {
    if (!enabled) return;

    track('pageview');

    // Time on page, recorded once when the tab goes away.
    var start = Date.now();
    var sent = false;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'hidden') return;
      if (!sent) {
        sent = true;
        track('session_end', '', { sec: Math.round((Date.now() - start) / 1000) });
      }
      flush(true); // the tab may not come back — send with a beacon
    });
    global.addEventListener('pagehide', function () { flush(true); });

    // Which sections actually get read, rather than merely loaded.
    if (global.IntersectionObserver) {
      var seen = {};
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          var id = e.target.id;
          if (e.isIntersecting && e.intersectionRatio >= 0.4 && !seen[id]) {
            seen[id] = true;
            track('section_view', id);
          }
        });
      }, { threshold: [0.4] });
      document.querySelectorAll('section[id]').forEach(function (s) { io.observe(s); });
    }

    // Clicks: résumé download, outbound links, project CTAs.
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      var href = a.getAttribute('href') || '';

      if (/\.pdf($|\?)/i.test(href)) { track('resume_download', href); return; }
      if (href.charAt(0) === '#' || href.indexOf('mailto:') === 0) {
        track(href.charAt(0) === '#' ? 'anchor_click' : 'email_click', href);
        return;
      }

      var project = a.closest('.project');
      if (project) {
        var name = project.querySelector('.project-name');
        track('project_click', name ? name.textContent.trim() : href);
        return;
      }

      if (/^https?:/i.test(href)) {
        var host = '';
        try { host = new URL(href).hostname.replace(/^www\./, ''); } catch (err) { host = href; }
        if (host !== location.hostname.replace(/^www\./, '')) track('outbound_click', host);
      }
    }, true);

    // Video facade plays (script.js swaps the button for an iframe on click).
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.lite-yt');
      if (!btn) return;
      var project = btn.closest('.project');
      var name = project && project.querySelector('.project-name');
      track('video_play', name ? name.textContent.trim() : (btn.dataset.ytTitle || 'video'));
    }, true);
  }

  global.JFAnalytics = { enabled: enabled, track: track, flush: flush };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoTrack);
  } else {
    autoTrack();
  }
})(window);
