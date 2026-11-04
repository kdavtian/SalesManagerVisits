# The KAD App Standard - how every KAD app is built (owner, 2026-11-04)

Owner: "I want KADDev to include all the fixes and improvements as a standard, so that when I create a new app it already has all the
required standards, features, fixes and techniques developed in KAD OS and KAD Motors. Get the best global practice and edge technologies."

This file is the **bar**. A new KAD app starts here (section 14 is the ordered bootstrap), an existing app is measured against it, and a
change that falls below it needs the owner's yes. Every line names where the reference implementation lives:
**FV** = Field Visits (`kdavtian/SalesManagerVisits`), **OS** = KAD OS (`kdavtian/kad-gmm`). Copy from there, do not reinvent.
Goal behind all of it: **user friendly, fast, fluent** - any screen in <= 2 taps, Back does what the thumb expects, no waiting on a tab switch,
works offline, never loses a write, looks native on iPhone, Android and a Windows desktop.

## 0. How to use this file
- New app: follow section 14 top to bottom, then tick section 15 before the first release.
- New feature in an existing app: read the sections it touches (navigation 4, speed 5, offline 6, security 7, UI 8) and run `kad-edit`.
- The parts both apps share are a **kit** (section 4.1): identical files in every app. Improve the kit once, copy it everywhere.
- When an edge technology below is not in a browser yet: feature-detect, keep the old path, never break the phone that lacks it.

## 1. Product rules (the owner's taste, distilled)
1. Armenian (`hy`) is the main language, English (`en`) always complete; no fallback language on a device (every key in both, a test enforces it).
2. Compact, iOS-native feel: bottom sheets with a fixed action bar, wheel date pickers, segmented tabs, a small "!" for secondary text (never a
   paragraph under the content), short bullet lines "label: value" instead of long sentences.
3. One pattern everywhere: same icon = same feature (icon registry), one tri-state accordion sheet for every hierarchical multi-select filter,
   every search bar has an "x", tap a column header to reverse the sort, the same list pattern (status tabs, people pills, combined search,
   grouped rows) on every list screen.
4. Money: AMD, whole numbers, thousands separators, right-aligned, on one line. Dates: Yerevan time zone, Monday-start weeks, "this week /
   month" = calendar period. Names are never keys (customers by card / customer id, products by product key).
5. The owner judges by what they SEE on a phone: no overlaps, no cut-off Armenian labels at 320 px, 44 px touch targets, thin focus outline
   only, no stickiness on cards, no loading flash on a tab switch, no `confirm()` / `prompt()` where the action can be undone (undo instead).
6. Data -> decision -> action: every number on a screen names the decision it supports, who acts, and how we see it happened.
7. Desktop (Windows) is a first-class device: wide tables, side-by-side panels, keyboard shortcuts; the phone stays fully usable.
8. Screens never rotate on phones (portrait lock + CSS fallback); the page itself never zooms (pinch/double-tap blocked, a stray zoom snaps back).

## 2. Stack (no surprises, no framework churn)
| Part | Standard | Reference |
|---|---|---|
| Server | Node 22 LTS, Express 5, ES modules, plain `pg` (no ORM), one route file per resource, business folders `src/<area>/` | FV `server/src/*`, OS `server/src/routes` + `lib` |
| DB | Postgres 16, own volume; plain SQL migrations `server/migrations/NNN_name.sql`, applied by `npm run migrate`, NEVER on start; add, never drop/rename in the same release | both |
| Client | vanilla JS ES modules, no framework, no build step for the source; one file per screen `js/views/*.js`, dynamic import; files <= 800 lines | both |
| Bundling | esbuild only at deploy (Docker stage), the source stays file-per-module for local runs and tests | FV `server/scripts/build-client.mjs` |
| PWA | `sw.js` with APP_SHELL + network-first API, manifest with shortcuts, installable, update banner | both |
| Hosting | DigitalOcean droplet, docker compose (`app` + `db`), nginx + Let's Encrypt, app on 127.0.0.1:<port> | both |
| Checks | node:test (unit + integration on real Postgres), Playwright (e2e smoke, screenshots), ESLint errors-only + import checker | both |
Why this stack: one person maintains several apps; zero build complexity, fast cold start, every file readable on a phone, years without
framework migrations. A new dependency needs a reason in the PR (size, maintenance, CVE history).

## 3. Repo layout and files to copy into a new app
```
client/public/        index.html, sw.js, manifest.webmanifest, css/, icons/, brand/
  js/app.js           router + shell (tab bar, top bar, sidebar)       FV js/app.js + js/shell/*, OS js/app.js + js/nav.js
  js/kit/             THE SHARED KIT (section 4.1) - copy unchanged    FV/OS js/kit/
  js/api.js           every fetch, CSRF header, timeouts, prefetch     OS js/api.js, FV js/api/core.js
  js/state.js         session, caps, view state                        both
  js/i18n.js + i18n/  hy + en, texts per area loaded in parts          FV js/i18n/*, OS js/i18n/*
  js/util.js          formatAmd, dates (Yerevan), html escaping        both
  js/icons.js         lucide-style icon registry                       both
  js/listCache.js     stale-while-revalidate in IndexedDB              both
  js/offlineQueue.js  IndexedDB write queue, idempotent client_ref     FV offlineQueue.js, OS outbox.js
  js/ui/sheet.js      bottom sheet / dialog with fixed action bar      OS ui/sheet.js
  js/ui/press.js      tap feedback + busy spinner on writes            OS ui/press.js
  js/ui/shortcuts.js  keyboard (physical keys, Armenian layout safe)   OS ui/shortcuts.js
  js/ui/layoutGuard.js overlap / cut-off text detector                 OS ui/layoutGuard.js
  js/updater.js       update banner + dirty-form check                 OS updater.js, FV updateBanner.js
  js/views/*.js       one per screen
server/src/           index.js, db.js, auth (cookie JWT + CSRF), roles.js, jobs/, routes/, lib/
server/migrations/    NNN_*.sql
server/test/          unit/, integration/, architecture.test.js, e2e/
scripts/              check-kit.mjs, local-ci.sh
deploy/               deploy.sh, rollback.sh, backup*.sh, nginx-*.conf
docs/                 SPEC.md, ARCHITECTURE.md, ROADMAP.md, deploy.md
.claude/skills/       kad-edit (+ the app's own domain skill)
CLAUDE.md             the app's rules (copy OS CLAUDE.md, change names)
```

## 4. Navigation standard (the "One KAD navigation model", 2026-11-04)
The shell is the same in every KAD app, so a person who works in two apps never has to think where things are.
1. **Top bar, same order everywhere**: brand · Search · bell (count) · ☰ More (count). ☰ ALWAYS opens the More sheet; Settings / account sit
   at the bottom of More, never behind ☰ directly.
2. **Bottom tab bar (phone)**: 5 slots; the centre one is the big round MAIN ACTION of the job (Map / check-in for reps, New sale for a shop);
   role-specific apps (warehouse, driver) get their own tabs and every other address sends them Home (FV `opsShell.js`). Tabs and menu are
   filtered by capability; the server enforces the same.
3. **More sheet = the desktop sidebar on a phone**: the same sections/groups in the same order (FV `SIDEBAR_GROUPS`, OS `SECTIONS`), each row
   with its count and a pin toggle.
4. **Pinned screens**: each person pins up to 4 screens; shown as a row at the top of Home and of the sidebar; stored per user on the server
   (follows the person to every device); ids validated against what the role may open.
5. **Back is predictable**: Back closes the top sheet first (kit `sheetBack`), then steps back INSIDE the current tab. Tab taps (tab bar,
   sidebar, More, G+letter) REPLACE history; drill-downs push. A deep link with no history falls back to a sensible parent (`goBack(fallback)`).
   A screen change closes every sheet so none floats over another screen.
6. **Each tab keeps its place**: its stack of pages, scroll, filters and search survive a tab switch (FV `shell/tabs.js` trails, OS keep-alive
   views); memory is capped on small phones (LRU, `navigator.deviceMemory`); a kept screen refreshes itself on return (`onRestore` / `activate`).
7. **Same gestures**: tap the active tab = scroll to top, tap twice within 1 s = refresh; swipe a sheet down to close (kit `sheetSwipe`);
   left-edge swipe = back; status-bar tap = top (iPhone, opt-in).
8. **Every record has an address** (`#/customers/<card>`, `#/orders/<id>`, `#/sales/<id>`): a notification, a Telegram bot message or a shared
   link opens exactly that record (as a page or as a sheet over its list); Back closes it. Addresses never carry private data.
9. **One search for everything**: Search icon (phone) and Ctrl/Cmd+K (desktop; "/" keeps focusing the screen's own box) open one palette:
   screens, actions ("New sale") and records, recently opened first, Armenian/Latin spelling both match (kit `palette` + the app's search key).
   One server route `/api/search` returns only what the role may see.
10. **Reopen where you left**: launching from the icon restores the last screen, its scroll and list filters (same user, within 12 h), never
    a half-finished flow (new order, check-in) (FV `viewMemory.js`, OS `savePlace`).
11. **Long-press app icon shortcuts** (manifest `shortcuts`): the 3 most frequent actions of the job.
12. **Desktop**: sidebar with foldable groups (icons-only below 1280 px), a record opens DOCKED beside its list at >= 1400 px (FV
    `dockSheet.js`), keyboard: `?` help, `/` search, Ctrl K palette, N = new, G + letter = go to, Esc = close, all on physical keys
    (`event.code`, works on the Armenian layout).

### 4.1 The KAD kit (`client/public/js/kit/`, identical in every app)
| File | Gives |
|---|---|
| `sheetBack.js` | Back closes the top sheet (history step per sheet, MutationObserver, Navigation API aware, locked sheets stay, parked sheets adopt their step) |
| `sheetSwipe.js` | pull a bottom sheet down to close; springs back; respects inner scroll and reduced motion |
| `transition.js` | View Transitions fade (~140 ms) around the synchronous swap only; none on Back/Forward, reduced motion, power saving |
| `navType.js` | Navigation API: was it Back/Forward or a tap (null when unknown) |
| `navTiming.js` | tap-to-screen time per route + slow interactions (Event Timing / INP), batched to `/api/perf/nav` |
| `palette.js` | ranking (prefix > word start > inside > initials) + recent list for the one search |
| `version.js`, `kit.lock.json`, `README.md` | `KIT_VERSION`; `node scripts/check-kit.mjs` in CI fails when a kit file changed without the lock |
Rules: change it in one app -> copy to all, bump `KIT_VERSION`, `node scripts/check-kit.mjs --write` in each; install `installSheetBack`
before the app's own popstate listener; kit files in APP_SHELL; the kit CSS (README rule 4) in the app's stylesheet.

## 5. Speed standard (measured, not hoped)
Budgets (3 GB Android + iPhone, installed app, from kit `navTiming` / launch timing):
| What | Budget |
|---|---|
| Tab switch to a kept tab | < 100 ms |
| Tap a row -> record on screen | < 300 ms (data prefetched on touch) |
| Cold start to the first screen with data (4G) | < 1.5 s; white screen < 0.5 s |
| Slowest interaction (INP, p75) | < 200 ms |
| First-screen download (compressed) | <= 115 KB (OS `verify:ui`) |
| Server time per screen | budget per route in `npm run bench` (OS), EXPLAIN ANALYZE before/after (FV) |
Techniques (all already in FV/OS; a new app gets all of them):
1. Code per screen (dynamic import), the main tabs + Settings preloaded in idle time (`requestIdleCallback` with a Safari fallback), skipped on
   Data Saver; texts and styles loaded per area, every wait capped at 4 s (a stuck file never blocks a screen).
2. Data: stale-while-revalidate list cache in IndexedDB (instant paint, quiet refresh); GET dedupe; prefetch on `pointerdown` (single-use, few
   seconds); ONE "pulse" request per minute for every badge (never one request per badge).
3. DOM: lists react in place (a tap changes only that row and the totals), never a full redraw; long lists `content-visibility: auto`; no
   page-wide MutationObserver with subtree; break long tasks (`scheduler.yield()` where available, `setTimeout` fallback).
4. Cache Storage holds only the app files (each entry costs launch time on iPhone Safari); bulk data (map tiles, photos) goes to IndexedDB.
5. Images: small copy first, screen copy next, original only on zoom (FV `zoomStage.js`); `loading="lazy"`, `decoding="async"`, explicit sizes.
6. Server: indexes for every list filter, pagination by key, gzip/brotli in nginx, `Cache-Control: immutable` for versioned files, short JSON.
7. Never block a screen on a slow external service (background job + progress, not a skeleton forever).
8. Measure every change that could cost speed (seed thousands of rows; `bench`; before/after numbers in the summary).

## 6. Offline, updates and data safety
1. `sw.js`: APP_SHELL precache (every client file listed; a test checks), network-first for `/api/*` with a short cache for GETs, the app
   files cache-first; `CACHE_VERSION` + `APP_VERSION` bumped on EVERY client change (`npm run check:version`).
2. Updates: a banner ("new version - update"), never a reload under an open form (dirty-form check), reload loops capped (3 / minute), a
   pending update applied on the next screen change (FV `updateBanner.js`, OS `updater.js`).
3. Writes offline: IndexedDB queue with an idempotent `client_ref` (the server ignores a repeat), replay on `online` and after login, a visible
   count ("3 waiting to send") with a sheet listing them; a 401 stops the replay without deleting work.
4. Never lose data: backward-compatible migrations, `deploy/rollback.sh` can run the previous code on the new schema, daily ENCRYPTED backup
   to a SEPARATE Telegram group through its own bot, restore tested (`backup-restore-test.sh`).

## 7. Security standard
1. Auth: httpOnly cookie session (JWT) + CSRF double-submit, `token_version` (logout everywhere), lockout after failed logins, rate limits
   (bypass only for tests via `E2E_RATE_LIMIT_BYPASS_TOKEN`), helmet with a strict CSP (no inline scripts), HTTPS only.
2. RBAC on the SERVER: capabilities in ONE `roles.js` (shared with the client for hiding buttons) + unit test + RBAC matrix test; every route
   `requireAuth` + capability; an architecture test fails on a route without them; a person never reads another person's data by changing an id.
3. Integration tokens scoped to their routes; the bot uses its own sync key; tokens rotate.
4. Secrets: never in the repo, chat, docs, skills, screenshots or commits; `data/` gitignored; no `.xlsx`, exports, phones, salaries, dumps.
   A pasted secret = tell the owner to rotate it.
5. Privacy: addresses, logs and timings carry no customer data (ids only, routes with `:id`); errors reported to the CEO's bell without PII.
6. Edge: passkeys (WebAuthn) as an optional second login method on phones that have them (watch list, section 13).

## 8. UI standard (components every app has)
- Bottom sheet (`ui/sheet.js`): grab handle that drags, title, x, scrollable body, fixed action bar, error line above the buttons that
  shakes, Esc closes, focus returns, locked variant for questions that must be answered; desktop = centred dialog or docked panel.
- Tap feedback on every control (`ui/press.js`) and a spinner on a button whose write is in flight (double taps ignored).
- Wheel date picker, period buttons (this week / month, Monday start), month stepper.
- Tri-state accordion picker for hierarchical filters (FV `regionTree.js`).
- Data view: one column definition -> table on wide screens, compact list on phones, tap-to-reverse headers, row actions (OS `ui/dataview.js`).
- Info mark "!" with the explanation; toast for "saved"; undo instead of confirm.
- Amount input with live thousands separators and select-on-focus (OS `data-amd`).
- Layout guard that finds and fixes overlaps / cut-off text in development (OS `ui/layoutGuard.js`).
- Theme: light + dark (system default + manual), tokens in CSS custom properties; `prefers-reduced-motion` honoured everywhere.
- Accessibility: `aria-current` on the active tab, labels on icon buttons, dialogs `role="dialog"` + `aria-modal`, visible thin focus ring.

## 9. Domain and data conventions
- Excel / the source system stays the trusted source until cutover; imported totals reconcile to it (an acceptance test per total).
- Match by stable ids (customer id / card, product key), never by name; whole AMD; Yerevan dates; idempotent writes.
- Background work = a job in the scheduler (`{ name, everyMs, run }`), claimed in a table so it runs once with two servers, visible in system
  health; never a stray `setInterval` (FV `server/src/jobs`).
- Notifications: one registry of types; push (web push, VAPID) optional per person; every message is short bullet lines.

## 10. Quality gates (CI and before "done")
1. CI jobs named `test` and `e2e-smoke` (required), a `changes` job that skips slow jobs for docs-only changes; one local command
   `bash scripts/local-ci.sh` runs the same in parallel.
2. Checks: `npm test` (unit + integration, real Postgres, test users `itest-*` cleaned up, no posted money left behind), `npm run lint`,
   `verify:ui` (i18n parity, CSP, APP_SHELL, modulepreload), `check:version`, `check-kit`, architecture test (routes have auth, roles only in
   roles.js, files <= 800 lines, layers point one way, no page-wide observers), Playwright e2e smoke (desktop + phone), screenshot comparison
   for refactors (`shots:base` / `shots`), speed bench.
3. The QA gate (kad-edit diff pass): iPhone Safari PWA, Android Chrome, Windows desktop; 320/390/440/1440 px; hy + en; light + dark; offline;
   slow network; RBAC as admin AND the target role; screenshots you actually looked at.
4. Never skip, disable or weaken a test to get green.

## 11. Observability
- Client errors reach the CEO / super admin's bell (OS `errorReport.js`, FV `errorMonitoring.js`), deduplicated, no PII.
- Launch timing + kit `navTiming`: "Slowest screens" (p50 / p75 / p95, last 7 days) on the usage / control screen; act on the top 5.
- System health page: jobs (last run, failures), sync attempts, backup age, version on the server.
- A failed sync or backup notifies once per error per 6 h, never spams.

## 12. Ops standard
- Droplet `/opt/<app>`, docker compose `app` + `db`, nginx + Let's Encrypt, own host name; never touch another app's folder.
- The owner deploys with ONE ready-to-copy block: `cd /opt/<app> && bash deploy/deploy.sh` (says whether migrations are included; no
  placeholders, no angle brackets, short expected output); a fast path for client-only changes (30-60 s); `deploy/rollback.sh`.
- Branch -> draft PR (template headings) -> CI green -> squash-merge -> restart the branch from `origin/main`. Always merge when done.
- Every summary: what changed (numbered like the request) / next steps / deploy block / versions (+ optimization ideas).

## 13. Edge technologies: adopted, and the watch list
Always feature-detect; the old path stays for phones without it.
| Technology | Status in KAD apps | Support (check before relying) |
|---|---|---|
| View Transitions API (same-document) | ADOPTED (kit `transition.js`) | Chrome/Edge 111+, Safari 18+; others: instant swap |
| Navigation API | ADOPTED for Back/Forward detection (kit `navType.js`) | Chromium; newest Safari/Firefox - fallback heuristic |
| Event Timing / INP | ADOPTED (kit `navTiming.js`) | Chromium; Safari sends screen timings only |
| Web app manifest `shortcuts` | ADOPTED | Android, Windows/Chrome; iPhone ignores safely |
| IndexedDB caches + offline queue | ADOPTED | all |
| Web Push (VAPID) | ADOPTED (opt-in) | Android, desktop, iPhone 16.4+ installed app |
| Badging API (`navigator.setAppBadge`) | NEXT: the unread count on the app icon | iPhone 16.4+ installed, Chrome/Edge desktop |
| CloseWatcher | NEXT: Android Back for sheets without a history step | Chrome 120+ (sheetBack keeps the history path) |
| Popover API / `<dialog>` + `@starting-style` | NEXT for small menus and enter animations | Baseline 2024 (Safari 17.5+) |
| CSS container queries, `:has()`, nesting | USE in new CSS (cards that adapt to their column) | Baseline 2023 |
| `content-visibility: auto` | USE on long lists | Chrome, Safari 18+ |
| `scheduler.yield()` | USE in long loops, `setTimeout` fallback | Chromium |
| Passkeys (WebAuthn) | WATCH: optional phone login | all modern |
| Web Share / Share Target | WATCH: send a PDF / price list to WhatsApp, receive photos | Android/iPhone (share), Android (target) |
| Speculation Rules | NOT for these apps (hash SPA; helps multi-page sites only) | Chromium |
| A framework (React, Vue, ...) or a client build step for the source | NOT without the owner's yes (section 2) | - |

## 14. New KAD app - bootstrap, in this order
1. Owner brief -> `docs/SPEC.md` (who uses it, the 5 jobs per role, the main action for the centre tab, the trusted data source, acceptance
   numbers). Ask the owner short concrete questions first (KADDev rule 7); policy decisions are theirs.
2. Repo from the layout in section 3; copy `CLAUDE.md` (OS), `kad-edit`, CI workflow, `scripts/local-ci.sh`, `scripts/check-kit.mjs`, the
   eslint config + import checker, architecture test, `deploy/*`.
3. Server skeleton: Express 5 + helmet CSP + cookie JWT + CSRF + rate limits + lockout + `roles.js` with capabilities + unit test; migrations
   001 users/sessions; `requireAuth` / `requireCap`; health route; job scheduler.
4. Client shell: copy the kit unchanged; `app.js` router with tab roots (replace) vs drill-downs (push), keep-alive views with LRU, top bar
   (brand / Search / bell / ☰ More), bottom tabs with the centre action, sidebar groups = More sections, pinned row, palette, re-tap = top,
   update banner, offline bar, outbox bar.
5. i18n hy + en with parity test; icons registry; util (AMD, Yerevan dates); theme light/dark; portrait lock; zoom lock.
6. Data layer: `api.js` (CSRF, timeouts, GET dedupe, prefetch), `listCache.js`, `offlineQueue.js` with `client_ref`.
7. `sw.js` + manifest (icons, shortcuts, `display: standalone`, theme colours) + `index.html` modulepreload for the first screen.
8. Observability: error reports to the bell, `/api/perf/nav` + slowest screens, system health.
9. Ops: Dockerfile, compose, nginx conf, deploy/rollback, encrypted Telegram backup with its own bot (mandatory before real data).
10. Tests: RBAC matrix, i18n parity, architecture, e2e smoke (login, every tab, Back closes a sheet, offline write replays), screenshots.
11. First screens from the SPEC; every one passes the QA gate (section 10.3) and the speed budgets (section 5).
12. Tell the owner the install / deploy block, what to check on the iPhone, and the version.

## 15. Release checklist (tick every item; copy into the PR when it is a new app or a new shell feature)
- [ ] Back closes a sheet and stays; Back never jumps tabs; deep link + Back goes to a sensible parent
- [ ] Re-tap tab = top, twice = refresh; swipe-down closes sheets; left-edge back works
- [ ] Search finds a screen, an action and a record (hy and Latin spelling); recent items shown
- [ ] More sheet = sidebar groups; Settings at the bottom; pins saved on the server and validated
- [ ] Every record has an address; a notification opens it
- [ ] Tab switch < 100 ms, record < 300 ms on a 3 GB Android; one pulse request for badges
- [ ] Offline: write queued, replayed once, visible count; update banner never reloads under a form
- [ ] RBAC on the server for every new route (admin AND target role tested)
- [ ] hy + en complete; 320 px Armenian wraps; 44 px targets; dark mode; reduced motion; thin focus
- [ ] APP_VERSION + CACHE_VERSION bumped; new files in APP_SHELL; kit lock matches; migrations backward compatible
- [ ] Deploy block ready (migrations yes/no), rollback known, backup works
