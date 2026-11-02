# The 13 lenses - questions to answer before approving a change

For size M answer each lens in one honest line; for size L work every question that applies. "N/A" is allowed only with a reason.
A "no" or "not sure" becomes an item in block 1 (Problems) or 2 (Risks) of the output.

## 1. Architecture
- Does the change live where the structure says it should (rule in its own module; SQL in the area's queries, not piled into a route;
  `lib/` never imports a route; no screen patching another screen's DOM)? See `docs/architecture-roadmap.md` / KAD OS `docs/ARCHITECTURE.md`.
- Is there already a module that owns this rule? Extend it; never write a second copy of a calculation.
- Does it respect the no-framework, no-build model and the "what to keep" list (listCache, offline queue, back-cache screens, SW update flow)?
- Would a file cross 800 lines / 60 KB? Split first.

## 2. Dependency
- Every caller of each changed function / endpoint / column / setting key / i18n key found by `grep` (list them).
- Which other repo reads or writes this (bot payload, Lily, KAD OS partner API, KAD OS importer)? Same release order needed?
- New third-party package? Justify it (size, maintenance, licence, supply-chain risk); prefer none.
- Jobs, notifications, reports or digests fed by this data.

## 3. Business logic
- Which business rule does this touch: tiers and price floors (never below net cost), discount policy (<= 3 % auto, more needs director /
  CEO), credit limit, order statuses and locks (signed act locks the order), cash hand-off chain, "in Excel" matching, FIFO debt aging,
  pay / commission / working days, stock reservation, visit GPS allowance, task subordination, KAD OS campaigns?
- Does every role still follow the process in kadprocesses? Did an approval, control or anti-fraud signal get bypassed or weakened?
- Statuses: can an item reach a state it could not before, or get stuck? Who is told?
- Is this a policy change? Then it is the owner's decision (options + recommendation).

## 4. Security
- Server-side authorization on every new/changed route (`requireAuth` + capability from `roles.js`); UI hiding is not security.
- Object-level access: can a user change an id in the URL/body and read or write another rep's / customer's data? Partner accounts reach
  only `/api/partner/*` and only their own customer.
- Input validation and SQL parameters (`$1`, never string-built SQL); file uploads (type, size, path, served with safe headers);
  PDF / HTML generation (escaping); open redirects.
- CSRF on cookie-auth writes; rate limits on login, OTP, expensive or public endpoints; lockout and `token_version` revoke still work.
- Tokens (sync key, integration bearer, Telegram bot): scoped, revocable, never logged, never in the client, never in the repo.
- Privilege escalation: can a role grant itself or others a capability? Audit log for sensitive actions (money, roles, settings, deletes).

## 5. Privacy
- What personal or business data is shown, logged, exported, sent to Telegram/push, or given to an AI (Vaghinak, Andranik, Lily)? Only
  what the receiver needs. Costs and other customers' data never reach a customer. Salaries only to who may see them.
- Exports, PDFs and screenshots in PRs carry no real phones, TINs, salaries or names.
- Retention: does new stored data need a clean-up job or a delete path?

## 6. Performance
- Phones: 3 GB Android and iPhone; first screen download budget (`verify:ui`); no new blocking script; dynamic import for new screens.
- API calls per screen (no N+1 from the client); listCache / GET cache reused; no loading flash on tab switch.
- SQL: indexes for new filters/joins, no full scans on big tables (50k products, years of visits), pagination, `EXPLAIN` when unsure.
- Jobs: run time, overlap, lock; what happens with 10x the data.
- KAD OS `npm run bench`; Field Visits baseline numbers in `docs/architecture-roadmap.md`.

## 7. UX / UI
- Uses existing components (bottom sheets with fixed action bar, tri-state accordion filter `regionTree.js`, search bar with "x", wheel
  date picker, desk tables on PC, "!" info icon for secondary text) and the design system (`deploy/design-system.md`); lucide-style icons.
- Fewer taps than before, or a clear reason for more. No duplicate fields, texts or search bars.
- Loading, empty, error and offline states designed; disabled states explained.
- 44 px touch targets; Armenian long labels wrap at 320 px; amounts right-aligned on one line, whole AMD with separators; thin focus outline;
  dark mode; no overlap/overflow; portrait lock on phones; wide screens used well on Windows desktop.
- Every new string in `hy` and `en`.
- Accessibility: labels, contrast, focus order, no colour-only meaning.

## 8. Data integrity
- Excel is the trusted source until cutover: imported/synced totals reconcile to the workbook; the app never "fixes" Excel numbers silently.
- Keys: Customer ID / ERP id / `card` / `product_key`, never names. Money whole AMD (no floats drifting); dates in Yerevan time,
  Monday-start weeks, calendar periods.
- Idempotency: retries, double taps, offline replay (`client_ref`), re-sent sync payloads, re-run jobs produce no duplicates.
- Concurrency: two users / two devices / job + user editing the same row; use transactions and row locks where money or stock moves.
- Constraints in the DB (FK, NOT NULL, CHECK, unique) rather than only in JS.

## 9. Regression
- What worked before that this could break? Run the critical user journeys (`docs/governance/critical-user-journeys.md`).
- Was any behaviour, validation, permission, column, notification or default removed or changed? It must be listed and owner-approved.
- Tests that cover the touched flow still pass unchanged; if a test had to change, why (behaviour change = owner decision).
- KAD OS refactor: `shots:base` before, `shots` after - no pixel change.

## 10. Compatibility
- Old client (cached by the service worker for hours) against the new server; offline queue items written by the old client.
- Old bot payload against the new server; old KAD OS against the new partner API (and the reverse).
- Migration is additive and backward-compatible (add, never drop/rename in the same release) so rollback runs old code on the new schema.
- iPhone Safari PWA, Android Chrome, Windows desktop browsers; Node 22 / Postgres 16 / Python versions on the droplet.

## 11. Maintainability
- Clear names, one rule in one place, no copy-paste between screens or repos; shared component reused or created.
- Tests added for the new rule (unit for the rule, integration for the route, RBAC row, e2e if a critical journey).
- Docs updated in the same PR (`docs/*.md`, `system-map.md` here if a module moved, CHANGELOG when releasing).
- No new technical debt without a line in the risk / debt register.

## 12. Cost
- Infrastructure: disk (uploads, photos, PDFs, backups), CPU on the shared droplet, memory, bandwidth.
- Third-party / AI calls (Claude, OSRM, maps, Telegram limits): per day at current and 10x use; caching; a switch to turn it off.
- Support burden: will staff need training, will the owner get more questions, more notifications to read?

## 13. Release risk
- Size (S/M/L) and what the worst realistic failure is, for whom (rep in the field, accountant, customer in KAD OS, the owner's numbers).
- Staged release (flag/setting default = old behaviour, admin-only first, shadow mode for automatic rules).
- Migration included? Tell the owner; backup first if it rewrites data; deploy block says "includes migrations".
- Monitoring: the signal that shows it works or broke (log line, sync card, Telegram alert, a count to compare before/after).
- Rollback: the exact step, and how to undo data written by the new code.
