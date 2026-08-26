# Jacob Fletcher — Portfolio Site

A single-page portfolio/résumé site with a small CMS and first-party analytics
behind it. Node + Express + SQLite; no external services, no monthly cost.

## Structure
```
public/                     Everything the world can fetch — and nothing else
  index.html                One page: Demo Reel → About → Work History → Projects → References
  styles.css                Styling (palette + motifs documented at the top of the file)
  script.js                 Renders the page from the content API; video facades
  analytics.js              Sends events to /api/events
  assets/                   Images, and Jacob_Fletcher_Resume.pdf

server/
  server.js                 Routes: static site, content API, analytics, auth, admin
  lib/db.js                 SQLite schema + queries
  lib/auth.js               scrypt passwords, server-side sessions
  lib/stats.js              Analytics aggregation (SQL)
  bin/create-user.js        Create an admin user / reset a password
  bin/seed-content.js       Import content.json into the database
  private/                  Admin console — never served without a session
    admin.html  admin.css  admin.js  login.html

deploy/
  portfolio.service         systemd unit
  nginx.conf                Reverse proxy + TLS

content.json                Seed content. Not served; the database is the live copy.
data/site.db                SQLite (created on first run; gitignored)
Reference/                  Original source files (gitignored, never published)
```

**`public/` is the static root, and that is load-bearing.** Anything placed there is
world-readable. The server, the database, and `Reference/` sit outside it on purpose —
a static root above your source directory will serve your source.

## Running it

```bash
cd server
npm install
npm run create-user -- you@example.com    # prompts for a password
npm run seed                              # optional: content.json → database
npm start                                 # http://127.0.0.1:3000
```

Environment variables (all optional): `PORT`, `HOST`, `SITE_ROOT`, `DATA_DIR`,
`SEED_FILE`, `EVENT_RETENTION_DAYS`, `TRUST_PROXY_HOPS`, `NODE_ENV`.

## Deploying to EC2

```bash
sudo mkdir -p /var/www/portfolio /var/lib/portfolio
sudo rsync -a --exclude Reference --exclude data ./ /var/www/portfolio/
sudo chown -R www-data:www-data /var/www/portfolio /var/lib/portfolio

cd /var/www/portfolio/server && sudo -u www-data npm ci --omit=dev
sudo -u www-data npm run create-user -- you@example.com

sudo cp /var/www/portfolio/deploy/portfolio.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now portfolio

sudo cp /var/www/portfolio/deploy/nginx.conf /etc/nginx/sites-available/portfolio
sudo ln -s /etc/nginx/sites-available/portfolio /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d example.com -d www.example.com
```

Security group: allow 80 and 443 only. The Node process binds `127.0.0.1`, so it is
not reachable from the internet except through nginx.

Logs: `journalctl -u portfolio -f`. Back up `/var/lib/portfolio/site.db` — it holds
your content history and every analytics event.

**Don't add a `root` + `try_files` block for the site directory in nginx.** Everything
must go through Node, or nginx will happily serve files the app means to protect.

## Admin console

`https://your-domain/admin` — email and password, checked on the server. A session
cookie (HttpOnly, Secure, SameSite=Lax) is stored server-side and can be revoked.

Without a session, `/admin` shows the sign-in page and the console's own JS and CSS
return **404**, not 401 — an anonymous visitor gets exactly what they'd get for any
path that doesn't exist. Failed logins are throttled to 8 per IP per 15 minutes.

**Content tabs** — Home/Reel, About, Work history, Projects, References, Site & footer.
Lists reorder with ↑ ↓ and delete with ✕. Edits are kept as a local draft until you
press **Save & publish**, which writes to the database; the change is live on the next
page load, with no redeploy. Every save is a version, and **Settings → Version history**
restores any of them (a restore is itself a new version, so it's undoable too).

**Analytics tab** — page views per day, unique visitors, sessions, average time on page,
how many sessions read past the reel, résumé downloads, video plays, project clicks,
outbound clicks, referrers, devices, and a raw event table. CSV export for any range.

## Analytics, and what it does not collect

Events are recorded server-side from every visitor. No third-party scripts, no cookies,
and nothing stored on the visitor's device — so there is nothing to put a consent banner
in front of.

- A visitor is counted as `sha256(daily_salt + IP + user-agent)`, truncated. The salt
  rotates every UTC day, so the hashes cannot be chained across days into a profile,
  and the raw IP is never written down.
- A per-tab session id lives in `sessionStorage` and dies with the tab. It only groups
  one visit's events together.
- `Do Not Track` is honoured — those visitors send nothing.
- Obvious bots are dropped by user-agent, and your own visits aren't counted while
  you're signed in to the admin in that browser.
- Events are kept 400 days (`EVENT_RETENTION_DAYS`), then pruned automatically.

## Content notes
- The database is the live copy. `content.json` in the repo is the seed used on first
  boot and the fallback if the table is ever empty — edit content in the admin, not
  in the file.
- Rich fields (`lead`, `desc`, bullets, bio paragraphs) accept `<strong>`, `<em>`,
  `<a>`, `<br>`, `<span>`, `<code>`. Everything else is stripped when the page renders.
- To swap the featured reel, change the YouTube ID on the Home/Reel tab.
- A project has a `media` hero — either an image in `public/assets/` or a YouTube
  facade. Portrait captures set "letterbox instead of crop".
- Tag variants: `ai` marks AI-assisted work, `vr` the VR/XR pill, `new` the accent chip.
- Video heroes are **facades**: a thumbnail plus a play button that swaps itself for a
  real iframe on click. Only the hero reel loads a player up front.
- Roles worth spotlighting set "highlight this role", which draws the gradient rail.
- There is no site nav — the page reads top to bottom.
- Reference emails/phones are intentionally left off the public page and the résumé.

## Visual system
The palette is sampled from Jake's own renders in `Reference/` — the cyan → lavender →
magenta → violet ramp of `ProceduralLandscape_01`, over the near-black indigo of
`ArtisticViewOfEditorTool`. Tokens live in `:root` at the top of `public/styles.css`,
and the admin inherits them rather than redeclaring them.

Recurring motifs, so new sections stay consistent:
- **Soft rectangles** — cards, buttons, and images share two radii (`--radius` /
  `--radius-sm`); no cut corners, no corner brackets.
- **Gradient rails and edges** — accents are thin gradient lines rather than ornament:
  a cyan→violet rail down the left of each job card, a spectrum hairline across the top
  of the reel frame, a gradient ring behind the headshot.
- **Mono labels** — JetBrains Mono for eyebrows, tags, dates, buttons, and captions;
  Space Grotesk for headings; Inter for body copy.
- **Numbered headers** — `<h2 class="block-title" data-index="0N">`; the number and
  trailing rule are drawn by CSS.
- **Editor grid** — a faint violet grid overlays the page and fades out below the fold.
