# Jacob Fletcher — Portfolio Site

A single-page portfolio/résumé site. No build step, no dependencies — just static files.

## Structure
```
index.html      One page: Demo Reel → About Me → Work History → Projects → References
content.json    Every editable string on the page — the source of truth
styles.css      Styling (responsive; palette + motifs documented at the top of the file)
script.js       Renders index.html from content.json; video facades; footer year
analytics.js    First-party event log (localStorage, optional POST endpoint)
admin.html      Admin console — edit content, read analytics
admin.css       Admin styling (layered on styles.css, so it shares the tokens)
admin.js        Admin behaviour
assets/
  headshot.png                  Profile photo
  procedural-landscape.png      Hero backdrop
  ace.jpg  bookjake.jpg  aupex.jpg  sow-generator.jpg
  balencil.jpg  overlap.jpg  sol-defender.jpg
  dollar-origami.png  balloon-animals.jpg  ansel-and-clair.webp
  project-stardust.png  editor-tool.jpg (2DVLS)  quickropes.jpg
                                One hero image per project, in list order
  terrain-tech.jpg              Unused — awaiting a project to belong to
  Jacob_Fletcher_Resume.pdf     Downloadable résumé
Reference/      Original source files (not used by the site)
```

## Page order
1. **Demo Reel** (`#reel`) — the 2026 reel embedded front and center, with a VR/ACE/Microsoft credential strip.
2. **About Me** (`#about`) — headshot, bio, contact links.
3. **Work History** (`#experience`) — professional timeline.
4. **Projects** (`#projects`) — a vertical list; each entry is one hero image plus name,
   description, date, and an optional CTA.
5. References (`#references`) — supporting section at the end.

## Visual system
The palette is sampled from Jake's own renders in `Reference/` — the cyan → lavender →
magenta → violet ramp of `ProceduralLandscape_01`, over the near-black indigo of
`ArtisticViewOfEditorTool`. Tokens live in `:root` at the top of `styles.css`.

Recurring motifs, so new sections stay consistent:
- **Soft rectangles** — cards, buttons, and images share two radii (`--radius` /
  `--radius-sm`); no cut corners, no corner brackets.
- **Gradient rails and edges** — accents are drawn as thin gradient lines rather than
  ornament: a cyan→violet rail down the left of each job card, a spectrum hairline
  across the top of the reel frame, a gradient ring behind the headshot.
- **Mono labels** — JetBrains Mono for eyebrows, tags, dates, buttons, and captions;
  Space Grotesk for headings; Inter for body copy.
- **Numbered headers** — `<h2 class="block-title" data-index="0N">`; the number and
  trailing rule are drawn by CSS.
- **Editor grid** — a faint violet grid overlays the page and fades out below the fold.

## Run locally
Open `index.html` directly, or serve it (recommended, so the YouTube embeds behave):

```bash
# Python
python -m http.server 8000
# then visit http://localhost:8000
```

## Deploy
Any static host works — drag the folder onto **Netlify**, push to **GitHub Pages**,
or upload to **Cloudflare Pages** / S3. No configuration required.

## Admin console

Serve the folder and open **`http://localhost:8000/admin.html`**. It asks for a passcode
the first time and stores a hash of it in that browser. This is a latch, not security —
the files sit on a public static host either way. If that matters, leave `admin.html`,
`admin.css`, and `admin.js` out of what you deploy; the site does not need them.

**Content tabs** edit `content.json` — headline and reel, bio, work history, projects,
references, page metadata and footer. Lists reorder with ↑ ↓ and delete with ✕. Changes
are kept as a draft in the browser, so a closed tab loses nothing, and the chip in the
top bar says whether the draft still matches `content.json`.

There is no server to save to, so publishing is a file move:

1. **Preview** opens the site in a new tab rendered from your draft.
2. **Download content.json** (or **Copy JSON**) gives you the new file.
3. Drop it next to `index.html` and deploy.

**Analytics tab** reads what `analytics.js` records: page views per day, unique visitors
and sessions, average time on page, résumé downloads, video plays, project clicks,
outbound clicks, sections actually scrolled into view, referrers, and devices — plus a
raw event table and a CSV export.

By default those events live in `localStorage` **on each visitor's own device**, so the
dashboard shows the browser you open it in and nothing else. A static host has no way to
pool them. To count every visitor, set a **collection endpoint** in Settings: each event
is then POSTed there as JSON, and the tab reads totals back from a GET. Visitors with Do
Not Track on are never recorded, and Settings has a switch to keep your own visits out.

## Content notes
- Copy lives in `content.json`. `script.js` renders the page from it on load; the markup
  in `index.html` is the fallback that shows when the file is missing or the page is
  opened over `file://`. Edit the JSON (or use the admin), not both — if you do change
  `index.html` by hand, mirror it in `content.json` or the JSON will win.
- Rich fields (`lead`, `desc`, bullets, bio paragraphs) accept `<strong>`, `<em>`, `<a>`,
  `<br>`, `<span>`, `<code>`. Everything else is stripped when the page renders.
- To swap the featured reel, change `reel.youtubeId`.
- To add a project, add an object to `projects.items`: `name`, `desc`, `date`, `tags`, a
  `media` hero (`type: "image"` with `src`/`alt`, or `type: "video"` with `youtubeId`),
  and an optional `actions` CTA row.
- `tags: [{label, variant}]` — `variant: "ai"` marks AI-assisted work, `"vr"` the VR/XR
  pill, `"new"` the accent chip; `""` is the plain chip.
- Portrait captures (phone screenshots) set `media.portrait: true`, which letterboxes
  instead of cropping the frame to a ribbon.
- Video heroes are **facades**: a thumbnail plus a play button that swaps itself for a
  real iframe on click. Only the hero reel embeds a live player on page load, which keeps
  YouTube's console noise and payload down.
- Roles worth spotlighting set `"key": true` on the job, which draws the gradient rail.
- There is no site nav — the page reads top to bottom.
- Reference emails/phones were intentionally left off the public page.
