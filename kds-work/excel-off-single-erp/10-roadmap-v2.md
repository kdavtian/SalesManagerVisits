# 10 — Roadmap v2 (FINAL) — excel-off-single-erp (Option A, Gate G4 may move P4 to Option D)

## Program exit criteria (restated from intake, sharpened by critique ➕/⚠️)
E1. Every module flipped through gate G1 (below). E2. For 30 consecutive days the accountant confirms **no business entry is typed in the workbook** and no report, screen, bot message or partner (KAD OS, Platform) reads it; `/api/erp-sync` is disabled. E3. Each event typed once (cash number: 4 copies → 1). E4. Books feed: month-end app ↔ accounting program differs by 0 AMD, accountant signs.

## How a module moves (applies to every phase)
1. **excel** → build + golden scenarios pass. 2. **shadow**: app records for real; Excel still kept; for THIS module every Excel→app derivation is switched off (auto-deliver "From ERP", "in Excel" approval, auto-approve) so the comparison is honest; the Reconciler diffs daily, excluding Excel-derived fields. 3. **Gate G1** → 4. **app**: the sync refuses this module (all 3 write patterns), the app writes the module's rows back into the workbook in the exact sheet format (reverse export, T0.10) so the workbook's remaining formulas (Debits, Inventory, KPI) keep working until the last module leaves, and so rollback is a re-import, not re-typing. 5. Hyper-care 2 weeks; **rollback window 30 days** (switch back + reverse export already in the workbook), then closed.
**WIP rule:** at most ONE shadow that needs the accountant at a time; an automated-diff shadow (prices) may run beside it.
**Gate G1 (per module):** shadow covers ≥ 1 month-end and ≥ 20 working days · 100 % of differences attributed (app error / Excel typing error / timing / known trap) · app-side errors = 0 for the last 10 working days · golden scenarios pass · UAT with the accountant passed (S4) · accountant signs. Shadow longer than 8 weeks → owner decides: extend, flip with logged Excel errors, or abort.

## Estimates — reference class
I4 (internal, git history of this repo, fetched 2026-11-06): 50 merged PRs in 8 days (2026-10-30 → 11-06); the payments redesign R1–R5 (two-track receipts, cutover date, bridge, cash desks, bank payments, live debt everywhere) shipped in 2 days (11-02 → 11-03). So **build effort is days per module; the calendar is set by shadow periods (month-ends), the accountant's time and the owner's review**. Single internal case → `[SINGLE-SOURCE]`; human-developer ranges from v1 (44–78 weeks) are rejected as the wrong reference class but kept as the P90 tail.
**Calendar (start 2026-11-09):** P10 2027-06 · **P50 2027-09** · P90 2028-03. [ESTIMATE — internal reference class I4, single case]

## P0 Foundations (2026-11-09 → 2026-12-31, 6–8 weeks) → M0: backups proven, nothing posted can be deleted, switch + Reconciler + golden scenarios live, tax answers in hand
### T0.0 Accountant workflow study (first)
Owner: owner + accountant · Outputs: every Excel task, minutes/day, the app screen that replaces it, which task disappears at which flip · Success: list signed · 1 week · Gap: D21
### T0.1 Backups finished [CP]
Owner: KAD Builder + owner (deploy) · Inputs: existing `deploy/backup.sh` + `deploy/send-backup-telegram.sh` (7z/AES to Telegram) · Outputs: cron on the droplet, size alarm, **second target for files > 50 MB** (DB dump grows; uploads/POD photos volume included), restore drill on the Docker Compose shape, drill log monthly · Success: last night's DB + uploads restored on staging, row counts + checksums equal; RPO ≤ 24 h, RTO ≤ 4 h · 1–2 weeks [ESTIMATE] · Gate **G0** · Risk: personal data in a Telegram group → T0.6 question · Evidence: S9, I1 · Gap: D14 (partial)
### T0.2a Delete-path inventory [CP]
Outputs: every `DELETE FROM` / hard-delete route on posting tables, blocked for posted records: admin delete of delivered orders, `team/userPurge.js` (name matches "test" → deletes orders, payments, handoffs: limit to never-posted rows), `money/cashflow.js:154` delete-by-origin (becomes per-module, refused when cash=app), `routes/cashflow.js:208` row delete (void instead) · Success: test per path · 3–5 days [ESTIMATE, I4] · Gap: D15
### T0.2 Posting model, per document type [CP]
Outputs per type (receipt, sale, credit note, cash entry, stock move, purchase): `posted_at`; **number assigned by the server at posting** (offline phones keep their `client_ref`; gap-free sequence per type per year); historical rows = posted at migration date, numbered with a prefix; void/reverse only; **period lock = Yerevan calendar month**, closed/reopened by the accountant (reopen = admin/CEO + reason); the 3-day cash edit window applies only inside an open period; role matrix (post / void / close / reopen) as named rules in `shared/roles.js`, enforced on the server, each with a test; one ADR per decision in `docs/` linked from its test · Success: golden scenarios T0.9 pass · 2–4 weeks [ESTIMATE, I4] · Evidence: S6, S13, S14, S28 (T3, unfetched) · Gap: D15
### T0.3 Source switch + sync guard [CP]
Outputs: App configuration "Source of truth" per module (excel / shadow / app); `/api/erp-sync` guard for **TRUNCATE-replace, products upsert, cash delete-by-origin** (one test each); per-module freshness alerts (no false "Excel stale" after a flip); shadow switches off that module's Excel→app derivations · 1–2 weeks · Gap: D17
### T0.3b Facts layer, time-boxed
Outputs: views `fact_sales`, `fact_receipts`, `ar_ledger`, `fact_stock_moves`; the **43 non-test files** reading `erp_*` (money 10, reports 9, orders 7, erp 6, team 4, products 3, customers 2, system 1, field 1) re-pointed per module at its flip; a test fails if any view still unions Excel after T6.3 · built incrementally per module · Gap: D12
### T0.4 Reconciler [CP]
Agent spec 02 + acceptance tests: (1) ≥ 100 planted differences of every kind incl. month-end timing and the known-trap set → ≥ 98 % classified right; (2) identical data → 0, streak +1; (3) destructive sync refused; (4) Excel-derived fields excluded · 1–2 weeks · Gap: D17
### T0.5 Cleansing + FX
Outputs: fix per known trap (duplicate customer id, case-variant ProductIDs, receipts without customer id, Balance0 orphans, customer 10000 → internal stock account, Source spelling, error cells), FX rate table with valid-from; signed by the accountant · 1–3 weeks · Gap: D16
### T0.6 Tax & legal answers (start week 1; blocks T2.1 design)
Owner: accountant + external adviser (Law 12); KAD Builder prepares the question list (former "Tax Insider" agent, now a task) · Questions: (a) when must the settlement document exist for a B2B delivery today and under which article (open question; C2); (b) current excise per kg and its valid-from (C1); (c) does an office/counter cash sale or a rep's B2B cash collection need a cash-register receipt (S17 Art.380); (d) legal weight of the app's signed acts; (e) storing encrypted backups and customer data in Telegram / abroad (PD law, S25) · Fallback: no answer by week 4 → design for the stricter reading (document before goods leave; cash-register branch kept) · 2–4 weeks · Gap: D19, D20
### T0.7 Accounting program discovery
Outputs: program name, version, import format / API, who imports · before any feed estimate · 1 week · Gap: D18
### T0.8 Staging with masked production copy
Outputs: second app stack on the droplet or a cheap VM with a nightly masked copy (names/phones/TINs masked) for mock cutovers and UAT · 1 week · Evidence: S1, S8 · Gap: D16
### T0.9 Golden accounting scenarios (KAD Builder's real acceptance suite)
Outputs: ≥ 25 scenarios written with the accountant (opening balance, sale, partial payment, overpayment, return/credit note, void, period lock, reopen, month-end AR, FX purchase, landed-cost allocation, count adjustment, internal issue) → automated tests; one external human review of the T0.2 design (accountant, adviser if available) · 1–2 weeks · Gap: D15
### T0.10 Reverse export app → workbook
Outputs: for each module, rows in the exact sheet format (ORDERS, Cashflow, Purchase_IN, Inventory OB) + a one-tap download for the accountant · Success: pasted rows make Debits/Inventory formulas equal the app's numbers on staging · 1–2 weeks · Gap: D17

## P1 Cash (opening balances 2026-12-31; shadow 2027-01 incl. January month-end; flip ≈ 2027-02) → M1
T1.1 [CP] receipts posted + numbered; approval chain ends at accountant = posted (reuse `payments_cutover`, payments v2) · T1.2 [CP] full ledger: expenses, **structured salary payments** (no note-text matching), transfers, bank lines, supplier-payment placeholder · T1.3 receipts feed to books (after T0.7) · T1.4 [CP] shadow → G1 → flip; one-page release note for reps/directors ("in Excel" disappears, "Posted" appears) · bot cash reports read the app (T6.1 for cash). Gap: D5, D6, D18.
## P2 Sales, returns, debt (shadow 2027-03 incl. March month-end; flip ≈ 2027-04) → M2
T2.1 [CP] posted sale (design after T0.6): delivered + document = posted; office/counter sale; samples, write-offs, internal issues (replaces customer 10000); sale line keeps both selling channel and home channel · **T2.1b conditional**: cash-register integration if T0.6(c) says so (own estimate then) · T2.2 [CP] credit notes (numbered, AR, good stock back, feed to books) · T2.3 [CP] AR ledger: opening balance per customer at flip date + postings; aging from ledger; one aging bucket set chosen by owner · T2.4 [CP] re-point debt consumers incl. **KAD OS** (`/api/partner/balance`, `/payments`, `/payments/dispute`, `/orders`), statement/act PDFs, credit limit, tasks, Vaghinak · T2.5 plan/KPI actuals from facts · T2.6 [CP] shadow → G1 → flip; bot sales/debt reports read the app. Gap: D3, D4, D7, D10, D12, D13.
## P3 Prices & products (automated-diff shadow beside P2; flip ≈ 2027-04) → M3
T3.1 app owns prices, SKU status, HC codes, pack data; sync stops the products upsert; cost rates with source + valid-from (C1); **Platform sync and KAD OS catalog/price-list triggered by price change, not by the Excel push** · 1–2 weeks. Gap: D2, D1 (tier rule + customer id generator added here).
## P4 Purchasing + stock (decide G4 2027-04; shadow incl. June month-end; flip ≈ 2027-07) → M4
G4 first: Odoo Armenian-localisation fetch + one implementer quote vs the app estimate · T4.1 [CP] suppliers, purchase orders, shipments, FX, landed-cost allocation per shipment (S10; rates from T0.6b) · T4.2 [CP] stock ledger with locations (warehouse, vans, in transit, returns quarantine, internal), issues from posted sales, returns, count adjustments (S7), weighted average unless the accountant chooses FIFO (S5, S10) · T4.3 [CP] opening stock = full count with the **existing stock-count module**, one rehearsal count first · T4.4 [CP] shadow → G1 → flip · T4.5 supplier payables + payments (may follow if G4/time demands). Gap: D8, D9.
## P5 Payroll inputs (≈ 2027-08) → M5
Measure unmatched salary notes first; commission from facts; pay posted from the payroll screen. Gap: D11.
## P6 Exit (≈ 2027-09) → M6 = E1–E4
T6.1 bot reports migrated per module at each flip (counted in the WIP rule) · T6.2 `erp_*` tables moved to a read-only archive schema, kept forever (owner rule), admin/accountant read · T6.3 [CP] exit criteria E2 met; sync endpoint disabled; facts views simplified.

## Critical path (dependency graph)
T0.1 → T0.2a → T0.2 → T0.3 → T0.4 → T0.9 → T1.1 → T1.2 → T1.4 (cash flip) → [T0.6 done] → T2.1 → T2.2 → T2.3 → T2.4 → T2.6 (sales/AR flip) → G4 → T4.1 → T4.2 → T4.3 → T4.4 (stock flip) → T6.3. T0.3b, T0.10 and T6.1 ride along with each flip and are inside each flip's G1.

## Gates
G0 restore drill passed (DB + uploads) before any module leaves "excel". G1 as defined above. G3 T0.6 answered (or stricter-reading fallback adopted) before T2.1 design. G4 before P4: option D quote vs app estimate (06 v2 sensitivity). G5 WIP rule breached → stop starting new modules. G6 rollback window 30 days per module, then closed.

## Resources (v2 changes)
Owner: reviews only flips, G1 packs, golden-scenario results and accountant screens; ~3–5 h/week in flip weeks, ~1 h otherwise [ESTIMATE]. Accountant: 1 h/day only during her ONE shadow at a time; each flip removes her Excel task for that sheet the same day (T0.0) [ESTIMATE]. Budget: licences 0 for option A; adviser fee and second backup target cost — owner to confirm [UNVERIFIED]; AI development within the owner's existing Claude plan.
## AI layer
Reconciler (agent, spec 02 + test 4). KAD Builder (acceptance = CI + golden scenarios T0.9 + kad-edit). Vaghinak "unposted document / period not closed" nudges moved after M2. Lily feeds: receipts (P1), credit notes (P2), purchases (P4) after T0.7.
Reconciler build prompt: "You are Reconciler, a read-only reconciliation agent for the KAD Motors app. Purpose: every day, for each module whose source switch is 'shadow', compare app postings with the latest workbook sync payload and attribute every difference. Read docs/erp-sync-contract.md and kds-work/excel-off-single-erp/02-expertise.md first. Tasks: (1) per-module diff by count, AMD, litres, per customer/product; (2) classify each: app error / Excel typing error / timing ≤ 1 day / known trap (list in 05) with record ids; (3) streak and G1 status. Rules: never write to business tables; exclude Excel-derived fields; refuse and alert on any sync write to an app-owned module. Acceptance: tests 1–4 in 10-roadmap-v2 T0.4. Output: Reports > Reconciliation + one line in the 19:00 summary."

## Critique Resolution Table
| # | sev | critique item | fix applied | where in v2 | status |
|---|---|---|---|---|---|
| 1 | 🔴 | 07 durations exceed horizon | wrong reference class replaced by I4 (git history); P10/P50/P90 published; v1 range kept as P90 tail | Estimates | resolved ([SINGLE-SOURCE] internal) |
| 2 | 🔴 | 07 CP not a path | full dependency graph incl. build tasks, T0.3b/T0.10/T6.1 inside each G1 | Critical path | resolved |
| 3 | 🔴 | G1 zero-diff measures Excel typing | G1 = 100 % attributed, app errors 0 for 10 days, max 8 weeks then owner decides | Gate G1 | resolved |
| 4 | 🔴 | Reconciler circular on Excel-derived fields | shadow switches off derivations; Reconciler test 4 | How a module moves; T0.3; T0.4 | resolved |
| 5 | 🔴 | delete paths under-counted | T0.2a inventory (purge, delete-by-origin, row delete, admin delete) — verified in code | T0.2a | resolved |
| 6 | 🔴 | backups exist, real gaps differ | D14 re-rated partial; T0.1 = cron, >50 MB second target, uploads, Compose drill | T0.1 | resolved |
| 7 | 🔴 | Armenian law labelled [Proven] | 04 relabelled (see note); T0.6 blocks T2.1 design with stricter-reading fallback | T0.6, G3 | resolved |
| 8 | 🟠 | 06 B strawman / evidence per cell | B removed, D hybrid added, basis per cell | 06 v2 rescore | resolved |
| 9 | 🟠 | sensitivity too narrow, reversibility 5 false | A reversibility 4; speed weight 25 and speed 1 scenarios → tie → G4 | 06 v2, G4 | resolved |
| 10 | 🟠 | KAD Builder untestable for ledgers | golden scenarios signed by accountant + external design review | T0.9 | resolved |
| 11 | 🟠 | accountant overload | one accountant shadow at a time; flip removes her Excel task same day | WIP rule, T0.0, Resources | resolved |
| 12 | 🟠 | owner 2 h/week not credible | review scope narrowed, 3–5 h in flip weeks | Resources | resolved [ESTIMATE] |
| 13 | 🟠 | T0.2 too big, no backfill rule | split per document type; historical rows posted at migration date with prefix | T0.2 | resolved |
| 14 | 🟠 | gap-free numbers vs offline | number assigned at server posting; client_ref on phone | T0.2 | resolved |
| 15 | 🟠 | ~30 erp_* readers wrong | recounted: 43 files, by area | T0.3b | resolved |
| 16 | 🟠 | KAD OS / Platform not inventoried | I3: partner endpoints balance, payments, dispute, orders, catalog, price-list, offers, wishes; Platform via platformSync | T2.4, T3.1 | resolved |
| 17 | 🟠 | facts layer permanent complexity | time-boxed; test fails after T6.3 | T0.3b | resolved |
| 18 | 🟠 | sync guard TRUNCATE only | guard + test for TRUNCATE, upsert, delete-by-origin | T0.3 | resolved |
| 19 | 🟠 | bot migration undersized | migrated per module at each flip, counted in WIP | T6.1, P1–P4 | resolved |
| 20 | 🟠 | opening stock 1 day | locations listed; existing stock-count module; rehearsal | T4.2, T4.3 | resolved |
| 21 | ⚠️ | rollback leaves Excel empty | reverse export keeps workbook complete; 30-day rollback window | T0.10, G6 | resolved |
| 22 | ⚠️ | cash-register integration not planned | conditional T2.1b | T2.1b | resolved (conditional) |
| 23 | ⚠️ | Telegram backups = PD question | T0.6(e) before G0 | T0.6, T0.1 | resolved |
| 24 | ⚠️ | period lock vs 3-day edit window | edit window only inside open period | T0.2 | resolved |
| 25 | ⚠️ | no knowledge continuity | ADR per posting decision linked from tests | T0.2 | resolved |
| 26 | ⚠️ | "30 days zero sync" trivially met | E2: accountant confirms no entry typed + no reader | Exit criteria | resolved |
| 27 | ⚠️ | Odoo dismissed without fetch | G4: fetch + implementer quote before P4 | G4 | resolved |
| 28 | ⚠️ | staleness alerts fire falsely | per-module freshness keyed to switch | T0.3 | resolved |
| 29 | ❌ | option B | removed | 06 v2 | resolved |
| 30 | ❌ | Tax Insider as agent | became T0.6 deliverable; registry status retired | T0.6, registry | resolved |
| 31 | ❌ | S22, S29 padding | retired in register (kept ids, notes "retired: no decision") | 03 | resolved |
| 32 | ❌ | Vaghinak nudges premature | moved after M2 | AI layer | resolved |
| 33 | ➕ | program exit criteria missing | E1–E4 | top | resolved |
| 34 | ➕ | staging/masked copy | T0.8 | T0.8 | resolved |
| 35 | ➕ | role matrix | in T0.2 (roles.js named rules + tests) | T0.2 | resolved |
| 36 | ➕ | UAT + performance | UAT inside G1; ledger queries added to the speed-budget test per flip | G1 | resolved |
| 37 | ➕ | erp_* archive plan | read-only schema, forever, admin/accountant | T6.2 | resolved |
| 38 | ➕ | budget numbers | ranges only where a basis exists; adviser fee + backup target cost open | Resources, Open questions | open |
| 39 | ➕ | training/communication per flip | one-page release note per flip | T1.4 (pattern for all flips) | resolved |
Also applied (🟡/🔵): 04 labels fixed; Reconciler sample ≥ 100; D7 → partial; D8 reuse stock counts; G4 text unified; T0.6 week-1 start + fallback; accounting discovery T0.7; FX table; S20 tier T3; accountant named by role; T0.0 first; Yerevan month; measure unmatched salary notes.
