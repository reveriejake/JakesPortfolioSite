/* =================================================================
   First-party analytics — no third-party scripts, no cookies.

   Events are written to localStorage on the visitor's own device and
   read back by the Analytics tab in admin.html. That means the numbers
   you see in the admin are the numbers for THE BROWSER YOU OPEN IT IN.
   To collect across visitors, set an endpoint in the admin's Settings
   tab; every event is then also POSTed there via sendBeacon, and the
   admin will read its totals from that endpoint instead.

   Honours Do Not Track and a per-device opt-out flag.
   ================================================================= */
(function (global) {
  'use strict';

  var STORE_KEY    = 'jf.analytics.v1';   // the event log
  var VISITOR_KEY  = 'jf.analytics.vid';  // stable per-browser id
  var ENDPOINT_KEY = 'jf.analytics.endpoint';
  var OPTOUT_KEY   = 'jf.analytics.optout';
  var MAX_EVENTS   = 4000;                // ring buffer; ~1MB worst case

  function ls(fn, fallback) {
    // Private mode / disabled storage throws on access, not just on write.
    try { return fn(); } catch (e) { return fallback; }
  }

  function dnt() {
    var v = global.navigator.doNotTrack || global.doNotTrack || global.navigator.msDoNotTrack;
    return v === '1' || v === 'yes';
  }

  function optedOut() {
    return ls(function () { return localStorage.getItem(OPTOUT_KEY) === '1'; }, false);
  }

  var enabled = !dnt() && !optedOut();

  function uid() {
    // Not crypto-grade; it only has to be unique enough to count devices.
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function visitorId() {
    return ls(function () {
      var id = localStorage.getItem(VISITOR_KEY);
      if (!id) { id = uid(); localStorage.setItem(VISITOR_KEY, id); }
      return id;
    }, 'anon');
  }

  function sessionId() {
    return ls(function () {
      var id = sessionStorage.getItem('jf.analytics.sid');
      if (!id) { id = uid(); sessionStorage.setItem('jf.analytics.sid', id); }
      return id;
    }, 'anon');
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
    } catch (e) { return 'unknown'; }
  }

  function read() {
    return ls(function () {
      var raw = localStorage.getItem(STORE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      return parsed && Array.isArray(parsed.events) ? parsed : { events: [] };
    }, { events: [] });
  }

  function write(store) {
    ls(function () {
      if (store.events.length > MAX_EVENTS) {
        store.events = store.events.slice(-MAX_EVENTS);
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    });
  }

  function endpoint() {
    return ls(function () { return localStorage.getItem(ENDPOINT_KEY) || ''; }, '');
  }

  function send(evt) {
    var url = endpoint();
    if (!url) return;
    ls(function () {
      var body = JSON.stringify(evt);
      if (global.navigator.sendBeacon) {
        global.navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      } else {
        fetch(url, { method: 'POST', body: body, keepalive: true,
                     headers: { 'Content-Type': 'application/json' } }).catch(function () {});
      }
    });
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
      vid: visitorId(),
      sid: sessionId()
    };
    if (extra) { Object.keys(extra).forEach(function (k) { evt[k] = extra[k]; }); }

    var store = read();
    store.events.push(evt);
    write(store);
    send(evt);
  }

  /* ---- auto-instrumentation ------------------------------------ */

  function autoTrack() {
    if (!enabled) return;

    track('pageview');

    // Time on page, recorded once when the tab goes away.
    var start = Date.now();
    var sent = false;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && !sent) {
        sent = true;
        track('session_end', '', { sec: Math.round((Date.now() - start) / 1000) });
      }
    });

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
        track('project_click', name ? name.textContent.trim() : href, { href: href });
        return;
      }

      if (/^https?:/i.test(href)) {
        var host = '';
        try { host = new URL(href).hostname.replace(/^www\./, ''); } catch (err) { host = href; }
        if (host !== location.hostname.replace(/^www\./, '')) track('outbound_click', host, { href: href });
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

  /* ---- public surface (also used by admin.html) ------------------ */

  global.JFAnalytics = {
    STORE_KEY: STORE_KEY,
    ENDPOINT_KEY: ENDPOINT_KEY,
    OPTOUT_KEY: OPTOUT_KEY,
    enabled: enabled,
    track: track,
    events: function () { return read().events; },
    clear: function () { ls(function () { localStorage.removeItem(STORE_KEY); }); },
    setEndpoint: function (url) {
      ls(function () {
        if (url) localStorage.setItem(ENDPOINT_KEY, url);
        else localStorage.removeItem(ENDPOINT_KEY);
      });
    },
    getEndpoint: endpoint,
    autoTrack: autoTrack
  };

  if (document.currentScript && document.currentScript.dataset.auto !== 'off') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoTrack);
    } else {
      autoTrack();
    }
  }
})(window);
