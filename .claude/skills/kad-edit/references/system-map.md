# System map - "if I touch X, what else can break?"

A guide, not the truth: always `grep` the code for the function, column, endpoint, setting key or i18n key before deciding the blast
radius. Paths verified 2026-11-02; when a path moved, update this file in the same PR.

## The whole picture (three repos, one droplet)

```
Castrol Excel (accountant, daily -> Telegram group)
   |  CEO bot  (castrol_ceo_report: automation/ceo_agent.py, work/*.py)  - reports, daily cash sheets, Excel checks
   v  POST /api/erp-sync, /api/erp-sync/daily-report, /api/erp-sync/reports   (X-Sync-Key; docs/erp-sync-contract.md)
Field Visits = "KAD Motors app" (SalesManagerVisits)  Node/Express/Postgres + vanilla PWA
   |-- /api/integration/v1  (bearer token) <- Lily, the accountant's agent: orders -> invoices / waybills (docs/lily-integration.md)
   |-- /api/partner/*        (customer session) <- KAD OS of a customer (docs/kad-os-link.md)
   v
KAD OS (kad-gmm)  the customers' own free ERP; GMM = Garage Mall = ERP customer 10001; its own Excel GMM_2026.xlsx
   Excel -> tools/export_gmm.py -> NDJSON -> server/src/importer (reconcile.js) -> Postgres gmm
```
Droplet shared by all: `/opt/field-visits`, `/opt/castrol-ceo-bot`, `/opt/gmm-app`. A change in one app's deploy, nginx, cron, docker
or disk use can hurt the others. Never touch another app's directory from this app's deploy block.

Fourth repo: the public website **KAD-Motors/KAD-Motors-Platform** (kadmotors.am; TanStack + React static SPA on Cloudflare, own
Supabase project). Fed one way by Field Visits `server/src/erp/platformSync.js` -> edge function `kad-sync` (products, prices, wholesale
customers by ERP id). Its shared UI: `src/components/layout/` (Header + phone menu, CartDrawer, MobileTabBar), `src/components/ui/`
(Radix sheets/dialogs), `src/lib/scrollLock.ts`; booking self-service `src/routes/booking.$code.tsx` <-> SQL `get_booking` /
`cancel_booking` (the screen mirrors the SQL rule). Its own workflow: README (CI "Build and code-quality checks", Cloudflare deploys main).

## Contracts between systems (changing one side = changing both)
| Contract | Producer -> consumer | Break risk |
|---|---|---|
| ERP sync JSON (`docs/erp-sync-contract.md`) | bot -> Field Visits `server/src/erp/` (`erpTransform.js`, `erpAutoMatch.js`, `platformSync.js`) | debt, sales, plan, prices, HC codes, cashflow, auto-delivered orders, payment "in Excel" match, Vaghinak debt tasks, anti-fraud, reports all wrong at once. Add fields, never rename/remove; old bot must still work. |
| Sync status / "Sync now" | app <-> bot poll (~30 s) | admin's sync card, freshness alerts (`erpSyncFreshness.js`, `erpSyncMonitor.js`) |
| Lily API `/api/integration/v1` | app -> Lily (`erp/integrationTokens.js`, `orders/accountingEvents.js`, `accountingStatus.js`) | invoices / waybills, accounting badge, signed documents. Token scope, test mode, `hc_code` mapping. |
| Partner API `/api/partner/*` | app -> customer's KAD OS (`orders/appOrders.js`; KAD OS `lib/kad.js`, `lib/kadLink.js`, `routes/kadOrders.js`, `lib/kadWatch.js`) | customer sees wrong balance/prices/statuses; customer can reach other customers' data (privacy!). Costs must never leave. Needs both apps' versions. |
| Daily cash sheets | bot -> accounting Telegram group (`work/`, README "Daily cash sheets") | accountant's document flow |
| Backups | each app -> its own Telegram group (Field Visits `deploy/backup.sh`, `send-backup-telegram.sh`; KAD OS `deploy/backup*.sh`, `backup-restore-test.sh`) | silent loss of the only recovery path |
| Excel import (KAD OS) | `GMM_2026.xlsx` -> `importer/` | totals must reconcile to the workbook (SPEC "Acceptance") |

## Field Visits (SalesManagerVisits) - modules and who depends on them
Server areas in `server/src/<area>/` (routes in `<area>/routes/`), shared code in `server/src/shared/`, jobs in `server/src/jobs/`.

| Touch | Also check |
|---|---|
| `client/public/js/kit/` (the shared KAD kit, identical in Field Visits and KAD OS: Back closes sheets, swipe-down, transitions, Navigation API, tap timing, palette) | BOTH apps' Back button, every sheet, screen changes, search; change it in both repos at once, bump `KIT_VERSION`, `node scripts/check-kit.mjs --write` (CI checks the lock); KADDev rule 60 |
| `shared/roles.js`, `middleware/auth.js`, `csrf.js`, `lockdown.js` | every route's capability; client nav/buttons (`client/public/js`); RBAC tests; partner role (`/api/partner/*` only); lockdown screen; `docs/roles-permissions.md` |
| `orders/` (`discountPolicy.js` <= 3 % auto, never below net cost; `creditLimit.js`; `orderStock.js` reservation; `signedActs.js` lock after signature; `orderReturns.js`; `appOrders.js`) | warehouse staging, delivery routes (`routePlanner.js`, `osrm.js`), Lily accounting events, ERP auto-delivered match, KAD OS partner orders + campaigns (409 `below_cost`), Vaghinak chasing, order blank PDF, stock count, offline-queued orders, reports |
| `products/` (`landingCalc.js`, `pricelistApply.js`, `priceSyncLog.js`), 4 price tiers, net / landing cost | order prices, discount floor, campaigns, partner catalog (tier price only, never cost), margin reports, Castrol-file semantics |
| `money/` (`paymentExcelMatch.js`, `cashSheets.js`, `cashflow.js`, `antiFraud.js`, `debtAge.js` / `debtAging.js` FIFO, `debtCollectionTasks.js`, `payroll.js`, `bankStatement.js`, `expenseWatch.js`) | cash hand-off chain (rep -> director -> accountant = terminal), "in Excel / not in Excel", Debt balances, partner balance (same numbers both sides), anti-fraud detectors, staff commission, daily digests, bot cash sheets |
| `field/` (visits, GPS allowance 300 m, `visitPriorities.js`, `overdueReminders.js`, `routePlanSets.js`, `repProgress.js`, fuel) | points/bonus, tasks auto-close, daily summary 19:00, map layers, Vaghinak |
| `bonus/` (ledger, rules, idempotency, reconciliation) | pay, rep progress, GPS evidence; ledger must stay idempotent and reconcilable |
| `team/`, `shared/workingDays.js`, staff pay rules | payroll days, visit-based days, commission, task subordination (Staff "reports to") |
| `erp/` | see contracts above; sync attempts/partial apply (migration 144), freshness |
| `jobs/` (one scheduler) | duplicate runs after restart, overlap, quiet hours (`shared/quietHours.js`), push/Telegram spam |
| `shared/notifications.js`, `push.js`, `telegram.js`, `notificationPreferences.js` | every feature that notifies; user opt-outs; quiet hours |
| `shared/settings.js`, `app_settings` keys | every screen reading that key; defaults must equal the old behaviour |
| DB `server/migrations/NNN_*.sql` | rollback (old code on new schema), the bot payload, reports, backups/restore, `docs/data-model.md` |

Client `client/public/`: `js/app.js` / `bootGate.js` (boot), `js/views/*`, `js/api.js` + `js/api/`, `js/listCache.js`, `js/offlineQueue.js`
(idempotent `client_ref`; `docs/offline-sync.md`), `sw.js` (`APP_SHELL`, `CACHE_VERSION`, network-first API), `js/version.js`, `js/i18n-hy.js`
+ `js/i18n-en.js`, `js/icons.js`, `js/regionTree.js` (the one tri-state filter sheet), `js/deskTable.js` (desktop tables), `js/searchBar.js`.
Design rules: `deploy/design-system.md`, `deploy/ui-qa-checklist.md`. Structure target and "what to keep": `docs/architecture-roadmap.md`
(rules in their own module, no SQL piled into route files, no screen patching another screen's DOM). Governance: `docs/governance/`
(definition of done, migration checklist, critical user journeys, severity, change-management freeze).
Checks: `cd server && npm test` (slow, background), `npm run lint`, `npm run verify:ui`, `npm run check:version`; CI `test` + `e2e-smoke`.

## KAD OS (kad-gmm)
Map: `docs/ARCHITECTURE.md` ("Rules that keep changes safe" + the check for each), product: `docs/SPEC.md`, Excel: `docs/WORKBOOK.md`,
plan: `docs/ROADMAP.md`.

| Touch | Also check |
|---|---|
| `server/src/roles.js`, `routes/auth.js`, middleware | every route `requireAuth` / `requireCap` (`test/unit/architecture.test.js`, RBAC matrix); CEO-only areas (acts, pay) |
| `lib/money.js`, `payledger.js`, `payroll.js` / `payrollData.js`, `bonus.js`, `settle.js`, `attendance.js` | one rule, one place (a calculation used by two routes lives in `lib/`); reports, dashboard, cash, staff pay, Excel reconcile |
| `importer/` (`normalize.js`, `reconcile.js`), `lib/cutover.js`, `excelChanges.js` | totals reconcile to `GMM_2026.xlsx` until cutover; names are never keys (customers by `card`, products by `product_key`) |
| `lib/kad.js`, `kadLink.js`, `kadWatch.js`, `routes/kadOrders.js` | the Field Visits partner API (both repos), the customer's view of debt/payments |
| `lib/stock.js`, `stocktake.js`, `receipts.js`, `routes/inventory.js`, `purchases.js` | stock numbers on sales, smart order, 50k-product speed |
| `andranik/` (AI assistant), `sync/` (Telegram source), `lib/notify.js`, `push.js`, `watchdog.js` | message volume, quiet behaviour, cost |
| client (`client/public`) | `APP_VERSION` + `CACHE_VERSION`, `APP_SHELL`, `modulepreload`, `npm run shots:base` / `shots` (no pixel change on refactor), `npm run bench` speed budgets, file <= 800 lines / 60 KB |
Deploy: `deploy/deploy.sh`, rollback `deploy/rollback.sh`, backups `deploy/backup*.sh`. Checks: `npm test`, `npm run lint`, `verify:ui`,
`check:version`, `qa`, CI `test` + `e2e-smoke` (+ `speed`).

## CEO bot (castrol_ceo_report)
`automation/ceo_agent.py` (Telegram loop, reports, schedules, access control, Armenian texts), `work/*.py|*.mjs` (extraction, report
builders), `tests/` (pytest: cash sheets, cashflow ledger, product sync, sync requests, Telegram replies, workbook check). Reads the Castrol
workbook (see Castrol-file for sheet semantics and data traps). A change in a report's number must match Excel semantics; a change in the
sync payload must follow `erp-sync-contract.md` and keep the app accepting the old payload. Who may talk to the bot is access control:
review it like RBAC.
