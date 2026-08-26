/* =================================================================
   Admin console.

   Content  — the server owns it. This loads the current version from
              /api/content, edits a working copy (kept in localStorage
              so a closed tab loses nothing), and PUTs it back on Save.
              Every save is a new version, so a bad edit is one click
              from undone.
   Analytics — /api/stats returns finished aggregates computed in SQL
              across every visitor. Nothing is counted in the browser.
   Auth     — the session cookie set at sign-in. This file is only
              served to a signed-in request in the first place.
   ================================================================= */
(function () {
  'use strict';

  var DRAFT_KEY   = 'jf.admin.draft';
  var TAB_KEY     = 'jf.admin.tab';
  var PREVIEW_KEY = 'jf.admin.preview';

  var state = {
    content: null,     // working copy
    published: null,   // last version the server confirmed
    version: null,     // its id
    user: null,
    tab: 'reel',
    range: 30,         // analytics window, days (0 = all)
    stats: null,
    statsError: null,
    versions: []
  };

  var openItems = new WeakSet(); // which repeater rows are expanded

  /* =============================================================
     1. Small utilities
     ============================================================= */

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      });
    }
    (Array.isArray(kids) ? kids : kids ? [kids] : []).forEach(function (kid) {
      if (kid == null) return;
      node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  var toastTimer;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('is-up');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('is-up'); }, 2200);
  }


  function nf(n) { return Number(n || 0).toLocaleString(); }

  function compact(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e4) return (n / 1e3).toFixed(0) + 'K';
    return n.toLocaleString();
  }

  function duration(sec) {
    sec = Math.round(sec || 0);
    if (!sec) return '—';
    if (sec < 60) return sec + 's';
    return Math.floor(sec / 60) + 'm ' + String(sec % 60).padStart(2, '0') + 's';
  }


  /* =============================================================
     2. Server calls
     ============================================================= */

  function api(path, options) {
    var opts = options || {};
    opts.headers = opts.headers || {};
    opts.headers.Accept = 'application/json';
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    opts.credentials = 'same-origin';

    return fetch(path, opts).then(function (res) {
      // The session expiring mid-edit shouldn't look like a random failure.
      if (res.status === 401) {
        location.href = '/admin';
        throw new Error('Session expired');
      }
      if (res.status === 204) return null;
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + res.status);
        return body;
      }, function () {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return null;
      });
    });
  }

  /* =============================================================
     3. Draft state
     ============================================================= */

  function isDirty() {
    return JSON.stringify(state.content) !== JSON.stringify(state.published);
  }

  function saveDraft() {
    try {
      if (isDirty()) localStorage.setItem(DRAFT_KEY, JSON.stringify(state.content));
      else localStorage.removeItem(DRAFT_KEY);
    } catch (e) { /* storage full or disabled — the download still works */ }
  }

  function touch() {
    saveDraft();
    paintStatus();
  }

  function paintStatus() {
    var chip = document.getElementById('status');
    var dirty = isDirty();
    chip.textContent = dirty
      ? 'unsaved changes'
      : (state.version ? 'published · v' + state.version : 'published');
    chip.className = 'status-chip ' + (dirty ? 'is-dirty' : 'is-clean');
  }

  /* =============================================================
     4. Form primitives
     ============================================================= */

  function field(cfg) {
    var id = 'f' + Math.random().toString(36).slice(2, 8);
    var control;

    if (cfg.type === 'textarea') {
      control = el('textarea', { id: id, rows: cfg.rows || 4, placeholder: cfg.placeholder || '' });
      control.value = cfg.value == null ? '' : cfg.value;
    } else if (cfg.type === 'select') {
      control = el('select', { id: id }, (cfg.options || []).map(function (o) {
        var opt = el('option', { value: o.value, text: o.label });
        if (String(o.value) === String(cfg.value)) opt.selected = true;
        return opt;
      }));
    } else if (cfg.type === 'checkbox') {
      control = el('input', { type: 'checkbox', id: id });
      control.checked = !!cfg.value;
    } else {
      control = el('input', { type: cfg.type || 'text', id: id, placeholder: cfg.placeholder || '' });
      control.value = cfg.value == null ? '' : cfg.value;
    }

    var evt = cfg.type === 'checkbox' || cfg.type === 'select' ? 'change' : 'input';
    control.addEventListener(evt, function () {
      cfg.onInput(cfg.type === 'checkbox' ? control.checked : control.value);
      touch();
      if (cfg.rerender) render();
    });

    var label = el('label', { for: id, text: cfg.label });

    if (cfg.type === 'checkbox') {
      return el('div', { class: 'field is-inline' }, [control, label]);
    }
    return el('div', { class: 'field' }, [
      label,
      control,
      cfg.hint ? el('p', { class: 'hint', text: cfg.hint }) : null
    ]);
  }

  function card(title, kids) {
    return el('div', { class: 'card' }, [title ? el('h3', { text: title }) : null].concat(kids));
  }

  function iconBtn(glyph, label, onClick, opts) {
    return el('button', {
      class: 'icon-btn' + (opts && opts.danger ? ' is-danger' : ''),
      type: 'button',
      title: label,
      'aria-label': label,
      disabled: opts && opts.disabled,
      onclick: onClick,
      text: glyph
    });
  }

  function moveItem(list, from, to) {
    if (to < 0 || to >= list.length) return;
    list.splice(to, 0, list.splice(from, 1)[0]);
  }

  /**
   * A reorderable list of objects. Structural edits re-render the tab,
   * which is why row-open state is tracked by object identity.
   */
  function repeater(cfg) {
    var list = cfg.items;
    var wrap = el('div');

    if (!list.length) {
      wrap.appendChild(el('div', { class: 'rep-empty', text: cfg.emptyText || 'Nothing here yet.' }));
    }

    list.forEach(function (item, i) {
      var isOpen = cfg.alwaysOpen || openItems.has(item);
      var body = el('div', { class: 'rep-body' + (isOpen ? '' : ' is-collapsed') }, cfg.body(item, i));

      var titleEl = el('span', { class: 'rep-title', text: cfg.title(item, i) || '(untitled)' });
      // Keep the collapsed-row label in step with the fields inside it.
      body.addEventListener('input', function () {
        titleEl.textContent = cfg.title(item, i) || '(untitled)';
      });

      var head = el('div', { class: 'rep-head' }, [
        el('span', { class: 'rep-index', text: String(i + 1).padStart(2, '0') }),
        titleEl,
        el('div', { class: 'rep-tools' }, [
          cfg.alwaysOpen ? null : iconBtn(isOpen ? '▾' : '▸', isOpen ? 'Collapse' : 'Expand', function () {
            if (openItems.has(item)) openItems.delete(item); else openItems.add(item);
            body.classList.toggle('is-collapsed');
            this.textContent = openItems.has(item) ? '▾' : '▸';
          }),
          iconBtn('↑', 'Move up', function () { moveItem(list, i, i - 1); touch(); render(); }, { disabled: i === 0 }),
          iconBtn('↓', 'Move down', function () { moveItem(list, i, i + 1); touch(); render(); }, { disabled: i === list.length - 1 }),
          iconBtn('✕', 'Delete', function () {
            if (!window.confirm('Delete “' + (cfg.title(item, i) || 'this entry') + '”?')) return;
            list.splice(i, 1); touch(); render();
          }, { danger: true })
        ])
      ]);

      wrap.appendChild(el('div', { class: 'rep-item' }, [head, body]));
    });

    wrap.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm', type: 'button',
      text: cfg.addLabel || '+ Add',
      onclick: function () {
        var fresh = cfg.blank();
        list.push(fresh);
        openItems.add(fresh);
        touch();
        render();
      }
    }));

    return wrap;
  }

  /** A flat list of one-line rows (tags, links) — no collapse, no card. */
  function rowList(cfg) {
    var list = cfg.items;
    var wrap = el('div');
    var rows = el('div', { class: 'row-list' });

    list.forEach(function (item, i) {
      var controls = cfg.controls(item, i).concat([
        iconBtn('↑', 'Move up', function () { moveItem(list, i, i - 1); touch(); render(); }, { disabled: i === 0 }),
        iconBtn('↓', 'Move down', function () { moveItem(list, i, i + 1); touch(); render(); }, { disabled: i === list.length - 1 }),
        iconBtn('✕', 'Remove', function () { list.splice(i, 1); touch(); render(); }, { danger: true })
      ]);
      rows.appendChild(el('div', { class: 'row-item' }, controls));
    });

    wrap.appendChild(rows);
    wrap.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm', type: 'button',
      text: cfg.addLabel || '+ Add',
      onclick: function () { list.push(cfg.blank()); touch(); render(); }
    }));
    return wrap;
  }

  /**
   * A reorderable list of plain strings (bio paragraphs, job bullets).
   * Strings have no identity to track, so every structural edit works on
   * the real array by index and re-renders the tab.
   */
  function stringList(cfg) {
    var list = cfg.items;
    var wrap = el('div');
    var rows = el('div', { class: 'row-list' });

    list.forEach(function (value, i) {
      var input;
      if (cfg.multiline) {
        input = el('textarea', { rows: cfg.rows || 3, placeholder: cfg.placeholder || '' });
        input.style.cssText = 'flex:1 1 auto;min-width:0;padding:9px 11px;background:var(--bg-2);' +
          'border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);' +
          'font:inherit;font-size:.88rem;line-height:1.55;resize:vertical';
      } else {
        input = el('input', { type: 'text', placeholder: cfg.placeholder || '' });
      }
      input.value = value;
      input.addEventListener('input', function () { list[i] = input.value; touch(); });

      rows.appendChild(el('div', { class: 'row-item', style: cfg.multiline ? 'align-items:flex-start' : '' }, [
        input,
        iconBtn('↑', 'Move up', function () { moveItem(list, i, i - 1); touch(); render(); }, { disabled: i === 0 }),
        iconBtn('↓', 'Move down', function () { moveItem(list, i, i + 1); touch(); render(); }, { disabled: i === list.length - 1 }),
        iconBtn('✕', 'Remove', function () { list.splice(i, 1); touch(); render(); }, { danger: true })
      ]));
    });

    if (!list.length) {
      wrap.appendChild(el('div', { class: 'rep-empty', text: cfg.emptyText || 'Nothing here yet.' }));
    }
    wrap.appendChild(rows);
    wrap.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm', type: 'button',
      text: cfg.addLabel || '+ Add',
      onclick: function () { list.push(''); touch(); render(); }
    }));
    return wrap;
  }

  function textRow(value, placeholder, onInput, flex) {
    var input = el('input', { type: 'text', placeholder: placeholder });
    input.value = value == null ? '' : value;
    if (flex) input.style.flex = flex;
    input.addEventListener('input', function () { onInput(input.value); touch(); });
    return input;
  }

  function selectRow(value, options, onInput) {
    var sel = el('select', {}, options.map(function (o) {
      var opt = el('option', { value: o.value, text: o.label });
      if (String(o.value) === String(value)) opt.selected = true;
      return opt;
    }));
    sel.addEventListener('change', function () { onInput(sel.value); touch(); });
    return sel;
  }

  function panelHead(title, desc) {
    return el('div', { class: 'panel-head' }, [
      el('h2', { text: title }),
      desc ? el('p', { text: desc }) : null
    ]);
  }

  var RICH_HINT = 'Light markup allowed: <strong>, <em>, <a href>, <br>. Everything else is stripped when the page renders.';

  /* =============================================================
     5. Content tabs
     ============================================================= */

  function tagRows(tags) {
    return rowList({
      items: tags,
      addLabel: '+ Add tag',
      blank: function () { return { label: '', variant: '' }; },
      controls: function (tag) {
        return [
          textRow(tag.label, 'Label', function (v) { tag.label = v; }),
          selectRow(tag.variant, [
            { value: '', label: 'default' },
            { value: 'vr', label: 'VR/XR' },
            { value: 'ai', label: 'AI-assisted' },
            { value: 'new', label: 'new' }
          ], function (v) { tag.variant = v; })
        ];
      }
    });
  }

  function actionRows(actions) {
    return rowList({
      items: actions,
      addLabel: '+ Add button',
      blank: function () { return { label: '', href: '', style: 'primary' }; },
      controls: function (a) {
        return [
          textRow(a.label, 'Button label', function (v) { a.label = v; }),
          textRow(a.href, 'https://…', function (v) { a.href = v; }, '1.4'),
          selectRow(a.style, [
            { value: 'primary', label: 'primary' },
            { value: 'ghost', label: 'ghost' }
          ], function (v) { a.style = v; })
        ];
      }
    });
  }

  function tabReel() {
    var r = state.content.reel;
    return [
      panelHead('Home / Demo reel', 'The first screen: headline, credential strip, the embedded reel, and the buttons under it.'),
      card('Headline', [
        field({ label: 'Eyebrow', value: r.eyebrow, onInput: function (v) { r.eyebrow = v; } }),
        field({ label: 'Name', value: r.name, onInput: function (v) { r.name = v; } }),
        field({ label: 'Lead paragraph', type: 'textarea', value: r.lead, hint: RICH_HINT,
                onInput: function (v) { r.lead = v; } })
      ]),
      card('Credential strip', [rowList({
        items: r.creds,
        addLabel: '+ Add credential',
        blank: function () { return { key: '', text: '' }; },
        controls: function (c) {
          return [
            textRow(c.key, 'ACE', function (v) { c.key = v; }, '0 0 140px'),
            textRow(c.text, 'What you did there', function (v) { c.text = v; }, '3')
          ];
        }
      })]),
      card('Featured video', [
        el('div', { class: 'grid-2' }, [
          field({ label: 'YouTube ID', value: r.youtubeId,
                  hint: 'The part after v= — e.g. 4gKCksgTrr0',
                  onInput: function (v) { r.youtubeId = v.trim(); } }),
          field({ label: 'Video title (accessibility)', value: r.videoTitle,
                  onInput: function (v) { r.videoTitle = v; } })
        ]),
        field({ label: 'Caption tag', value: r.captionTag, onInput: function (v) { r.captionTag = v; } }),
        field({ label: 'Caption text', type: 'textarea', rows: 2, value: r.captionText, hint: RICH_HINT,
                onInput: function (v) { r.captionText = v; } })
      ]),
      card('Buttons', [actionRows(r.actions)])
    ];
  }

  function tabAbout() {
    var a = state.content.about;
    return [
      panelHead('About', 'Headshot, bio paragraphs, and the contact row beneath them.'),
      card('Section', [
        el('div', { class: 'grid-2' }, [
          field({ label: 'Section title', value: a.title, onInput: function (v) { a.title = v; } }),
          field({ label: 'Section number', value: a.index, hint: 'Drawn by CSS beside the title.',
                  onInput: function (v) { a.index = v; } })
        ])
      ]),
      card('Photo', [
        el('div', { class: 'grid-2' }, [
          field({ label: 'Image path', value: a.photo, hint: 'Relative to the site root, e.g. assets/headshot.png',
                  onInput: function (v) { a.photo = v; } }),
          field({ label: 'Alt text', value: a.photoAlt, onInput: function (v) { a.photoAlt = v; } })
        ])
      ]),
      card('Bio', [
        stringList({
          items: a.paragraphs,
          multiline: true,
          rows: 4,
          emptyText: 'No paragraphs yet.',
          addLabel: '+ Add paragraph',
          placeholder: 'One paragraph of the bio'
        }),
        el('p', { class: 'hint', text: RICH_HINT })
      ]),
      card('Contact links', [rowList({
        items: a.contacts,
        addLabel: '+ Add link',
        blank: function () { return { label: '', href: '' }; },
        controls: function (c) {
          return [
            textRow(c.label, 'Label', function (v) { c.label = v; }),
            textRow(c.href, 'https://… or mailto:…', function (v) { c.href = v; }, '1.6')
          ];
        }
      })])
    ];
  }

  function tabExperience() {
    var x = state.content.experience;
    return [
      panelHead('Work history', 'The timeline. Drag order is top-to-bottom on the page; use ↑ ↓ to reorder.'),
      card('Section', [
        el('div', { class: 'grid-2' }, [
          field({ label: 'Section title', value: x.title, onInput: function (v) { x.title = v; } }),
          field({ label: 'Section number', value: x.index, onInput: function (v) { x.index = v; } })
        ])
      ]),
      card('Roles (' + x.jobs.length + ')', [repeater({
        items: x.jobs,
        emptyText: 'No roles yet.',
        addLabel: '+ Add role',
        title: function (j) { return (j.role || 'New role') + (j.org ? ' · ' + j.org : ''); },
        blank: function () {
          return { role: '', org: '', dates: '', key: false, tags: [], bullets: [''] };
        },
        body: function (j) {
          return [
            el('div', { class: 'grid-3' }, [
              field({ label: 'Role', value: j.role, onInput: function (v) { j.role = v; } }),
              field({ label: 'Organisation', value: j.org, onInput: function (v) { j.org = v; } }),
              field({ label: 'Dates', value: j.dates, onInput: function (v) { j.dates = v; } })
            ]),
            field({ label: 'Highlight this role (gradient rail + tag row)', type: 'checkbox', value: j.key,
                    onInput: function (v) { j.key = v; } }),
            el('div', { class: 'field' }, [el('label', { text: 'Tags' }), tagRows(j.tags)]),
            el('div', { class: 'field' }, [
              el('label', { text: 'Bullets' }),
              stringList({
                items: j.bullets,
                multiline: true,
                rows: 2,
                addLabel: '+ Add bullet',
                emptyText: 'No bullets yet.',
                placeholder: 'What you did'
              })
            ]),
            el('p', { class: 'hint', text: RICH_HINT })
          ];
        }
      })])
    ];
  }

  function tabProjects() {
    var p = state.content.projects;
    return [
      panelHead('Projects', 'One entry per card, in page order. Each has a hero — either an image in assets/ or a YouTube facade.'),
      card('Section', [
        el('div', { class: 'grid-2' }, [
          field({ label: 'Section title', value: p.title, onInput: function (v) { p.title = v; } }),
          field({ label: 'Section number', value: p.index, onInput: function (v) { p.index = v; } })
        ]),
        field({ label: 'Intro', type: 'textarea', rows: 2, value: p.intro, hint: RICH_HINT,
                onInput: function (v) { p.intro = v; } })
      ]),
      card('Entries (' + p.items.length + ')', [repeater({
        items: p.items,
        emptyText: 'No projects yet.',
        addLabel: '+ Add project',
        title: function (item) { return item.name || 'New project'; },
        blank: function () {
          return {
            name: '', desc: '', date: '', tags: [],
            media: { type: 'image', src: '', alt: '', portrait: false },
            actions: []
          };
        },
        body: function (item) {
          var m = item.media || (item.media = { type: 'image', src: '', alt: '', portrait: false });
          var mediaFields = m.type === 'video'
            ? [
                el('div', { class: 'grid-2' }, [
                  field({ label: 'YouTube ID', value: m.youtubeId,
                          onInput: function (v) { m.youtubeId = v.trim(); } }),
                  field({ label: 'Video title', value: m.videoTitle,
                          onInput: function (v) { m.videoTitle = v; } })
                ]),
                field({ label: 'Play-button label (accessibility)', value: m.ariaLabel,
                        onInput: function (v) { m.ariaLabel = v; } })
              ]
            : [
                field({ label: 'Image path', value: m.src, placeholder: 'assets/my-project.jpg',
                        onInput: function (v) { m.src = v; } }),
                field({ label: 'Alt text', type: 'textarea', rows: 2, value: m.alt,
                        hint: 'Describe what is in the frame — this is read aloud and shown if the image fails.',
                        onInput: function (v) { m.alt = v; } })
              ];

          return [
            el('div', { class: 'grid-2' }, [
              field({ label: 'Name', value: item.name, onInput: function (v) { item.name = v; } }),
              field({ label: 'Date', value: item.date, placeholder: '2026 / In development',
                      onInput: function (v) { item.date = v; } })
            ]),
            field({ label: 'Description', type: 'textarea', value: item.desc, hint: RICH_HINT,
                    onInput: function (v) { item.desc = v; } }),
            el('div', { class: 'grid-2' }, [
              field({ label: 'Hero type', type: 'select', value: m.type, rerender: true,
                      options: [{ value: 'image', label: 'Image' }, { value: 'video', label: 'YouTube video' }],
                      onInput: function (v) { m.type = v; } }),
              field({ label: 'Letterbox instead of crop (portrait capture)', type: 'checkbox',
                      value: m.portrait, onInput: function (v) { m.portrait = v; } })
            ])
          ].concat(mediaFields).concat([
            el('div', { class: 'field' }, [el('label', { text: 'Tags' }), tagRows(item.tags)]),
            el('div', { class: 'field' }, [el('label', { text: 'Buttons' }), actionRows(item.actions)])
          ]);
        }
      })])
    ];
  }

  function tabReferences() {
    var r = state.content.references;
    return [
      panelHead('References', 'Names, roles, and a link each. Emails and phone numbers stay off the public page.'),
      card('Section', [
        el('div', { class: 'grid-2' }, [
          field({ label: 'Section title', value: r.title, onInput: function (v) { r.title = v; } }),
          field({ label: 'Section number', value: r.index, onInput: function (v) { r.index = v; } })
        ]),
        field({ label: 'Footnote', value: r.note, onInput: function (v) { r.note = v; } })
      ]),
      card('People (' + r.people.length + ')', [repeater({
        items: r.people,
        emptyText: 'No references yet.',
        addLabel: '+ Add reference',
        alwaysOpen: true,
        title: function (p) { return p.name || 'New reference'; },
        blank: function () { return { name: '', role: '', href: '', linkLabel: 'LinkedIn' }; },
        body: function (p) {
          return [
            el('div', { class: 'grid-2' }, [
              field({ label: 'Name', value: p.name, onInput: function (v) { p.name = v; } }),
              field({ label: 'Role', value: p.role, placeholder: 'CTO · AceXR',
                      onInput: function (v) { p.role = v; } })
            ]),
            el('div', { class: 'grid-2' }, [
              field({ label: 'Link', value: p.href, onInput: function (v) { p.href = v; } }),
              field({ label: 'Link label', value: p.linkLabel, onInput: function (v) { p.linkLabel = v; } })
            ])
          ];
        }
      })])
    ];
  }

  function tabMeta() {
    var m = state.content.meta;
    var f = state.content.footer;
    return [
      panelHead('Site & footer', 'The browser tab title, the search-result snippet, and what a link preview shows when the site is shared.'),
      card('Metadata', [
        field({ label: 'Page title', value: m.title, onInput: function (v) { m.title = v; } }),
        field({ label: 'Description', type: 'textarea', rows: 2, value: m.description,
                hint: 'Aim for 150–160 characters — longer gets truncated in search results.',
                onInput: function (v) { m.description = v; } })
      ]),
      card('Link preview (Open Graph)', [
        field({ label: 'Share title', value: m.ogTitle, onInput: function (v) { m.ogTitle = v; } }),
        field({ label: 'Share description', type: 'textarea', rows: 2, value: m.ogDescription,
                onInput: function (v) { m.ogDescription = v; } }),
        field({ label: 'Share image', value: m.ogImage, onInput: function (v) { m.ogImage = v; } })
      ]),
      card('Footer', [
        field({ label: 'Name in the copyright line', value: f.owner, onInput: function (v) { f.owner = v; } }),
        el('div', { class: 'field' }, [
          el('label', { text: 'Footer links' }),
          rowList({
            items: f.links,
            addLabel: '+ Add link',
            blank: function () { return { label: '', href: '' }; },
            controls: function (l) {
              return [
                textRow(l.label, 'Label', function (v) { l.label = v; }),
                textRow(l.href, 'https://…', function (v) { l.href = v; }, '1.6')
              ];
            }
          })
        ])
      ])
    ];
  }

  /* =============================================================
     6. Analytics
     ============================================================= */

  function loadStats() {
    var days = state.range;
    var tz = new Date().getTimezoneOffset();
    return api('/api/stats?days=' + days + '&tz=' + tz)
      .then(function (data) { state.stats = data; state.statsError = null; })
      .catch(function (err) { state.stats = null; state.statsError = String(err.message || err); });
  }

  /**
   * Round the top of a scale up to a number a reader can do arithmetic on,
   * and keep it even so the midpoint gridline lands on a whole number too.
   */
  function niceTop(max) {
    if (!(max > 0)) return 4;
    var mag = Math.pow(10, Math.floor(Math.log10(max)));
    var candidates = [1, 2, 2.5, 4, 5, 10].map(function (m) { return m * mag; });
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] >= max && (candidates[i] / 2) % 1 === 0) return candidates[i];
    }
    return Math.ceil(max / 2) * 2;
  }

  /**
   * Single-series column chart. One hue, hairline gridlines, 24px cap on
   * bar thickness with a 2px surface gap, value labelled only at the peak.
   */
  function columnChart(points, opts) {
    opts = opts || {};
    var n = points.length;
    var padL = 42, padR = 12, padT = 22, padB = 26;
    var band = Math.max(9, Math.min(38, Math.round(660 / Math.max(n, 1))));
    var barW = Math.min(24, band - 2);
    var plotW = band * n;
    var plotH = opts.height || 180;
    var w = padL + plotW + padR;
    var h = padT + plotH + padB;

    var max = points.reduce(function (m, p) { return Math.max(m, p.value); }, 0);
    var top = niceTop(max);
    var peak = points.reduce(function (m, p, i) { return p.value > points[m].value ? i : m; }, 0);

    var svg = ['<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h +
               '" role="img" aria-label="' + escapeHtml(opts.aria || 'Column chart') + '">'];

    [0, 0.5, 1].forEach(function (frac) {
      var val = top * frac;
      var y = padT + plotH - plotH * frac;
      svg.push('<g class="chart-grid"><line x1="' + padL + '" y1="' + y + '" x2="' + (w - padR) + '" y2="' + y + '" /></g>');
      svg.push('<g class="chart-axis"><text x="' + (padL - 8) + '" y="' + (y + 3.5) + '" text-anchor="end">' + nf(val) + '</text></g>');
    });

    points.forEach(function (p, i) {
      var barH = top ? Math.max(p.value > 0 ? 2 : 0, (p.value / top) * plotH) : 0;
      var x = padL + i * band + (band - barW) / 2;
      var y = padT + plotH - barH;
      var r = Math.min(4, barW / 2, barH);
      // 4px rounded data-end, square at the baseline.
      var d = barH <= 0 ? '' :
        'M' + x + ' ' + (padT + plotH) +
        ' L' + x + ' ' + (y + r) +
        ' Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y +
        ' L' + (x + barW - r) + ' ' + y +
        ' Q' + (x + barW) + ' ' + y + ' ' + (x + barW) + ' ' + (y + r) +
        ' L' + (x + barW) + ' ' + (padT + plotH) + ' Z';

      svg.push('<g><title>' + escapeHtml(p.full || p.label) + ' — ' + nf(p.value) + ' ' +
               escapeHtml(opts.unit || 'views') + (p.extra ? ', ' + escapeHtml(p.extra) : '') + '</title>');
      if (d) svg.push('<path class="chart-bar" d="' + d + '" />');
      svg.push('<rect class="chart-hit" x="' + (padL + i * band) + '" y="' + padT +
               '" width="' + band + '" height="' + plotH + '" /></g>');
    });

    // Label the peak only — a number on every column goes unread.
    if (max > 0) {
      var px = padL + peak * band + band / 2;
      var py = padT + plotH - (points[peak].value / top) * plotH - 6;
      svg.push('<text class="chart-peak" x="' + px + '" y="' + Math.max(py, 10) +
               '" text-anchor="middle">' + nf(max) + '</text>');
    }

    var every = Math.max(1, Math.ceil(n / Math.floor(plotW / 58)));
    svg.push('<g class="chart-axis">');
    points.forEach(function (p, i) {
      if (i % every !== 0 && i !== n - 1) return;
      svg.push('<text x="' + (padL + i * band + band / 2) + '" y="' + (padT + plotH + 16) +
               '" text-anchor="middle">' + escapeHtml(p.label) + '</text>');
    });
    svg.push('</g></svg>');

    return svg.join('');
  }

  function barList(rows, opts) {
    opts = opts || {};
    if (!rows || !rows.length) {
      return el('p', { class: 'hint', text: opts.emptyText || 'No data in this range yet.' });
    }
    var max = rows[0].value || 1;
    return el('ul', { class: 'bar-list' }, rows.slice(0, opts.limit || 8).map(function (r) {
      return el('li', {}, [
        el('div', { class: 'bar-row' }, [
          el('span', { class: 'bar-name', text: r.label, title: r.label }),
          el('span', { class: 'bar-val', text: nf(r.value) })
        ]),
        el('div', { class: 'bar-track' }, [
          el('div', { class: 'bar-fill', style: 'width:' + Math.max(2, (r.value / max) * 100) + '%' })
        ])
      ]);
    }));
  }

  function statTile(label, value, sub) {
    return el('div', { class: 'stat-tile' }, [
      el('div', { class: 'stat-label', text: label }),
      el('div', { class: 'stat-value', text: value }),
      sub ? el('p', { class: 'stat-sub', text: sub }) : null
    ]);
  }

  function chartCard(title, sub, body) {
    return el('div', { class: 'chart-card' }, [
      el('h3', { text: title }),
      sub ? el('p', { class: 'chart-sub', text: sub }) : null,
      body
    ]);
  }

  function selectRowPlain(value, options, onChange) {
    var sel = el('select', {}, options.map(function (o) {
      var opt = el('option', { value: o.value, text: o.label });
      if (String(o.value) === String(value)) opt.selected = true;
      return opt;
    }));
    sel.addEventListener('change', function () { onChange(sel.value); });
    return sel;
  }

  function seriesPoints(series) {
    var short = series.length <= 14;
    return series.map(function (row) {
      var d = new Date(row.day + 'T12:00:00');
      return {
        label: short || d.getDate() === 1
          ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          : String(d.getDate()),
        full: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
        value: row.views,
        extra: row.visitors + ' unique'
      };
    });
  }

  function tabAnalytics() {
    var mount = el('div');

    function draw() {
      clear(mount);
      mount.appendChild(el('p', { class: 'hint', text: 'Loading…' }));

      loadStats().then(function () {
        clear(mount);

        mount.appendChild(el('div', { class: 'filter-row' }, [
          selectRowPlain(state.range, [
            { value: 7, label: 'Last 7 days' },
            { value: 30, label: 'Last 30 days' },
            { value: 90, label: 'Last 90 days' },
            { value: 365, label: 'Last 12 months' },
            { value: 0, label: 'All time' }
          ], function (v) { state.range = Number(v); draw(); }),
          el('span', { class: 'spacer' }),
          el('a', {
            class: 'btn btn-ghost btn-sm',
            href: '/api/stats/export.csv?days=' + state.range,
            text: 'Export CSV'
          }),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Refresh', onclick: draw })
        ]));

        if (state.statsError) {
          mount.appendChild(el('div', { class: 'callout is-warn', html:
            '<strong>Couldn’t load stats.</strong> ' + escapeHtml(state.statsError) }));
          return;
        }

        var s = state.stats;
        var t = s.totals;

        if (!t.pageviews && !t.sessions) {
          mount.appendChild(el('div', { class: 'empty-state' }, [
            el('strong', { text: 'No traffic recorded in this range' }),
            el('p', { text: 'Events are collected server-side from every visitor. If the site is live and this stays empty, check that analytics.js is loading and that /api/events returns 204.' })
          ]));
          return;
        }

        // hero — exactly one per view
        mount.appendChild(el('div', { class: 'hero-stat' }, [
          el('div', { class: 'stat-label', text: 'Page views' }),
          el('div', { class: 'stat-value', text: nf(t.pageviews) }),
          el('p', { class: 'stat-sub', text:
            nf(t.visitors) + ' visitors · ' + nf(t.sessions) + ' sessions · ' +
            (state.range ? 'last ' + state.range + ' days' : 'all time') })
        ]));

        mount.appendChild(el('div', { class: 'stat-grid' }, [
          statTile('Avg. time on page', duration(t.avgSeconds), nf(t.dwellSamples) + ' measured'),
          statTile('Read past the reel', (100 - t.bounceRate) + '%', 'sessions that scrolled or clicked'),
          statTile('Résumé downloads', compact(t.resumeDownloads), 'PDF link clicks'),
          statTile('Video plays', compact(t.videoPlays), 'reel + project facades'),
          statTile('Project clicks', compact(t.projectClicks), 'CTAs inside project cards'),
          statTile('Outbound clicks', compact(t.outboundClicks), 'links off the site')
        ]));

        mount.appendChild(chartCard('Page views per day', 'Hover a column for the exact count and unique visitors.',
          el('div', { class: 'chart-scroll', html: columnChart(seriesPoints(s.series), { aria: 'Page views per day' }) })));

        mount.appendChild(el('div', { class: 'two-col' }, [
          chartCard('Projects clicked', 'By project name.', barList(s.projects)),
          chartCard('Sections read', 'Scrolled at least 40% into view.', barList(s.sections))
        ]));

        mount.appendChild(el('div', { class: 'two-col' }, [
          chartCard('Referrers', 'Where visitors arrived from.', barList(s.referrers)),
          chartCard('Devices', 'Bucketed by viewport width.', barList(s.devices))
        ]));

        if ((s.videos && s.videos.length) || (s.outbound && s.outbound.length)) {
          mount.appendChild(el('div', { class: 'two-col' }, [
            chartCard('Videos played', 'Which reel or facade was started.', barList(s.videos)),
            chartCard('Outbound destinations', 'Links that took visitors off the site.', barList(s.outbound))
          ]));
        }

        // the table view, so nothing is gated behind a chart
        mount.appendChild(chartCard('Recent events', 'The 40 most recent, newest first.',
          el('div', { class: 'chart-scroll' }, [
            el('table', { class: 'data-table' }, [
              el('thead', {}, el('tr', {}, ['When', 'Event', 'Detail', 'Device', 'Referrer'].map(function (h) {
                return el('th', { text: h });
              }))),
              el('tbody', {}, (s.recent || []).map(function (e) {
                return el('tr', {}, [
                  el('td', { text: new Date(e.ts).toLocaleString() }),
                  el('td', { text: e.type }),
                  el('td', { text: e.label || (e.seconds ? e.seconds + 's' : '—') }),
                  el('td', { text: e.device || '—' }),
                  el('td', { text: e.referrer || '—' })
                ]);
              }))
            ])
          ])));
      });
    }

    draw();

    return [
      panelHead('Analytics', 'Collected server-side from every visitor — no third-party scripts, no cookies, no tracking id stored on anyone’s device. Visitors with Do Not Track on are not counted.'),
      mount
    ];
  }

  /* =============================================================
     7. Settings
     ============================================================= */

  function versionHistory() {
    var mount = el('div');

    function draw() {
      clear(mount);
      mount.appendChild(el('p', { class: 'hint', text: 'Loading…' }));

      api('/api/content/versions?limit=25').then(function (data) {
        clear(mount);
        var rows = (data && data.versions) || [];
        if (!rows.length) {
          mount.appendChild(el('p', { class: 'hint', text: 'No saved versions yet.' }));
          return;
        }
        mount.appendChild(el('div', { class: 'chart-scroll' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, el('tr', {}, ['Version', 'Saved', 'By', 'Note', ''].map(function (h) {
              return el('th', { text: h });
            }))),
            el('tbody', {}, rows.map(function (v, i) {
              return el('tr', {}, [
                el('td', { text: '#' + v.id + (i === 0 ? ' (live)' : '') }),
                el('td', { text: new Date(v.created_at).toLocaleString() }),
                el('td', { text: v.author || '—' }),
                el('td', { text: v.note || '—' }),
                el('td', {}, i === 0 ? null : el('button', {
                  class: 'btn btn-ghost btn-sm', type: 'button', text: 'Restore',
                  onclick: function () {
                    if (!window.confirm('Restore version #' + v.id + '? This saves it as a new version, so the current one stays in history.')) return;
                    api('/api/content/rollback', { method: 'POST', body: { version: v.id } })
                      .then(function () { return loadContent(); })
                      .then(function () { render(); toast('Restored version #' + v.id); })
                      .catch(function (err) { window.alert('Restore failed: ' + err.message); });
                  }
                }))
              ]);
            }))
          ])
        ]));
      }).catch(function (err) {
        clear(mount);
        mount.appendChild(el('p', { class: 'hint', text: 'Could not load history: ' + err.message }));
      });
    }

    draw();
    return mount;
  }

  function passwordCard() {
    var current = el('input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
    var next = el('input', { type: 'password', placeholder: 'New password (min 10 characters)', autocomplete: 'new-password' });
    var style = 'width:100%;padding:10px 12px;background:var(--bg-2);border:1px solid var(--border);' +
                'border-radius:var(--radius-sm);color:var(--text);font:inherit;margin-bottom:10px';
    current.style.cssText = style;
    next.style.cssText = style;

    return el('div', {}, [
      current,
      next,
      el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', text: 'Change password',
        onclick: function () {
          if (next.value.length < 10) { window.alert('Use at least 10 characters.'); return; }
          api('/api/auth/password', { method: 'POST', body: { current: current.value, next: next.value } })
            .then(function () {
              window.alert('Password changed. You will be signed out on every device.');
              location.href = '/admin';
            })
            .catch(function (err) { window.alert(err.message); });
        }
      }),
      el('p', { class: 'hint', text:
        'Stored as a scrypt hash on the server. Changing it signs out every device, including this one.' })
    ]);
  }

  function tabSettings() {
    var importInput = el('input', { type: 'file', accept: '.json,application/json' });
    importInput.style.display = 'none';
    importInput.addEventListener('change', function () {
      var file = importInput.files && importInput.files[0];
      if (!file) return;
      file.text().then(function (text) {
        try {
          var parsed = JSON.parse(text);
          if (!parsed.projects || !parsed.reel) throw new Error('That file has no reel/projects section.');
          state.content = parsed;
          touch();
          render();
          toast('Imported into the draft — Save & publish to make it live');
        } catch (err) {
          window.alert('Could not import: ' + err.message);
        }
      });
      importInput.value = '';
    });

    return [
      panelHead('Settings', 'Version history, your account, and moving content in and out as JSON.'),

      card('Publishing', [
        el('div', { class: 'callout', html:
          '<strong>Save &amp; publish writes to the server.</strong> The change is live on the next page ' +
          'load — no download, no commit, no redeploy. Every save is kept as a version below, and ' +
          '<code>content.json</code> in the repo stays as the seed and offline fallback.' }),
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
          el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Save & publish', onclick: save }),
          el('a', { class: 'btn btn-ghost btn-sm', href: '/api/content', download: 'content.json',
                    text: 'Download current JSON' }),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Import JSON',
                         onclick: function () { importInput.click(); } }),
          importInput
        ])
      ]),

      card('Version history', [versionHistory()]),

      card('Account', [
        el('p', { class: 'hint', text: 'Signed in as ' + (state.user ? state.user.email : '—') }),
        passwordCard()
      ]),

      card('Analytics', [
        el('p', { class: 'hint', text:
          'Events are recorded server-side and kept for 400 days by default (set EVENT_RETENTION_DAYS ' +
          'to change it). Visitors are identified by a hash of IP + user agent + a salt that rotates ' +
          'daily, so nothing is stored on their device and the hashes cannot be chained across days.' }),
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' }, [
          el('a', { class: 'btn btn-ghost btn-sm', href: '/api/stats/export.csv?days=365',
                    text: 'Export last 12 months (CSV)' })
        ])
      ]),

      card('Danger zone', [
        el('button', {
          class: 'btn btn-ghost btn-sm', type: 'button', text: 'Discard unsaved changes',
          onclick: function () {
            if (!isDirty()) { toast('Nothing to discard'); return; }
            if (!window.confirm('Discard every unsaved change and reload the published version?')) return;
            state.content = clone(state.published);
            try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
            touch(); render(); toast('Discarded');
          }
        })
      ])
    ];
  }
  /* =============================================================
     8. Shell
     ============================================================= */

  var TABS = [
    { group: 'Content', id: 'reel',        label: 'Home / Reel',  render: tabReel },
    { group: 'Content', id: 'about',       label: 'About',        render: tabAbout },
    { group: 'Content', id: 'experience',  label: 'Work history', render: tabExperience,
      count: function () { return state.content.experience.jobs.length; } },
    { group: 'Content', id: 'projects',    label: 'Projects',     render: tabProjects,
      count: function () { return state.content.projects.items.length; } },
    { group: 'Content', id: 'references',  label: 'References',   render: tabReferences,
      count: function () { return state.content.references.people.length; } },
    { group: 'Content', id: 'meta',        label: 'Site & footer', render: tabMeta },
    { group: 'Data',    id: 'analytics',   label: 'Analytics',    render: tabAnalytics },
    { group: 'System',  id: 'settings',    label: 'Settings',     render: tabSettings }
  ];

  function renderRail() {
    var rail = document.getElementById('rail');
    clear(rail);
    var lastGroup = null;
    TABS.forEach(function (tab) {
      if (tab.group !== lastGroup) {
        rail.appendChild(el('p', { class: 'rail-label', text: tab.group }));
        lastGroup = tab.group;
      }
      rail.appendChild(el('button', {
        type: 'button',
        class: state.tab === tab.id ? 'is-active' : '',
        onclick: function () {
          state.tab = tab.id;
          try { localStorage.setItem(TAB_KEY, tab.id); } catch (e) { /* ignore */ }
          render();
        }
      }, [
        el('span', { text: tab.label }),
        tab.count ? el('span', { class: 'rail-count', text: String(tab.count()) }) : null
      ]));
    });
  }

  var lastRenderedTab = null;

  function render() {
    renderRail();
    var panel = document.getElementById('panel');
    clear(panel);
    var tab = TABS.filter(function (t) { return t.id === state.tab; })[0] || TABS[0];
    tab.render().forEach(function (node) { if (node) panel.appendChild(node); });
    paintStatus();
    // Re-rendering after an in-place edit must not yank the page to the top;
    // only a genuine tab switch does that.
    if (lastRenderedTab !== tab.id) {
      window.scrollTo({ top: 0, behavior: 'auto' });
      lastRenderedTab = tab.id;
    }
  }

  function save() {
    if (!isDirty()) { toast('Nothing to save'); return; }
    var btn = document.getElementById('btn-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    api('/api/content', { method: 'PUT', body: { content: state.content } })
      .then(function (res) {
        state.published = clone(state.content);
        state.version = res.version;
        try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
        paintStatus();
        toast('Published — version #' + res.version + ' is live');
      })
      .catch(function (err) {
        window.alert('Save failed: ' + err.message + ' — your draft is safe in this browser.');
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'Save & publish';
      });
  }

  function loadContent() {
    return api('/api/content').then(function (data) {
      state.published = data;
      return data;
    });
  }

  function wireTopbar() {
    document.getElementById('btn-save').addEventListener('click', save);

    document.getElementById('btn-preview').addEventListener('click', function () {
      try {
        sessionStorage.setItem(PREVIEW_KEY, JSON.stringify(state.content));
      } catch (e) { /* the tab will just show the published version */ }
      // No `noopener` here on purpose: a noopener window starts with an empty
      // sessionStorage, and the draft is handed over through exactly that.
      // Same origin, our own page, so there is nothing to isolate from.
      window.open('/', '_blank');
      toast('Preview opened — that tab shows your unsaved draft');
    });

    document.getElementById('btn-revert').addEventListener('click', function () {
      if (!isDirty()) { toast('Nothing to discard'); return; }
      if (!window.confirm('Discard every unsaved change?')) return;
      state.content = clone(state.published);
      try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
      touch();
      render();
      toast('Back to the published version');
    });

    document.getElementById('btn-logout').addEventListener('click', function () {
      if (isDirty() && !window.confirm('You have unsaved changes. Sign out anyway?')) return;
      api('/api/auth/logout', { method: 'POST' })
        .catch(function () { /* signing out locally is enough */ })
        .then(function () { location.href = '/admin'; });
    });

    window.addEventListener('beforeunload', function (e) {
      if (!isDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  function fail(message, detail) {
    var panel = document.getElementById('panel');
    clear(panel);
    panel.appendChild(panelHead(message, ''));
    panel.appendChild(el('div', { class: 'callout is-warn', html: detail }));
    document.getElementById('status').textContent = 'not loaded';
  }

  function boot() {
    // styles.css sets scroll-behavior:smooth for the site's anchor nav; in the
    // admin it turns every tab switch into a visible slide, so opt out.
    document.documentElement.style.scrollBehavior = 'auto';
    wireTopbar();

    api('/api/auth/me')
      .then(function (me) {
        state.user = me;
        document.getElementById('who').textContent = me.email;
        return loadContent();
      })
      .then(function (published) {
        var draft = null;
        try {
          var raw = localStorage.getItem(DRAFT_KEY);
          if (raw) draft = JSON.parse(raw);
        } catch (e) { /* ignore a corrupt draft */ }

        state.content = draft || clone(published);
        if (draft) toast('Restored your unsaved draft');

        try {
          var saved = localStorage.getItem(TAB_KEY);
          if (saved && TABS.some(function (t) { return t.id === saved; })) state.tab = saved;
        } catch (e) { /* ignore */ }

        render();
      })
      .catch(function (err) {
        fail('Can’t load the site content',
          '<strong>' + escapeHtml(String(err.message || err)) + '</strong><br>' +
          'The server answered, but not with content. Check the service logs: ' +
          '<code>journalctl -u portfolio -n 50</code>');
      });
  }

  boot();
})();
