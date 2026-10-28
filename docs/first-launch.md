# First launch (cold start) speed

"First launch" = the app opened with nothing cached yet: a new phone, "Add to Home Screen", cleared site data, or a reinstalled PWA. After that the service worker serves the app from Cache Storage and a launch takes about a second (measured, warm: 1.0-1.4 s on the test rig below).

## What was slow (found 2026-10-25, fixed in 1.417.0)
1. **The boot modules were fetched one network round trip at a time.** `bootGate.js` imports 12 modules one after another, and each module's own imports are only discovered after it arrives and is parsed. About 40 modules in a chain: on a slow phone link the login screen came 4-5 s after the HTML, with a blank white screen the whole time.
2. **Two sequential API calls before the first screen**: `/api/lockdown`, then `/api/me`.
3. **Nothing was painted** until the JavaScript had built the first screen (first paint = 6 s on the rig).

## What changed
- `server/src/system/modulePreload.js` reads `bootGate.js` and follows the static `import`s, once at start-up, and `index.html` gets one `<link rel="modulepreload">` per module (39 files, about 215 KB compressed). The browser now fetches them all in parallel from the first byte. Nothing is evaluated earlier, so the module order is unchanged. New modules imported by a boot module are picked up automatically; nothing to maintain.
- `app.js` starts `/api/me` together with `/api/lockdown`. Lockdown still decides first.
- `index.html` has a tiny inline spinner (`.boot-splash`) that disappears as soon as anything else is rendered into `#app`.
- Calculator Mode: neither the preload hints nor the spinner are emitted (the mode promises that nothing of the real app is fetched or shown before the unlock code). Covered by `test/integration/bootPreload.test.js`.

## How it was measured
A throttled HTTP/2 front (like nginx on the droplet): 150 ms latency, 1.6 Mbit/s shared by all requests (the service worker's downloads included), Chromium with CPU slowed 4x (a 3 GB Android phone), fresh browser context, `NODE_ENV=production` server. Cold launch to a usable login form: **6.2-6.7 s before, 1.7-2.2 s after**; launch to Home data painted after login: 7.8-8.5 s before, 2.9-3.4 s after.

## Also done in 1.420.0
- The texts are split into `i18n-en.js` / `i18n-hy.js`; a device downloads and parses only its own language (about 0.2-0.4 s less on the rig). `theme-init.js` starts that download before `i18n.js` even runs; `setLang` is now `async` (loads the other language first). Parity of the two files is a CI test.

## 1.422.0: "5 seconds, white screen" on the iPhone (every launch, not only the first)
Found 2026-10-26 with the same rig (600 kbit/s, 250 ms, CPU 4x), service worker already installed:
- On **every** launch the service worker re-downloaded the whole app in the background (about 110 requests, 680 KB) and wrote each file into a second cache. Those copies were never served (the precache is found first), so the work only competed with the screens' own requests and kept the worker busy while the app started.
- It got worse with each launch in a row, because the previous launch's downloads were still running: first paint 0.5 s -> 2.1 s -> 3.4 s, header + tab bar 2.0 s -> 3.0 s -> 4.1 s.
- Fix: files in `APP_SHELL` are served from the versioned precache and not re-fetched; only files outside it keep the cache-then-revalidate behaviour. `theme-init.js` and `kad-wordmark.png` were missing from `APP_SHELL` and are added. Per launch the worker now makes 1 request (the start page, 3 KB). Measured: first paint 0.25 s, header + tab bar 0.8-1.2 s on the same link.
- Consequence: an app file only changes when a release ships a new `CACHE_VERSION` (CLAUDE.md rule). A deploy that forgets it would leave phones on the old files.
- Settings > About > Launch speed (`launchTiming.js`) keeps the last 8 launches on the device: white screen (first paint), app ready, worker start, page reply. Use it to judge a slow start on the real phone.

## Not done (ideas, see `.claude/skills/KADDev/references/optimization-ideas.md`)
- Cache the rest of the app shell after the first screen instead of in the service worker's install step (about 190 files, about 1 MB compressed) so it never competes with the first taps on a slow link.
- Trim `styles.css` (438 KB raw, 51 KB compressed; it is render-blocking).
