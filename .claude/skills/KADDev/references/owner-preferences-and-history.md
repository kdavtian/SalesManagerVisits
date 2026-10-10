# The owner: preferences, patterns, and the history of what was built (and why)

## How they work with you
- Writes short, numbered, imperative requests (often with screenshots "image1/img2"), mixes English with Armenian terms. Expects every number addressed. Often says "Continue", "Merge", "Next", "Done?", "Go on" - keep going on the existing plan, merge when green, report briefly.
- Asks "suggest first, don't implement" for analysis tasks (full QA, security, UI audits, plans, ERP-migration scoping) - then picks items ("fix 1,2,4, NO NEED for 3"). Respect the exclusions exactly. When asked what a UI element is called, name it (bottom sheet, wheel date picker, accordion tree...).
- Wants to understand effects before approving big changes ("What will these changes give me? Won't it make the app slower?") - answer plainly, with trade-offs and a recommendation.
- Uses the app on iPhone (16 Pro Max, an iPhone 11 on old iOS), 3 GB Android phones, and Windows desktop. Tests immediately after deploy and reports exact versions ("I am on 1.220.0"), so version accuracy matters.
- Delegates everything: "You have access to the bot, fix it", "use your skills and understand what to do". Does not want questions that you can answer by reading code or the Excel file themselves.
- Security-conscious: calculator disguise, emergency disconnect, CSRF, lockouts, audits - yet pastes secrets into chat. Warn gently, never echo.

## Visual / UX preferences (apply by default)
- Compact, iOS-native feel: bottom sheets, floating/fixed action bars (Cancel/Save on customer edit must be fixed at the bottom; Clear/Done on filters fixed), wheel date pickers (Team Performance style) everywhere dates are chosen, haptics where native.
- Hide explanatory/secondary text under a small "!" info icon (Settings descriptions, "Castrol data as of...", "ERP-invoiced..." notes); don't show redundant text (e.g. "here your field plan..." for management, "showing first 200 results").
- All hierarchical multi-select filters use ONE component: bottom sheet, searchable, expandable accordion groups, tri-state checkboxes (`regionTree.js` `openTriStateTreeSheet`): customers region/assignment/type-tier, map plan day, route plans, pricelist (brand > category > product). Every search bar has an "x" clear button; filter/sort icon buttons sit INSIDE the search bar (like Customers/Activity); search bars share one width/style.
- Every sort control is tap-to-reverse.
- Amounts right-aligned; AMD whole numbers; compact so sales/collected fit one line; status + amount + action on one row for payment cards.
- Filter chips look like the Activity tab chips (e.g. Company dashboard period, Sales). Filter buttons short in height. Keep counts: `All (200+)` plus a `+` on a channel chip only when the cap is actually hit.
- Thin blue focus outline only (never the thick one, never an outline around a whole search bar). No stickiness on customer cards. Back button must not touch neighbouring header buttons (header row raised a little). Icons: lucide style (box for warehouse, layout-dashboard for dashboard, octagon-alert for rejected/mismatch); same sizes for all status icons on Activity; rejected icon same size as verified/pending; icon buttons >= 44 px target but visually consistent.
- Customer card: back button + customer icon at top-left, 10 px gap, tops aligned, same size; name + ERP id next to the icon; social buttons inside the main info card (never overlapping the address); total-debt text small, graphite grey (not blue).
- Map: search address icon on the left of the field and opens the keyboard immediately; "planned today / assigned to me" target-icon button in the right button column (between Plan day and pin key); multi-select filters; default filter = potential + sales-manager channels (not b2b/cvo/oem/cas) for everyone; sales managers default to assigned-to-me; compass off by default; long-tap adds a customer point; route line must disappear when filters clear; selected pin and zoom preserved when coming back from a card; customer edits reflect on the map without restarting. Windows desktop map blank tiles issue was fixed once (tile/CSP/size cause) - re-test desktop when touching the map.
- Screen must not rotate to landscape on phones. Armenian long labels must wrap. App should open pages instantly (cached lists), no "Loading" flash on every tab switch, home badge counts without a double refresh; no login required after an update.
- Home tab for management: Company Dashboard preview card (sales vs plan + collected); sales managers: today's visit plan + weekly progress. Quick actions include Sales, Reports, Bonuses, Warehouse, Delivery with count badges.

## Things that repeatedly bit us (check proactively)
1. Forgetting `CACHE_VERSION` bump -> "no updates" on phones.
2. Migrations not run on the droplet -> missing column/table errors (`integration_tokens`, `bonuses_enabled`).
3. `JWT_SECRET` too short / DB role names (`fieldvisits`, not `postgres`) in commands.
4. Date logic: "this week/month" must be calendar periods; timezone (Yerevan) boundaries; the same date bug existed in several files - grep for siblings when fixing one.
5. Name-based matching of customers across data (bug) -> match by Customer ID.
6. Swipe-back/gesture closing the wrong layer (orders tab vs order sheet); sheets opening with a freeze (heavy synchronous render).
7. Regressions from my own UI refactors (customer-detail overlap, tap targets) - run the real-browser check.
8. Data not from Excel (landing cost, net cost, last payment, hc_code): verify the source sheet/column and the sync payload, not only the UI. Duplicates (products, customers, test users).
9. Test data left in production DB (itest users) - clean up in tests and in prod.
10. Tier/permission matrices: sales_manager scoping must be enforced server-side, not just hidden in the UI.
11. A missing comma in `i18n.js` blanks the app (hy `acc_no_requests` once) - `node --check` after every i18n edit; a missing `hy` key silently shows English (the whole Bonuses module had no Armenian).
12. Slow lists come from per-row correlated subqueries, not the network: EXPLAIN them on seeded data (3,000+ rows) before blaming the client.
13. Repeated requests: the owner re-sent a list already shipped in 1.259.0 - check `git log`/the code first, verify in the browser, report which items already existed.
14. A typo in a template-string SQL (missing comma before the params array turned the query into `"..."[id]` -> `syntax error at or near "L"`) passed the local suite and only the e2e job caught it: add a regression test whenever a query is edited, and read CI logs (`get_job_logs` with `tail_lines` 400) instead of guessing.
15. Press feedback: generic `.card:active` makes a whole card shrink when a child chip is pressed (route plans) - override on container cards.
17. The global `form input { margin-top: 6px; padding: 11px 12px }` rule breaks flex/grid rows of inputs and buttons (task checklist misalignment). Inside a form, give custom controls an explicit scoped class (`.task-editor .task-control`: margin 0, fixed 44px height) - class + one ancestor beats `input[type="search"]`.
18. An attached screenshot ("img1") may not arrive: if no image is visible, say so in the summary and work from the description + the code; never pretend to have seen it.
19. BLANK MAP (grey area, working buttons, fixed only by restarting the app) root cause (1.278.0): `mapSafeRuntime.js` wraps `L.map`/`setView` and swallowed the map's own FIRST `setView` when a saved view existed at zoom 15, so the map never got a view (`_loaded` undefined). Never swallow/skip a `setView` while `map._loaded` is false; a map instance without a view draws nothing. Also: Leaflet `trackResize` measures a detached (back-stack) container as 0x0 - map.js now uses a ResizeObserver guarded by `mapIsMeasurable()` and a one-shot blank-map self-heal (`checkMapNotBlank` -> `app-rerender`). Diagnose map issues in a real browser by exposing the map (`window.__dbgMap`) temporarily and checking `_loaded`, `getSize()`, tile count; remove the debug before committing. Local login in scripts hits the rate limiter after many runs: send `x-e2e-rate-limit-bypass: guide`.
16. Overwriting an existing file with `cat >` (a router named `exports.js`) - check names first.

## Timeline of what has been built (purpose in brackets)
- Early: customer tiers & category selector (segmenting accounts); customer cards redesign (many rounds on icon sizing/position); activity tab ranges (calendar week/month), limits 15 -> 25 -> 200 -> 1000; delivery module fixes (route planning losing orders, delivered without route, director gets warehouse permissions); team performance plan editing fixed and simplified (sales + collections only).
- Performance: audit of slow causes on 3 GB Android; lazy view loading, IndexedDB list/product caches, tile caching/pre-warm for Armenia, performance mode (auto-detect device + MAX mode), service-worker update banner and "Check for updates".
- Reports/ERP: bot reports mirrored into the app (CEO daily/weekly/monthly/quarterly/annual, Sales Director, debt Excel; push on "daily report ready"); report generation from the app; sales-by-channel sync fixes; Sales page from ERP data; company dashboard (period filter, plan, per-rep bars, collected marker); debt balances (live + as-of-date with Balance0 logic; last payment from app + Cashflow); discounts shown on order cards; Customer ID based matching.
- Offline & security: durable offline queue with needs-attention, per-user caches, CSRF, upload validation, lockout, security headers, full security review, emergency disconnect + calculator mode, error monitoring, data-quality dashboard, quality baseline docs/governance, API integration tests, Playwright e2e suite, deploy speed work (fast/full deploy).
- Warehouse/inventory: staging with brands, pick list ticks grouped by brand, collapsible brand/family groups with pcs|L subtotals, landing cost/net cost/wholesale toggles, grouped variant pills, stock-days-left forecasting, dead stock, accountant/ceo/director access.
- Roles: Operations Director (CEO-equivalent), admin role change/delete user with linked-record review.
- Bonuses: large multi-phase module (rules, ledger, challenges, wizard, rewards, badges, employee UI), feature-flagged; fixes so managers/admin see challenges and a quick action.
- Maps/customers: tri-state filters, plan-day filters, region/subregion autofill, sales channel assignment from route distribution, social profiles, ERP-id/phone/social search.
- Recent batch (#224-#230): customer UI fixes, debt/last visit for ERP customers, Team Performance for sales managers (bot fix: fall back to ORDERS when Sales Team cell errors), Orders search padding, Lily accountant integration (token API, waybill/invoice doc rule, HC codes from workbook, confirm sheet), workbook 2.0.7 support in the bot, tier pricing + gold individual prices + type/tier customer filter (v1.244.0, PR #230).

- v1.245.0: Routes Distribution moved to Route Plans as a multi-select accordion tree with channel buttons; customer tier follows Excel Tier; silver wholesale price + net cost refreshed from workbook on warehouse/products.

- v1.248-1.274 (Oct 2026, PRs #248-#263): back stack + in-app downloads + debt aging filters + report order + route badge (1.259); map brand-chip filter and loader race fix (1.260); Sales search keeps period (1.262); faster location detection (1.263); customer legal name/address with TIN registry lookup (1.264, live site selectors still unverified); accountant home snapshot / read-only route plans / direct payment acceptance (1.265); Orders "Accounting requests" group + status change + wide PC order dialog (1.266); customer-card stat tiles open details, payments-received sheet, label overlap fixes, white-screen safety net (1.267); Payments (Excel) report (1.268); TASK MANAGEMENT module (1.269); Sales | Payments tabs + Excel export, Tasks list fix (1.270); "!" popup, Home chevron alignment, file export sheet, check-in X (1.271); 10-screen back stack on iOS (1.272); customer buttons one row + double-tap tab restart (1.273); route plan chip press fix, 10x faster customer list + planner, Home tile order, Armenian Bonuses (1.274).
- v1.275-1.276 (Oct 8): Task editor redesigned (sections: Customer | Assigned to, Deadline row with date + Next visit + Specific date, "What needs to be done", Checklist rows [+][text][x]; 44px rounded controls, scrolling form with pinned Cancel/Save) (1.275); accountant may submit a rep's draft, confirm submitted orders and request invoice/waybill, but not edit/reject/approve discounts (1.276).
- Owner decisions: financial director role does not exist (accountant only); accountant approves any pending payment; back stack 5 (10 on iOS); tile order list (route plans kept last); map tiles are standard OSM (soft on retina) - a retina/@2x provider (MapTiler/Stadia/Mapbox, API key + cost) is a possible upgrade, undecided.

## Open threads (updated 2026-10-08)
- Legal name/address registry lookup (`registryLookup.js`, migration 091) is unverified against the live e-register.moj.am page; the sandbox cannot reach it - ask the owner for page text/screenshot of TIN 02256083.
- Warehouse "Power1/Transmax" labels need droplet bot pull + restart + workbook re-send.
- Suggested, NOT built (owner said no changes for now): limit + "Load more" on Check-ins and New-customers reports; map loads only visible pins; `team-today` on demand; pull-to-refresh; swipe actions on cards; "Today's route" mode; "Repeat last order"; undo toast; offline status badge; saved filter views; voice note on check-in; repeating tasks/priority/templates for Tasks.
- (older, from 2026-10-05) PR #230 / bot PR #28 items below were merged/handled in later releases - verify before acting on them.

## Older open threads at the time this skill was first written
- PR #230 (tier pricing, gold prices, customer type/tier filter) waiting on CI/merge; migration 087 must be run on the droplet.
- Bot PR #28 (workbook 2.0.7, silver fallback) needs merge + bot restart + re-send workbook.
- Possible: UI for managing gold individual prices outside the order form; Lily real-token flow live; HC code coverage check.


## UI/UX vocabulary the owner asked to be taught and to use (2026-10-07)
Use these names in answers and in code comments; suggest the better pattern when one exists.
- **Sticky header / pinned header** -- a title bar that stays at the top while the content scrolls (e.g. "Edit order"). **Sticky footer / bottom action bar** -- Cancel/Save (or Clear/Show) pinned to the bottom of a sheet. Owner wants both on every long sheet.
- **Bottom sheet (modal sheet)** with **scrim/backdrop** behind it; **sheet grabber/handle**; **full-height sheet** for long flows.
- **Top app bar** (Back + title + actions) and **bottom tab bar** (navigation).
- **Chips** (filter chips = toggle, input chips = removable), **segmented control** (the % / AMD switch), **toggle/switch**, **stepper** (+/- quantity), **FAB** (floating action button).
- **Skeleton screen / placeholder** (grey blocks that keep the layout while loading), **empty state**, **toast/snackbar**, **popover/popup** (map pin), **accordion/tree picker**, **pull-to-refresh**, **infinite scroll / lazy rendering**, **prefetch**, **optimistic UI**, **deep link**, **back stack / back navigation**.
- Bottom-sheet button position is standardized (`--sheet-pad-bottom`); never add per-sheet bottom padding.
- Back from a screen opened by a sheet's link returns to that sheet (`leaveSheetTo` in util.js parks it; app.js restores it with the back-cache).


## Update 2026-10-09 (v1.277 -> v1.293.0, PRs #280-#287)

### Timeline
- #280 notification reduction: one consolidated stale-packed reminder + one daily summary at 19:00 Yerevan.
- #281 Settings tap targets (the "!" next to a row no longer triggers the whole row), stray line on the notifications button, admin workspace "Group & search", open the printed PDF after creating it, order lines saved in products-page order.
- #282 map filters rebuilt (shared `filterIcons.js`, sticky Clear/Show, active-filter state visible, Competitors label), stable map camera, debt-report aging filters update in place (no blink), check-in header aligned with the X, order status icons, smaller Home "this week's progress" card.
- #283/#284 order blank PDF polish; #285-#287 fuel allowance report (friendly redesign, background route queue, city vs highway consumption, "detect all issues" plausibility flags).

### New preferences (owner's words in quotes)
- "Merge it when CI is green" -- do not ask, merge. Report the version after.
- Detect interaction bugs proactively: tapping a small icon must hit the icon, not the whole section (44 px invisible hit area).
- "Same icon, same feature" across all filter bars; icons should look polished; standardise, don't invent per screen.
- Admin screens must be friendly: grouped, searchable, with a setup checklist when configuration is missing.
- A report stuck on a grey skeleton is a bug ("I only see this. Check everything and make it much more user friendly") -- fix root cause (never wait on a slow service), then polish the whole screen.
- Documents the owner prints/sends are judged visually: logo balance, units (L, հատ, դր), page numbers "Էջ n/m", right-aligned phones, delivery address, TIN and legal name, totals in litres and pieces.
- Asks for improvement suggestions after a list; suggest, then wait unless told to do it. Suggested but not built: order number/QR on the blank, discount line, payment-method stamp, signed-photo upload, remembered print variant, per-role notification defaults.
- For anything with policy or money impact (fuel rules) ask with concrete options first (AskUserQuestion); the owner chose: real road distance, home leg only when first/last check-in is outside Yerevan, accountant also sees it, one fuel price per month.

### Things that bit us (continued)
20. CI-only red: a test used UTC `CURRENT_DATE` while code uses Yerevan dates -> use `(now() AT TIME ZONE 'Asia/Yerevan')::date`.
21. Running tests locally without `NODE_ENV=test` -> 10 s notification debounce, spurious failures.
22. A secondary Leaflet map created through the wrapped `L.map` overwrites the main map's saved view; use `new L.Map(...)`.
23. A report that awaits OSRM/network hangs forever when the service is slow; use cache + background queue + polling.
24. Local leftovers (order seq, `fuel_route_cache`) break repeat test runs; tests clean their own state.
25. Playwright browser path mismatch: symlink `chromium_headless_shell-1243` to the installed `1194` directory.

### Open items for the owner on the droplet (as of 1.293.0)
- Deploy #287 with the FULL `./deploy/deploy.sh` (migration 100).
- Reports > Fuel allowance > Settings: each rep's city/highway L/100 km, home address, monthly fuel price.
- Team > Edit: Armenian full name (`name_hy`) for each manager (used on the order blank).

## Update 2026-10-10 (v1.299.1 -> v1.302.0, PRs #295-#299)
### Timeline
- #295 (1.299.1) wiring audit of the whole session: 19 client modules were missing from the service-worker precache (`APP_SHELL` in `sw.js`), among them modules that precached views import statically (`orderDetailSheet.js`, `visitFirstCard.js`, `productSearch.js`, `brandChips.js` ...). Rule: **every new client module that a precached view imports statically must be added to `APP_SHELL`**, otherwise an update installed just before going offline can leave Orders/Dashboard unable to load.
- #296 (1.299.2) **credit limit "not saving"**: `api.setCreditLimit` and `api.linkOrderToErp` sent a JSON string body WITHOUT `Content-Type: application/json`, so `express.json()` ignored it, the server stored "no limit" and answered 200. Fixed with the shared `json()` helper and a default header in `doRequest`. Server tests never caught it because the test helper always sets the header. Owner had typed limits that silently saved nothing: tell them to re-enter.
- #297 (1.300.0) photo viewer: the existing X was hidden under tall phone photos (the image painted later and covered it). `photoLightbox.js` (moved out of `visitDetail.js`, still re-exported there) now has the X/arrows/counter at `z-index: 5`, a solid ringed X, and the image is sized to leave a clear strip. The check-in page opens a captured photo's thumbnail in the same viewer before submitting.
- #298 (1.301.0) Map filters: the manager dropdown and the channel filter are ONE filter (`assignmentKeys`, tri-state tree from `buildDirectionManagerTree`, leaf ids `channel::managerId`, sales-rep icon; `null` = default field channels, empty Set = no filter); customer **tier chips** (`tierFilters`) live inside the customer-type sheet (same `.tier-btn` chips as the new-customer form, multi-select); choosing the Competitor tier or a COMPETITORS channel reveals competitor pins itself (`syncCompetitorsForFilters`). "Planned" follows the single rep picked (`selectedPlanManagerId`). Bug fixed: the brand chips row painted over the top of the status menu and hid "All" -- `.map-search-row` now has `position: relative; z-index: 3`.
- #299 (1.302.0) Tasks page rebuilt like Activity (see below) and cancel/complete dialogs removed.

### Tasks page (views/tasks.js)
Status tabs (Today / All open with counts, Done, Cancelled), one pill per person (busiest first, tap again clears; hidden when there is a single person), combined search with icon dropdowns (whose: all/mine/given by me; type: debt collection / reorder follow-up / given by a person; sort), open tasks grouped Overdue / Today / Upcoming, kind icons (wallet = debt, repeat = reorder). ALL tasks load once (`status=all`, open first within the 500-row cap) and filter on the phone; `paintChrome()` redraws tabs/pills while typing so the search input is never recreated (iOS keyboard).

### New preferences (owner's words in quotes)
- "Remove this confirmation page, as the user can restore the task if he didn't want to cancel that one": **no confirm()/prompt() where the action can be undone** (cancel task = no dialog, Restore is one tap; completion note is an inline field). Apply to similar spots proactively.
- "Improve ... understanding all the business logic and my preferences": for a page redesign, mirror the Activity tab pattern (tabs, people pills, search with icon filters) and the shared components; do not invent new ones.
- "Double check the connections, wiring, processes. Make sure everything works completely fine": run a full audit (fresh migrations, full tests, route/report/i18n/notification/API-path cross-checks, scheduled jobs, bot tests) and report what was found, even when little.
- "Give me list of new features and updates ... so that i check them on real iphone": answer with a numbered per-change checklist (what to open, what to expect), newest first, noting anything not yet merged.
- "Maybe there is no database under it": when the owner doubts the data layer, give ONE copy-paste prod command to verify (e.g. `docker compose exec db psql -U fieldvisits -d fieldvisits -c "..."`) and explain why it is or is not the cause.
- "I type the limit and its not saving": reproduce it in a real browser and watch the network response before theorising (found the missing Content-Type that way).
- Map filter wishes: merged "Sales channel > sales rep" filter keeps the sales-rep icon; tier chips (Potential, Gold, Silver, Bronze, Competitors) sit inside the customer-type filter; nothing may cover the "All" option.
