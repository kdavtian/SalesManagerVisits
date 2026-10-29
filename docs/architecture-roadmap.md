# Architecture and speed: findings and roadmap

Owner, 2026-10-28: "As a top code architect and senior developer analyze our code structure for everything. I want it to be very easy
developable, editable, everything arranged in appropriate modules so that changes pass without any problems and don't spoil the app.
And i want the app to be very fast." Then: "Save all these findings, recommendations etc and roadmap with detailed plan so that u can
follow it later."

This file is the plan to follow. The owner's readable copy is the doc "KAD apps: architecture and speed plan"
(https://claude.ai/artifact/TvBefkX1M1qjLz2xsYUHeZ), which has a Status column per step; keep both in step: tick the box here and set the
Status there when a step merges, and write the version and PR in the Done log at the end.

**Rules for every step** (on top of CLAUDE.md and the KADDev skill):
- One step = one PR (the large steps are split into the numbered releases listed under them). Nothing the user sees may change; a
  step that would change behaviour is wrong by definition: stop and ask.
- Run `bash scripts/local-ci.sh --e2e --no-audit` before every push. A step that moves files must also pass
  `server/test/e2e/idle-dom.spec.mjs` and `desktop-shots.spec.mjs`.
- Move first, change second: a release that moves code does not also rewrite it, so a reviewer (and `git log --follow`) can see the
  move is a pure move.
- Never start a later phase while an earlier step is half done, unless the owner says so.
- Until a step is done, NEW code already follows the target (section 4): a new rule goes into a module of its own (like
  `orderStock.js`, `cashSheets.js`), not inline in a route file; a new screen does not patch another screen's DOM.

## 1. Owner's decisions (open as of 2026-10-28)

Put these to the owner again, in full, until answered; record the answer and its date here.

1. **Script bundling at deploy (step 10).** A, recommended: bundle and minify at deploy only (esbuild inside the Docker build); the
   code, development and tests stay file-per-module as today. First start about 1.8 s instead of 3.4 s; deploy about 20 s longer;
   source maps kept so errors still name the real file. B: no bundling; steps 9 and 11 only; first start about 2.5 s; deploy unchanged.
   (Note: `server/src/system/modulePreload.js` already sends `<link rel="modulepreload">` for the boot graph, so preload hints are not a new
   lever; the remaining cost is the number of files and their unminified size.)
2. **Order of the phases.** Recommended: safety first (steps 1-4), then structure (5-8), then speed (9-12). Alternative: speed first.
3. **Pace.** Recommended: one release per working day next to feature requests (about 5 weeks). Alternative: a focused push with
   features paused (about 2 weeks).

Answers (owner, 2026-10-28): 1 = **A** (bundle at deploy, when step 10 comes); 2 = safety first, done as steps 1-4; 3 = no fixed pace:
the owner names the next steps each time ("I will tell what to implement"). Next named: section B, step 5.
Also answered: notification switches = **1A** (every kind in Settings, grouped, each role sees its own kinds; 1.460.0).

## 2. Findings (measured 2026-10-28)

### Verdict

| Area | KAD Motors today | Grade | Main risk |
| --- | --- | --- | --- |
| Tests | 823 server tests (157 files), 96 browser specs, all run on every PR in about 3 min | Good | none: keep |
| Code checker | none (no ESLint, no type checks; only `node --check` and `verify:ui`) | Weak | a wrong name is found only when a user opens that screen |
| Server structure | 118 files loose in `server/src/`; route files of 1,700+ lines; about 1,000 SQL queries inside route files | Weak | the one place a rule lives is hard to find; rules get copied |
| Phone app structure | 103 files loose in `client/public/js/`, 57 views; screens of 2,000-4,000 lines; 5 enhancer files | Weak | a change on one screen can break another |
| Role rules | server: `roles.js`; phone app: about 50 hand-written role lists in 18+ files | Medium | the UI and the server disagree |
| Background jobs | timers started in 13 different modules inside the web process | Medium | no single schedule; two server copies would double every job |
| First start | 3.4 s to Home on a cold slow phone; 116 files | Medium | slow first open for a new rep and after updates |
| Later starts, tab switches | instant (service worker, listCache, api GET cache) | Good | none: keep |
| KAD OS | folders by job (`lib`, `ui`, `views`, `routes`, `sync`, `importer`), files < 800 lines, a speed budget job in CI | Good | no code checker either |
| CEO bot | 9,400 lines of Python, `automation/ceo_agent.py` 3,731 lines | Medium | acceptable while it changes rarely |

### Baseline numbers (re-measure after each speed step and in step 12)

| Measure | KAD Motors | KAD OS |
| --- | --- | --- |
| Code lines (server / phone app JS / CSS) | 37,013 / 59,898 / 19,970 | 10,923 / 12,253 / 1,244 |
| Server files loose in `src/` / route files | 118 / 66 | (in folders) |
| Biggest files | `views/map.js` 4,073 lines 199 KB; `css/styles.css` 16,168 lines 471 KB (109 KB gz); `routes/orders.js` 1,778; `routes/customers.js` 1,724; `views/settings.js` 2,087; `views/admin.js` 2,060; `app.js` 1,909; `util.js` 1,582; `api.js` 914 | `views/sale.js` 771 |
| SQL calls inside route files | about 1,024 | about 288 |
| Page-wide `MutationObserver`s | 12 files | 0 |
| Cold first start (1.6 Mbit/s, 150 ms, CPU 4x, cache + service worker cleared, rep account) | 3.4 s to Home; 102 scripts 640 KB gz; 14 stylesheets 91 KB gz; 17 API calls | not measured |
| Render-blocking stylesheets / sync scripts in `index.html` | 11 / 4 | 1 / - |
| Armenian text file loaded before the first screen | 290 KB raw, 71 KB gz | one i18n.js 2,695 lines |
| Commits in the last 30 days | 135 (6 titled as fixes) | - |

How the cold start was measured (repeat it the same way): a Playwright spec that logs in, unregisters the service worker and clears
`caches`, opens a NEW page with CDP `Network.setCacheDisabled`, `Network.emulateNetworkConditions` (latency 150, down 1.6e6/8, up
750e3/8) and `Emulation.setCPUThrottlingRate` 4, goes to `/#/dashboard` and waits for `.quick-actions-grid`; counts responses via
`Network.loadingFinished.encodedDataLength`. Run with `NODE_ENV=production` (CSS minified as in production). Step 12 turns this into a
permanent CI budget.

### Problems (most important first)

1. **No automatic code checker.** Undefined names, wrong imports and dead code pass every test that does not open that exact path.
2. **Very large files doing many jobs.** `map.js` = map + filters + popups + side table + planning; `app.js` = router + shell + every
   badge + several sheets; `routes/orders.js` and `routes/customers.js` mix validation, business rules, SQL and notifications.
   Parallel work collides in them.
3. **SQL inside routes (about 1,000 calls).** The same idea is written several times. Where it was moved into one module
   (`orderStock.js`, `paymentExcelMatch.js`, `cashSheets.js`, `productWishes.js`) bugs stopped coming back.
4. **Flat folders.** 118 + 103 loose files, no grouping by business area.
5. **Screens patched from outside.** `fieldVisitEnhancements.js`, `unifiedSearchEnhancements.js`, `ordersSearchEnhancements.js`,
   `ordersRegionStatusEnhancements.js`, `mapMarkerEnhancements.js` (+ `mapDimensionFilterPlacement.js`, `customerPortfolioUi.js`,
   `customerSocialProfiles.js`) rewrite other screens after they render; 12 files hold page-wide `MutationObserver`s. Fragile and
   once froze phones (2026-10-17; guarded since by `idle-dom.spec.mjs`).
6. **Role rules copied into the phone app.** About 50 lists in: `vaghinak.js`, `tasks.js`, `state.js`, `returns.js`, `quickActions.js`,
   `potential.js`, `payments.js`, `orders.js`, `orderDetailSheet.js`, `opsControl.js`, `homeKpis.js`, `fuelReport.js`, `fileViewer.js`,
   `customerDetail.js`, `cashHandoffs.js` (`NEXT_HOP_ROLES`), `bonusChallengesAdmin.js`, `app.js`, `accounting.js`, and more (grep
   `["admin", "ceo"` and `new Set(["admin"`).
7. **Background jobs scattered.** `setInterval` in `bonusReconciliation.js`, `bonusChallengeWorker.js`, `app.js`, `vaghinak/engine.js`,
   `overdueReminders.js`, `opsJobs.js`, `dailySummary.js`, `erpSyncMonitor.js`, `taskReminders.js`, `antiFraud.js`,
   `stalePackedReminder.js`, `routes/bonusChallenges.js`, `expenseWatch.js`.
8. **Heavy first start.** 102 scripts + 14 stylesheets fetched separately (11 stylesheets block the first paint), scripts unminified,
   `styles.css` 471 KB in one file, the whole Armenian text file before the first screen.
9. **Shared files every change touches.** `api.js`, `i18n-en.js`/`i18n-hy.js`, `styles.css`, `sw.js` change in almost every release;
   parallel sessions collide there (KAD OS PR #90 vs #92 on versions, 2026-10-28).

### What to keep (do not "improve" these away)

- The no-framework, no-build development model (plain ES modules, plain SQL migrations): fast to change, nothing to upgrade.
- The test suite layout, `isolated-tests.txt`, `local-ci.sh`, the docs-only fast path in CI.
- Back-cache screens, `listCache.js`, the api GET cache, the offline queue, the service worker update flow.
- Shared modules that already hold one rule each (`orderStock.js`, `paymentExcelMatch.js`, `cashSheets.js`, `productWishes.js`,
  `opsTasks.js`, `roles.js`): they are the pattern for step 5.

## 3. Roadmap

Twelve steps, three phases, about 24 releases. Size = number of releases.

### Phase A - safety (so the later moves cannot break anything unnoticed)

#### Step 1. Code checker (ESLint) - size 1
- [x] Add `eslint` (flat config `eslint.config.mjs` at the repo root) as a dev dependency of `server/`; two configs: Node for
      `server/src`, `server/scripts`, `server/test`; browser ES modules for `client/public/js` (globals: window, document, navigator,
      L for Leaflet, etc.).
- [x] Rules, errors only (no style rules, no reformatting): `no-undef`, `no-unused-vars` (args: none, ignore `_`), `no-dupe-keys`,
      `no-unreachable`, `no-redeclare`, `no-self-assign`, `no-dupe-else-if`, `import/no-unresolved` + `import/named` via
      `eslint-plugin-import` (catches a wrong import name or path).
- [x] Fix every finding in the same PR (expect dead variables; each real bug found is listed in the PR body).
- [x] `npm run lint` in `server/package.json`; added to the CI `static` job and to `scripts/local-ci.sh`.
- Done when: CI fails on a deliberately undefined name in a view (prove it once in the PR, then remove it).
- As built (1.456.0): ESLint 10 with `server/eslint.config.mjs` (run from the repo root); instead of `eslint-plugin-import` (not ready for
  ESLint 10) the import rules are `server/scripts/check-imports.mjs` (espree: every relative import, re-export and literal dynamic
  import resolves to a file that exports each imported name). `npm run lint` runs both. First run: 1 real bug (the wide customer
  card's Files panel used a date helper it never imported, so the panel failed on a computer), 13 duplicate text keys per language
  (the later value was the one shown; the dead earlier ones removed), 59 unused names (dead code removed).

#### Step 2. Architecture checks - size 1
- [x] New `server/test/architecture.test.js` (plain node:test, no server needed). Checks:
  - every `server/src/routes/*.js` router uses `requireAuth` or is on an explicit public allowlist (login, health, erp-sync with
    sync key, integration with bearer token, partner, client-errors);
  - no file under `client/public/js/views/` imports `../app.js` (today: 2 do; move what they need into a small module first);
  - every client module reachable from `bootGate.js` or a view is listed in `sw.js` `APP_SHELL` (today checked partly by
    `verify:ui`; make it complete);
  - after step 5 starts: no NEW `.js` file directly in `server/src/` (allowlist = the files present at that moment, shrinking);
  - every `notifyUser(..., "<type>")` type is in `NOTIFICATION_TYPES` with both i18n keys.
- Done when: each check fails on a deliberate violation (prove in the PR).
- As built (1.457.0): four checks. (1) Routes: the real Express route table is walked; a route counts as guarded when `requireAuth`,
  `requireSyncKey` or `requireIntegrationToken` (Lily's bearer check, now a named function) runs before it; 9 routes are public on
  purpose, each listed in `PUBLIC_ROUTES` with its reason. (2) No client module imports `app.js`: the Home and Money screens imported
  their badge painters from it; all badge code moved, unchanged, to `client/public/js/badges.js` (the first piece of step 6b).
  (3) Every file under `client/public/js` and `css` is in APP_SHELL, and every APP_SHELL file exists. (4) Every `notifyUser` type is in
  `NOTIFICATION_TYPES` (found: `document_issue`, the AI blank check, was missing, so its on/off preference was not stored against a
  known type; added), and every type the Settings screen offers has its label in both languages. The "no new loose server file" rule
  is added when step 5 starts.
- Finding for the owner (open question): Settings > Notifications offers switches for only 10 of the 31 notification types the
  server sends (the client list in `views/settings.js`); the other 21 (payments, warehouse, delivery, cash hand-over, fraud and expense
  alerts, sync, daily summary, wishes, document issues ...) cannot be switched off by a person or by the admin's role defaults.

#### Step 3. One role rule file for both sides - size 2
- Release 3a: serve `server/src/shared/roles.js` to the browser unchanged (`express.static` alias `/js/shared/roles.js`; it has no Node imports
  - verify; if it does, split the pure part into `server/src/shared/roles.js`). Add to `APP_SHELL`. Replace the client's role lists
  with calls to the same functions (`canConfirmOrders(role)`, `validHandoffRecipientRoles(role)`, ...). Start with `cashHandoffs.js`,
  `payments.js`, `orders.js`, `orderDetailSheet.js`, `tasks.js`.
- Release 3b: the remaining files from the problem-6 list; add an architecture check that fails on a new literal role array in
  `client/public/js` (allowlist only for role pickers that list every role).
- Done when: `grep -rn '\["admin", "ceo"' client/public/js` finds only the allowlisted pickers.
- As built (1.458.0, 3a + 3b in one release): the rule file is `client/public/js/shared/roles.js` (the browser can only load files under
  `client/public`); `server/src/shared/roles.js` re-exports it, so server imports did not change; `client/package.json` (`"type": "module"`)
  makes Node read it as a module on any Node version. `state.js` helpers and every screen list now call named rules; the server's own
  lists that had a twin in the app (operations control, Home numbers, place review, pin auto-approval, Vaghinak, anti-fraud, expenses,
  customer holders) moved into it too, as rules + `rolesWhere(rule)` where SQL needs a list. Rules only the screens need are in its
  "Screen rules" section. Architecture check 5 fails on a role list (or `role === "a" || role === "b"`) outside that file; allowed:
  the role pickers and the Home quick-action default roles. Every replaced list was compared role by role with the rule it now calls:
  identical, so nothing on screen changed. Notification recipient lists (`notificationPreferences.js`) stay where they are (who is told,
  not who may).
- Also fixed (found by the wider browser tests): an expired session on a phone that remembers the person showed "Cannot read
  properties of null (reading 'id')" instead of the login form, until a reload (the remembered Home's code arrived after the login
  form and painted over it). `app.js` renderRoute now drops a screen whose code arrives after a newer render started.

#### Step 4. One job scheduler - size 1
- [x] `server/src/jobs/index.js`: a registry `[{ name, every | at (Yerevan time), workingDaysOnly, run }]`, one `setInterval` tick
      (30 s) that runs what is due; each run takes `pg_try_advisory_lock(hashtext(name))` so a second server never runs it twice;
      writes `job_runs` (name, started_at, finished_at, ok, error) - migration.
- [x] Move the 13 timers into the registry one by one (same schedule as today; keep each job's own function).
- [x] Settings > Administration > System health: a "Background jobs" list (name, schedule, last run, ok/failed) for admin.
- [x] Tests: the scheduler runs a due job once, skips a locked one, records failures.
- Done when: `grep -rn setInterval server/src` finds only `jobs/index.js` (and the per-request rate limiter, if any).
- As built (1.459.0, migration 167): `server/src/jobs/scheduler.js` (one 15 s timer) + `jobs/index.js` (the list: 18 jobs from the 12
  modules, each at its old cadence; the four push-only ones are off without VAPID keys, as before). Instead of an advisory lock the claim
  is one `UPDATE background_jobs SET next_run_at = ... WHERE next_run_at <= now() RETURNING name`: only one server copy gets each turn,
  and the row keeps the last run, ok / error, duration, runs and failures. A job still running is not started again. A first start
  waits one interval (like setInterval); later starts keep the stored next run, so a deploy no longer pushes every job back. Settings >
  System health shows the "Background jobs" card (a failed job opens its error). Architecture check 6 fails on a `setInterval` outside
  the scheduler. Jobs that remember "already sent today" in memory (overdue visits, daily summary, stale packed, auto tasks) still do;
  with two server copies they would need that in the database (not needed with one).

### Phase B - structure (pure moves first, rewrites after; every release keeps behaviour identical)

#### Step 5. Server in business folders - size 6 (one area per release)
Target per area: `server/src/<area>/routes.js` (or several), `<area>/rules.js` (business rules, no SQL text, no `req`/`res`),
`<area>/queries.js` (all SQL for the area, named functions). Routes stay mounted at the same URLs.

| Release | Area folder | Moves in (current files) |
| --- | --- | --- |
| 5a | `shared/` | `roles.js`, `db/`, `notifications.js`, `notificationPreferences.js`, `push.js`, `telegram.js`, `upload.js`, `pdfPreview.js`, `phoneFormat.js`, `quietHours.js`, `workingDays.js`, `settings.js`, `documentTexts.js`, `utils/`, `middleware/` |
| 5b | `orders/` | routes `orders`, `orderMeta`, `returns`, `warehouse`, `delivery`, `appOrdersAdmin`, `partner`, `wishes`; `appOrders`, `orderStock`, `orderReturns`, `orderRhythm`, `orderBlankData`, `orderBlankPdf`, `signedActs`, `productWishes`, `discountPolicy`, `creditLimit`, `creditLimitSuggest`, `stalePackedReminder`, `accounting*`, `driverArrival`, `routePlanner`, `osrm` |
| 5c | `customers/` + `field/` | routes `customers`, `customerSocial`, `files`, `places`, `pinReview`, `geocode`, `checkins`, `visitPlans`, `routePlanSets`, `routeDistribution`, `locations`; `customerChannelPolicy`, `customerFiles`, `customerNameSuggest`, `customerReorder`, `potential`, `places`, `placeReviews`, `pinReview`, `registryLookup`, `salesChannelAutofill`, `checkinDelivery`, `visitCount`, `visitPriorities`, `routePlanSets`, `planScopes`, `repProgress` |
| 5d | `money/` | routes `payments`, `cashHandoffs`, `cashSheets`, `cashflow`, `cashExpenses`, `expenses`, `bankStatements`, `debtBalances`, `fuel`; `cashSheets`, `cashflow`, `bankStatement`, `paymentExcelMatch`, `debtAge`, `debtAging`, `debtCollectionTasks`, `debtDigest`, `debtStatementPdf`, `overdueReminders`, `expenseWatch`, `antiFraud`, `fuelReport`, `fuelRoute`, `payroll` |
| 5e | `products/` + `erp/` | routes `products`, `productDetails`, `productShortcuts`, `erpSync`, `integration`, `integrationAdmin`; `pricingService`, `tierPricing`, `landingCalc`, `pricelist*`, `productImport`, `priceSyncLog`, `stockForecast`, `erp*`, `syncNotifier`, `platformSync`, `integrationTokens` |
| 5f | `reports/` + `team/` + `bonus/` | routes `reports`, `bizReports`, `dashboard`, `sales`, `salesPerformance`, `teamPerformance`, `volumeReport`, `exports`, `tableExport`, `staff`, `users`, `tasks`, `opsControl`, `vaghinak`, `bonus*`; `reports`, `scorecard`, `perfCalc`, `perfRecommendations`, `dashboardKpis`, `volumeReport`, `dailySummary`, `opsJobs`, `opsReports`, `opsTasks`, `taskAutoComplete`, `taskReminders`, `bonus*`, `vaghinak/`, `askKad/` |

Each release: (1) `git mv` + import path updates only, full CI; (2) in the same area, the next release moves SQL out of the route
handlers into `queries.js` and repeated rules into `rules.js`, starting with the rules that exist in two or more places. The table is
the starting proposal: re-check each file's real callers (`grep -rn "from \".*<name>.js\""`) before moving; a file used by several
areas goes to `shared/`.
- Done when: `server/src/` holds only `index.js`, `app.js`, `seed.js` and the area folders; no route handler longer than about 60
  lines; the architecture check forbids new loose files.
- Phase 1 as built (1.461.0, one release instead of six: a tool moved the files and rewrote every import, the import check and the
  full test suite prove nothing broke): `server/src` = `index.js`, `app.js`, `seed.js` + folders `shared/` (roles, notifications,
  push, telegram, upload, settings, texts, `paths.js`), `system/` (login, lockdown, health, settings, badges, exports routes),
  `orders/`, `customers/`, `field/`, `money/`, `products/`, `erp/`, `reports/`, `team/` (tasks, staff, users, `vaghinak/`, `askKad/`),
  `bonus/`; each area's route files in `<area>/routes/`; `db/`, `middleware/`, `utils/`, `jobs/`, `data/` stay. Files that read
  other files by location now use `shared/paths.js` (SERVER_DIR, CLIENT_PUBLIC_DIR, ...), so a move cannot break them. Architecture
  check 7: only the three entry points at the top of `server/src`, route files only in `<area>/routes/`. Mentions of the old paths in
  comments, docs and the skill were rewritten too.
- Phase 2 (still open, one area per release, the owner picks the order): move each area's SQL out of its route handlers into
  `<area>/queries.js` and repeated business rules into `<area>/rules.js`, starting with the rules written in two or more places;
  biggest first: `orders/routes/orders.js` (1,778 lines), `customers/routes/customers.js` (1,724).

#### Step 6. Split the giant screens - size 4
- 6a `views/map.js` -> `views/map/` (`index.js` render + wiring, `filters.js`, `markers.js`, `popup.js`, `planning.js`, existing
  `mapSideTable.js`, `mapPrefs.js`, `leafletLoader.js` move in). Pure move; `desktop-map.spec.mjs` + map specs guard it.
- 6b `app.js` -> `shell/router.js` (routes table + dynamic imports), `shell/layout.js` (top bar, sidebar, more sheet),
  `shell/badges.js` (every apply*Badge), `app.js` stays the 50-line entry point.
- 6c `views/settings.js` -> `views/settings/` one file per page of `PAGES`; `views/admin.js` -> `views/admin/` one file per tab.
- 6d `views/reports.js` -> `views/reports/` one file per report group; `customerDetail.js` sections into `views/customer/`.
- Done when: no view file over about 800 lines.
- The tool (owner, 2026-10-28: "keep the move tool"): `server/scripts/refactor.mjs`, tested by `server/test/refactorTool.test.js`.
  It rewrites code with the parser, never by hand: `move` (files + every import), `extract-top` (top-level declarations),
  `extract-inner` (functions inside a big screen function; each takes the screen's state as `ctx`, getters / setters on the real
  variables, and a one-line wrapper with the same name stays behind; `-` instead of the screen function does the same for a module's
  top-level functions, used for app.js, which nothing may import), `wrap` (a range of statements -> an inner function called in the
  same place, refused when that could change behaviour), `prune-imports`. Relative module paths in moved code are rebased; multi-line
  template text is kept exactly. Each split: tool commands, then lint + architecture check + full CI with e2e + a screenshot.
- 6a as built (1.462.0): `views/map.js` 4,043 -> 1,608 lines; `views/map/` tiles, markers, filters, planning, search, location,
  addCustomer, template (91 functions + the markup). What is left in map.js is the screen's start-up wiring and its ctx list;
  going lower means turning the screen's variables into one state object (a rewrite, not a move; later, if wanted).
- 6b as built (1.463.0): `app.js` 1,538 -> 792 lines; `shell/routes.js` (renderRoute: which screen each #/hash opens),
  `shell/nav.js` (tab bar, top bar, sidebar), `shell/preload.js` (idle warming), `shell/syncBanner.js`; `badges.js` was already out
  (step 2). The route `if` chain stays as it was (a routes table would be a rewrite).
- 6c + 6d as built (1.464.0, one release): `views/settings.js` 2,098 -> 785 (`views/settings/` markup, adminRows, notifications,
  sheets, rows), `views/admin.js` 2,059 -> 636 (`views/admin/` team, products), `views/reports.js` 1,634 -> 495 (`views/reports/`
  common, debt, sales, money), `views/customerDetail.js` 1,511 -> 510 (`views/customer/` accountSettings, editSheet, files, erpCard,
  sheets). Checked beyond the tests: every multi-line template text and every `api.*` call of the four screens is the same before
  and after; a screen still exports what it exported (a caller's `import()` keeps working).
- Step 6 result: every split screen is under 800 lines except `views/map.js` (1,608, see 6a). Still over 800 and not split yet:
  `orderCreate.js` 1,170, `checkin.js` 1,126, `tasks.js` 1,104, `customers.js` 1,087, `teamPerformance.js` 914, `payments.js` 905,
  `warehouse.js` 847 (and outside views `util.js` 1,577, `orderDetailSheet.js` 929; `api.js` and the texts are step 8) - same
  tool, same checks, when the owner wants them.

#### Step 7. Fold the enhancers into their screens - size 2
- 7a `unifiedSearchEnhancements.js`, `ordersSearchEnhancements.js`, `ordersRegionStatusEnhancements.js`: their markup and handlers move
  into `activity.js` / `orders.js` / `customers.js` render functions; delete the observers.
- 7b `fieldVisitEnhancements.js`, `mapMarkerEnhancements.js`, `mapDimensionFilterPlacement.js`, `customerPortfolioUi.js`,
  `customerSocialProfiles.js`: same; `activityDatePicker.js` keeps one observer only if a view still needs it (better: views call
  its `enhanceInput` after rendering).
- Done when: `grep -rn "new MutationObserver" client/public/js` lists only `dockSheet.js`/`util.js` uses that watch their own element,
  and `idle-dom.spec.mjs` still passes.
- 7a as built (1.465.0): `ordersSearchEnhancements.js` and `ordersRegionStatusEnhancements.js` are gone and
  `unifiedSearchEnhancements.js` keeps only the Map's search row (folded in 7b with the other map enhancers). The shared pieces
  are `searchBar.js` (clear "x", inline "x", menu check mark, filter-button state); each screen (Activity, Tasks, Orders,
  Customers, Payments, Products, and the plain search boxes of order creation, special prices, warehouse, expenses, the order
  edit sheet and the customer pickers) calls its own bar code right after it renders. Orders' bar is `views/orders/searchBar.js`:
  the region filter no longer replaces `api.listOrders` for the whole app (Orders asks `/order-meta/list` itself), the status
  counts follow every repaint, and a race between two enhancers that drew a person icon on the sales-channel filter about half the
  time is gone. Proof: the final HTML of 9 screens with their menus open, in both languages, recorded before and after, is the
  same (`search-bars.spec.mjs` now guards it). Small observers that watch only their own menu (sort menus, filter rows) stay
  inside the screens' bar code; no page-wide one is left for these screens.
- 7b1 as built (1.466.0): the Map's bar is `views/map/searchBar.js` (status and icon filters inside the field, the compact
  popover of an icon filter, the clear "x", the selected-pin halo), called by `views/map.js` once its markup is wired; the halo
  now follows Leaflet's own popup open / close events instead of a page-wide observer. `unifiedSearchEnhancements.js`,
  `mapDimensionFilterPlacement.js`, `mapMarkerEnhancements.js` and `customerPortfolioUi.js` are gone: the rule that shows a
  customer with no channel as Potential and a competitor as COMPETITORS is now `normalizeCustomer` inside `api.js` (it used to
  replace four api methods from outside). Dead code dropped on the way: the old Map manager dropdown (nothing creates it since the
  manager filter became the "who" icon button), the competitor reveal for a "channel" button that no longer exists, and the
  Customers "subregion" button removal (Customers no longer draws one). Proof as in 7a: the Map (pins, icon filters open and
  closed, a pin chosen and its popup closed, the add flow's address search) and the customer list and cards (normal, potential,
  competitor), both languages, render the same before and after; `search-bars.spec.mjs` covers the Map bar and the halo.
- 7b2 as built (1.467.0): the last outside patchers are gone and `bootGate.js` loads only `app.js`.
  `fieldVisitEnhancements.js`: what it really changed was found by recording the screens with and without it (both languages,
  admin and sales manager); its three live effects are now in the screens: the new-customer form's business-name label
  (`new_customer_name`, "Անվանում"), a sales manager's channel preset from their position and hidden (`map/addCustomer.js`), and
  Armenian region names on the plan-day sheet's recurring tab (`map/planning.js`, regionLabelHy / subregionLabelHy); its version
  patch and its other region rewrites changed nothing any more. `activityDatePicker.js` stays as the picker module; Activity calls
  `enhanceDateRange` itself. `customerSocialProfiles.js` -> `views/customer/social.js` without its observer (the card already
  painted the links itself, so the observer never did anything). `competitorPolicySafe.js` (competitors never overdue, never in
  the overdue / not-visited queues, never on a visit plan) is inside `api.js`. `mapSafeUi.js` (not on the list above; it mounted the
  Map's Competitors chip with retries after every route change) is `attachCompetitorToggle` in `views/map/searchBar.js`. Fixed on
  the way: the Competitors chip was missing whenever the Map took more than 1 s to draw (the retries gave up), and it lost its
  own icon after the first status filter was picked. New guard: architecture check 8 (no observer on the whole page); new e2e
  `screen-parts.spec.mjs`.
- Step 7 result: no page-wide observer is left except `app.js`'s screen-reader announcer. Observers that watch only their own
  element stay inside the screens' bar code (sort menus, filter rows, the Orders channel menu); replacing them with direct calls is
  optional polish.

#### Step 8. Split the shared files - size 2
- 8a `api.js` -> `api/index.js` (request, json, cache, CSRF) + one file per area (`api/orders.js`, ...), re-exported as the same `api`
  object so callers do not change.
- 8b Texts: `i18n-en.js`/`i18n-hy.js` -> `i18n/<lang>/<area>.js` merged by the loader (same keys; `i18nParity.test.js` checks each area
  file pair). Styles: per-screen CSS moved out of `styles.css` into `css/<area>.css`, loaded with the view (see step 9).
- Done when: a typical feature touches only its area's api, text and style files plus `version.js`/`sw.js`.

### Phase C - speed

#### Launch fix (owner 2026-10-29, done in 1.468.0, before step 9)
"Very long load before the white screen; the speed measure starts at the white screen, measure from the tap." Found on WebKit (Safari's
engine, Playwright, cold browser start each run): Safari starts the page's clock only AFTER the service worker has handed over the start
page, and Safari's Cache Storage costs each launch time for EVERY entry in ANY of the app's caches (5,000 map tiles: start page found
after 0.17-0.19 s instead of 0.016 s on a fast computer; linear, ~35 us per entry; a phone is several times slower and the tile cache had
no limit). The same 5,000 tiles in IndexedDB cost nothing (0.017 s). Done: map tiles moved to IndexedDB (`sw.js` TILE_DB, 4,000 tiles,
oldest dropped first, a stored tile is not downloaded again); the old tile cache is deleted on activation; the start page is looked up
in the app's own cache only. The launch record (`launchTiming.js`) now starts when the worker starts for the launch (it reports its
start and the start-page times by message), saves times after the frame is drawn, and adds "First screen". Rule from now on: no bulk
data in Cache Storage (only the app files); bulk goes to IndexedDB.


#### Step 9. One stylesheet request - size 1
- [ ] The server joins the 11 boot stylesheets (in today's order) into one response `/css/app.css`, minified with the existing
      clean-css path and cached in memory in production; `index.html` links only that; `sw.js` precaches it.
- [ ] Screen-only CSS (after step 8b) is loaded by the view on first open (`<link>` injected once, precached by the service worker).
- Done when: cold start shows 1 blocking stylesheet; measure and record the new cold-start time.

#### Step 10. Bundle scripts at deploy - size 2 (only after the owner's decision 1 = A)
- 10a esbuild in the Docker build: entry `bootGate.js` + each view as a separate chunk (`--splitting --format=esm --minify
  --sourcemap`), output to `client/dist/`; the server serves `dist/` when it exists, else `public/` (so local dev and tests are
  unchanged); `sw.js` APP_SHELL generated from the build manifest at build time; `modulePreload.js` reads the manifest.
- 10b CI builds once and runs the e2e smoke against the built files too.
- Done when: cold start about 10 script requests; record time and bytes. If decision 1 = B: skip this step.

#### Step 11. Texts in two parts - size 1
- [ ] Common texts (shell, login, Home, errors) load first; each area's texts load with its first screen (after step 8b this is the
      area file). Missing-key fallback stays "show the key", never English on an Armenian device.
- Done when: bytes before the first screen drop by about 40 KB gz (measure).

#### Step 12. Speed budget in CI - size 1
- [ ] The cold-start measurement above becomes `server/test/e2e/speed-budget.spec.mjs` (@smoke): fails if Home takes more than 3.5 s
      (then lowered to the value reached after steps 9-11 + 20 %), or scripts exceed 700 KB gz, or more than 20 stylesheet/script
      requests block the first screen.
- [ ] `server/test/integration/speedBudget.test.js`: seeds 4,000 customers / 60,000 order lines, times the 10 busiest endpoints
      (customers list, orders list, debt balances, map facts, dashboard, reports overview, ...) and fails above a stored budget.
- Done when: both run in CI; the budgets are written in this file.

### KAD OS (repo kad-gmm) and the bot

- KAD OS: steps 1 (ESLint), 2 (architecture checks: every route `requireAuth`/`requireCap`, RBAC matrix already enforced) and 12 (its
  speed job exists; add a cold-start budget). One release each; tracked in kad-gmm `docs/ROADMAP.md`.
- Bot: no work now. When `automation/ceo_agent.py` next needs a large change, split it into `telegram/` (bot loop, handlers),
  `reports/` (period reports), `sync/` (Field Visits calls) first, as its own PR.

## 4. Target structure (what "done" looks like)

```
client/public/js/
  bootGate.js, app.js            entry points only
  shell/                         router, layout (top bar, sidebar, more sheet), badges, update banner
  shared/                        api/, roles.js (= server file), util, icons, listCache, offlineQueue, deskTable, sheets
  views/<area>/                  screens of one area, with their own texts and styles
server/src/
  index.js, app.js               start + Express wiring only
  shared/                        roles, db, notifications, push, telegram, upload, pdf, settings, middleware, utils
  jobs/                          the scheduler and its registry (step 4)
  <area>/                        orders, customers, field, money, products, erp, reports, team, bonus
    routes.js                    login + role check, read the request, call one rule, answer
    rules.js                     business rules: one place per rule, no SQL text, no req/res
    queries.js                   all SQL of the area, named functions
```

A route never builds SQL; a rule never touches `req`/`res`; a query file is the only place with SQL for its tables; the phone app and
the server share `roles.js`; a screen never edits another screen's DOM.

## Done log

(step, version, PR, date)

- Analysis and plan: 2026-10-28 (no code change).
- Step 1 code checker: 1.456.0, PR #500, 2026-10-28.
- Step 2 architecture checks: 1.457.0, PR #501, 2026-10-28.
- Step 3 one role file: 1.458.0, PR #502, 2026-10-28.
- Step 4 one job scheduler: 1.459.0, PR #503, migration 167, 2026-10-28.
- Notification switches (owner 1A): 1.460.0, PR #504, 2026-10-28.
- Step 5 phase 1 business folders: 1.461.0, PR #505, 2026-10-28.
- Step 6a refactor tool + map split: 1.462.0, PR #506, 2026-10-28.
- Step 6b app.js into shell/: 1.463.0, PR #507, 2026-10-28.
- Step 6c + 6d settings, admin, reports, customer card: 1.464.0, PR #508, 2026-10-28.
- Step 7a search bars built by their screens: 1.465.0, PR #509, 2026-10-28.
- Step 7b1 Map bar, pin halo, customer channel rule in api.js: 1.466.0, PR #510, 2026-10-29.
- Step 7b2 last outside patchers gone, screens build their own parts: 1.467.0, PR #511, 2026-10-29.
- Launch fix (tiles to IndexedDB, launch clock from the worker's start): 1.468.0, 2026-10-29.
