# Jacob Fletcher — Portfolio Site

A single-page portfolio/résumé site. No build step, no dependencies — just static files.

## Structure
```
index.html      One page: Demo Reel → About Me → Work History → Projects → References
styles.css      Styling (responsive; palette + motifs documented at the top of the file)
script.js       Click-to-load video facades + footer year
assets/
  headshot.png                  Profile photo
  procedural-landscape.png      Hero backdrop
  ace.jpg  bookjake.jpg  aupex.jpg  sow-generator.jpg
  balencil.jpg  overlap.jpg  sol-defender.jpg
  dollar-origami.png  balloon-animals.jpg  ansel-and-clair.webp
  project-stardust.png  editor-tool.jpg (2DVLS)  quickropes.jpg
                                One hero image per project, in list order
  terrain-tech.jpg              Unused — awaiting a project to belong to
  Jake_Fletcher_Resume_2026.pdf Downloadable résumé
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

## Content notes
- Edit copy directly in `index.html`; sections are marked with numbered comment banners.
- To swap the featured reel, change the YouTube ID in the `#reel` iframe `src`.
- To add a project, duplicate an `<article class="project">` block. Each one holds a
  `.project-media` hero (either an `<img>` or a video facade), then `.project-name`,
  `.project-desc`, `.project-date`, and an optional `.project-actions` CTA row.
- `.tag-ai` marks AI-assisted projects; `.project-tags` is the chip row above a name.
- Portrait captures (phone screenshots) go on `.project-media.is-portrait`, which
  letterboxes instead of cropping the frame to a ribbon.
- Video heroes are **facades**: a thumbnail plus a play button that swaps itself for a
  real iframe on click (set `data-yt` to the YouTube ID). Only the hero reel embeds a
  live player on page load, which keeps YouTube's console noise and payload down.
- Roles worth spotlighting carry `class="job is-key"` plus a `.job-tags` row; `.tag-vr` is the VR/XR pill.
- There is no site nav — the page reads top to bottom.
- Reference emails/phones were intentionally left off the public page.
