# Jacob Fletcher — Portfolio Site

A single-page portfolio/résumé site. No build step, no dependencies — just static files.

## Structure
```
index.html      Resume (main) + Portfolio tabs
styles.css      Styling (dark theme, responsive)
script.js       Tab switching + deep-linking (#resume / #portfolio)
assets/
  headshot.png                  Profile photo
  Jake_Fletcher_Resume_2026.pdf Downloadable résumé
Reference/      Original source files (not used by the site)
```

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
- Edit résumé copy directly in `index.html` (Resume section).
- To swap/add portfolio videos, duplicate a `.video-card` block and change the
  YouTube embed ID and blurb.
- Reference contacts' LinkedIn URLs are placeholders (`linkedin.com`) — drop in the
  real profile links when you have them. Reference emails/phones were intentionally
  left off the public page.
