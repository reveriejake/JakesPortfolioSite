/* =================================================================
   Page behaviour + content hydration.

   The markup in index.html is the fallback: it renders correctly with
   no JS and over file://. When content.json loads, every editable
   region below is re-rendered from it, so admin.html only ever has to
   write JSON. If the fetch fails, the static markup simply stays.
   ================================================================= */
(function () {
  'use strict';

  /* ---- escaping ------------------------------------------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Content fields may carry light markup (<strong>, links). Anything
  // outside this allowlist is unwrapped rather than trusted.
  var ALLOWED_TAGS  = ['STRONG', 'B', 'EM', 'I', 'BR', 'A', 'SPAN', 'CODE', 'SMALL'];
  var ALLOWED_ATTRS = { A: ['href', 'target', 'rel'], SPAN: ['class'] };

  function rich(html) {
    var doc = new DOMParser().parseFromString('<div>' + String(html == null ? '' : html) + '</div>', 'text/html');
    var root = doc.body.firstChild;

    (function walk(node) {
      Array.prototype.slice.call(node.children).forEach(function (el) {
        walk(el);
        if (ALLOWED_TAGS.indexOf(el.tagName) === -1) {
          while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
          el.remove();
          return;
        }
        var keep = ALLOWED_ATTRS[el.tagName] || [];
        Array.prototype.slice.call(el.attributes).forEach(function (attr) {
          var name = attr.name.toLowerCase();
          if (keep.indexOf(name) === -1) { el.removeAttribute(attr.name); return; }
          if (name === 'href' && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
        });
        if (el.tagName === 'A' && el.target === '_blank') el.setAttribute('rel', 'noopener');
      });
    })(root);

    return root.innerHTML;
  }

  function isExternal(href) {
    return /^https?:\/\//i.test(href || '');
  }

  function linkAttrs(href) {
    return isExternal(href) ? ' target="_blank" rel="noopener"' : '';
  }

  /* ---- video facades -------------------------------------------- */

  // Project videos stay thumbnail facades until clicked, so the page
  // loads one YouTube player (the reel) instead of several.
  function bindVideoFacades(scope) {
    (scope || document).querySelectorAll('.lite-yt:not([data-bound])').forEach(function (btn) {
      btn.setAttribute('data-bound', '1');

      // maxresdefault doesn't exist for every upload — fall back to hqdefault.
      var img = btn.querySelector('img');
      if (img) {
        img.addEventListener('error', function onErr() {
          img.removeEventListener('error', onErr);
          img.src = 'https://i.ytimg.com/vi/' + btn.dataset.yt + '/hqdefault.jpg';
        });
      }

      btn.addEventListener('click', function () {
        var frame = document.createElement('iframe');
        frame.src =
          'https://www.youtube-nocookie.com/embed/' + btn.dataset.yt + '?autoplay=1&rel=0';
        frame.title = btn.dataset.ytTitle || 'Video';
        frame.allow =
          'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
        frame.referrerPolicy = 'strict-origin-when-cross-origin';
        frame.allowFullscreen = true;
        btn.replaceWith(frame);
      });
    });
  }

  /* ---- renderers ------------------------------------------------ */

  function setMeta(selector, value) {
    var el = document.querySelector(selector);
    if (el && value) el.setAttribute('content', value);
  }

  function renderMeta(m) {
    if (!m) return;
    if (m.title) document.title = m.title;
    setMeta('meta[name="description"]', m.description);
    setMeta('meta[property="og:title"]', m.ogTitle);
    setMeta('meta[property="og:description"]', m.ogDescription);
    setMeta('meta[property="og:image"]', m.ogImage);
  }

  function tagRow(tags, className) {
    if (!tags || !tags.length) return '';
    return '<p class="' + className + '">' + tags.map(function (t) {
      return '<span class="tag' + (t.variant ? ' tag-' + esc(t.variant) : '') + '">' + esc(t.label) + '</span>';
    }).join('\n') + '</p>';
  }

  function buttonRow(actions) {
    if (!actions || !actions.length) return '';
    return actions.map(function (a) {
      return '<a class="btn btn-' + (a.style === 'ghost' ? 'ghost' : 'primary') + '" href="' +
        esc(a.href) + '"' + linkAttrs(a.href) + '>' + esc(a.label) + '</a>';
    }).join('\n');
  }

  function renderReel(r) {
    if (!r) return;
    var head = document.querySelector('.reel-head');
    if (head) {
      head.innerHTML =
        '<p class="eyebrow">' + esc(r.eyebrow) + '</p>' +
        '<h1>' + esc(r.name) + '</h1>' +
        '<p class="lead">' + rich(r.lead) + '</p>' +
        (r.creds && r.creds.length
          ? '<ul class="cred-row">' + r.creds.map(function (c) {
              return '<li><span class="cred-key">' + esc(c.key) + '</span> ' + rich(c.text) + '</li>';
            }).join('') + '</ul>'
          : '');
    }

    var frame = document.querySelector('.reel-stage .video-embed iframe');
    if (frame && r.youtubeId) {
      var next = 'https://www.youtube-nocookie.com/embed/' + r.youtubeId + '?rel=0';
      if (frame.getAttribute('src') !== next) frame.setAttribute('src', next);
      frame.setAttribute('title', r.videoTitle || 'Demo reel');
    }

    var caption = document.querySelector('.reel-caption');
    if (caption) {
      caption.innerHTML =
        '<span class="tag tag-new">' + esc(r.captionTag) + '</span>' +
        '<p>' + rich(r.captionText) + '</p>';
    }

    var actions = document.querySelector('.reel-actions');
    if (actions) actions.innerHTML = buttonRow(r.actions);
  }

  function renderBlockTitle(sectionId, data) {
    var h2 = document.querySelector('#' + sectionId + ' .block-title');
    if (!h2 || !data) return;
    if (data.title) h2.textContent = data.title;
    if (data.index) h2.setAttribute('data-index', data.index);
  }

  function renderAbout(a) {
    if (!a) return;
    renderBlockTitle('about', a);

    var photo = document.querySelector('.about-photo img');
    if (photo) {
      if (a.photo) photo.src = a.photo;
      photo.alt = a.photoAlt || '';
    }

    var text = document.querySelector('.about-text');
    if (text) {
      text.innerHTML =
        (a.paragraphs || []).map(function (p) { return '<p class="prose">' + rich(p) + '</p>'; }).join('\n') +
        ((a.contacts && a.contacts.length)
          ? '<ul class="contact-row">' + a.contacts.map(function (c) {
              return '<li><a href="' + esc(c.href) + '"' + linkAttrs(c.href) + '>' + esc(c.label) + '</a></li>';
            }).join('') + '</ul>'
          : '');
    }
  }

  function renderExperience(x) {
    if (!x) return;
    renderBlockTitle('experience', x);

    var list = document.querySelector('.timeline');
    if (!list) return;
    list.innerHTML = (x.jobs || []).map(function (job) {
      return '<article class="job' + (job.key ? ' is-key' : '') + '">' +
        '<div class="job-head">' +
          '<h3>' + esc(job.role) + (job.org ? ' <span class="at">· ' + esc(job.org) + '</span>' : '') + '</h3>' +
          '<span class="job-dates">' + esc(job.dates) + '</span>' +
        '</div>' +
        tagRow(job.tags, 'job-tags') +
        '<ul>' + (job.bullets || []).map(function (b) { return '<li>' + rich(b) + '</li>'; }).join('') + '</ul>' +
      '</article>';
    }).join('\n');
  }

  function projectMedia(m) {
    if (!m) return '';
    var cls = 'project-media' + (m.portrait ? ' is-portrait' : '');
    if (m.type === 'video') {
      return '<div class="' + cls + '">' +
        '<div class="video-embed">' +
          '<button class="lite-yt" type="button" data-yt="' + esc(m.youtubeId) + '"' +
            ' data-yt-title="' + esc(m.videoTitle || '') + '"' +
            ' aria-label="' + esc(m.ariaLabel || 'Play video') + '">' +
            '<img src="https://i.ytimg.com/vi/' + esc(m.youtubeId) + '/maxresdefault.jpg" alt="" loading="lazy" />' +
            '<span class="play-badge" aria-hidden="true">▶</span>' +
          '</button>' +
        '</div>' +
      '</div>';
    }
    return '<div class="' + cls + '">' +
      '<img src="' + esc(m.src) + '" alt="' + esc(m.alt || '') + '" loading="lazy" />' +
    '</div>';
  }

  function renderProjects(p) {
    if (!p) return;
    renderBlockTitle('projects', p);

    var intro = document.querySelector('#projects .section-intro');
    if (intro && p.intro) intro.innerHTML = rich(p.intro);

    var list = document.querySelector('.project-list');
    if (!list) return;
    list.innerHTML = (p.items || []).map(function (item) {
      var cta = buttonRow(item.actions);
      return '<article class="project">' +
        projectMedia(item.media) +
        '<div class="project-body">' +
          tagRow(item.tags, 'project-tags') +
          '<h3 class="project-name">' + esc(item.name) + '</h3>' +
          '<p class="project-desc">' + rich(item.desc) + '</p>' +
          '<p class="project-date">' + esc(item.date) + '</p>' +
          (cta ? '<div class="project-actions">' + cta + '</div>' : '') +
        '</div>' +
      '</article>';
    }).join('\n');

    bindVideoFacades(list);
  }

  function renderReferences(r) {
    if (!r) return;
    renderBlockTitle('references', r);

    var grid = document.querySelector('.refs-grid');
    if (grid) {
      grid.innerHTML = (r.people || []).map(function (person) {
        return '<div class="ref-card">' +
          '<p class="ref-name">' + esc(person.name) + '</p>' +
          '<p class="ref-role">' + esc(person.role) + '</p>' +
          (person.href
            ? '<a href="' + esc(person.href) + '"' + linkAttrs(person.href) + '>' +
              esc(person.linkLabel || 'Link') + '</a>'
            : '') +
        '</div>';
      }).join('\n');
    }

    var note = document.querySelector('#references .note');
    if (note && r.note) note.textContent = r.note;
  }

  function renderFooter(f) {
    if (!f) return;
    var owner = document.querySelector('.footer-inner p');
    if (owner) {
      owner.innerHTML = '© <span id="year"></span> ' + esc(f.owner);
    }
    var links = document.querySelector('.footer-links');
    if (links) {
      links.innerHTML = (f.links || []).map(function (l) {
        return '<li><a href="' + esc(l.href) + '"' + linkAttrs(l.href) + '>' + esc(l.label) + '</a></li>';
      }).join('');
    }
  }

  function stampYear() {
    var yearEl = document.getElementById('year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();
  }

  function render(content) {
    renderMeta(content.meta);
    renderReel(content.reel);
    renderAbout(content.about);
    renderExperience(content.experience);
    renderProjects(content.projects);
    renderReferences(content.references);
    renderFooter(content.footer);
    stampYear();
  }

  /* ---- boot ----------------------------------------------------- */

  bindVideoFacades();
  stampYear();

  // A draft saved in the admin previews here without publishing; the
  // published content.json is what every other visitor sees.
  var preview = null;
  try {
    var raw = sessionStorage.getItem('jf.admin.preview');
    if (raw) preview = JSON.parse(raw);
  } catch (e) { /* storage unavailable — fall through to the fetch */ }

  if (preview) {
    render(preview);
    document.documentElement.setAttribute('data-preview', 'draft');
  } else {
    fetch('content.json', { cache: 'no-cache' })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error(res.status)); })
      .then(render)
      .catch(function () { /* file:// or missing content.json — static markup stands */ });
  }
})();
