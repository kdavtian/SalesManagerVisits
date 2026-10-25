# First launch (cold start) speed

"First launch" = the app opened with nothing cached yet: a new phone, "Add to Home Screen", cleared site data, or a reinstalled PWA. After that the service worker serves the app from Cache Storage and a launch takes about a second (measured, warm: 1.0-1.4 s on the test rig below).

## What was slow (found 2026-10-25, fixed in 1.417.0)
1. **The boot modules were fetched one network round trip at a time.** `bootGate.js` imports 12 modules one after another, and each module's own imports are only discovered after it arrives and is parsed. About 40 modules in a chain: on a slow phone link the login screen came 4-5 s after the HTML, with a blank white screen the whole time.
2. **Two sequential API calls before the first screen**: `/api/lockdown`, then `/api/me`.
3. **Nothing was painted** until the JavaScript had built the first screen (first paint = 6 s on the rig).

## What changed
- `server/src/modulePreload.js` reads `bootGate.js` and follows the static `import`s, once at start-up, and `index.html` gets one `<link rel="modulepreload">` per module (39 files, about 215 KB compressed). The browser now fetches them all in parallel from the first byte. Nothing is evaluated earlier, so the module order is unchanged. New modules imported by a boot module are picked up automatically; nothing to maintain.
- `app.js` starts `/api/me` together with `/api/lockdown`. Lockdown still decides first.
- `index.html` has a tiny inline spinner (`.boot-splash`) that disappears as soon as anything else is rendered into `#app`.
- Calculator Mode: neither the preload hints nor the spinner are emitted (the mode promises that nothing of the real app is fetched or shown before the unlock code). Covered by `test/integration/bootPreload.test.js`.

## How it was measured
A throttled HTTP/2 front (like nginx on the droplet): 150 ms latency, 1.6 Mbit/s shared by all requests (the service worker's downloads included), Chromium with CPU slowed 4x (a 3 GB Android phone), fresh browser context, `NODE_ENV=production` server. Cold launch to a usable login form: **6.2-6.7 s before, 1.7-2.2 s after**; launch to Home data painted after login: 7.8-8.5 s before, 2.9-3.4 s after.

## Not done (ideas, see `.claude/skills/KADDev/references/optimization-ideas.md`)
- Load only the active language of `i18n.js` (444 KB raw, 116 KB compressed, both languages in one file).
- Cache the rest of the app shell after the first screen instead of in the service worker's install step (about 190 files, about 1 MB compressed) so it never competes with the first taps on a slow link.
- Trim `styles.css` (438 KB raw, 51 KB compressed; it is render-blocking).
