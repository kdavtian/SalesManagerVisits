# User guide

Source for the in-app guide (Settings -> User guide). Two PDFs are shipped:
`client/public/docs/kad-motors-guide-hy.pdf` (Armenian) and `...-en.pdf`
(English); the app opens the one matching the UI language.

- `content.py` - all text, both languages, one entry per section (keep the
  Armenian labels identical to `client/public/js/i18n.js`).
- `screens/` - phone screenshots (demo data) used by the sections.
- `build.py` - writes `build/guide-{hy,en}.html`.
- `render.mjs` - prints the PDFs with the repo's Playwright.

Rebuild:

```bash
npm i --prefix /tmp/guidefonts @fontsource/noto-sans @fontsource/noto-sans-armenian
mkdir -p /tmp/guidefonts/f && cp /tmp/guidefonts/node_modules/@fontsource/noto-sans*/files/*-{400,700}-normal.woff2 /tmp/guidefonts/f/
cd docs/user-guide
GUIDE_FONT_DIR=/tmp/guidefonts/f python3 build.py
node render.mjs
```

When the app UI changes enough to mislead (new navigation, moved buttons),
refresh the screenshots, edit `content.py`, bump `VERSION` there and
`GUIDE_VERSION` in `client/public/js/views/settings.js`, rebuild, and ship
with the usual `APP_VERSION` / `CACHE_VERSION` bump.
