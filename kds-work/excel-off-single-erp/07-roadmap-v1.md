# 07 — Roadmap v1 (Phase 8) — excel-off-single-erp (Option A)
No fixed end date (owner). Durations are ranges; no sourced reference class exists for a one-developer, phone-reviewed ERP build → all marked [ESTIMATE — no reference class] unless stated. WIP limit: ≤ 2 modules in shadow at a time.

## P0 Foundations → M0: backups proven, posting model live, switch + Reconciler running on cash
### T0.1 Off-site encrypted backups + restore drill [CP]
Owner: KAD Builder; owner runs the deploy block · Inputs: deploy/backup.sh, docs/backup-restore.md · Outputs: nightly encrypted dump to a second location (Telegram group per KAD OS precedent or object storage), restore script, drill log
Success: restore of last night's dump into a scratch DB passes row-count + checksum check; RPO ≤ 24 h, RTO ≤ 4 h · Duration: 1–2 weeks [ESTIMATE] · Gate: G0 · Risk: secrets in backup → encrypt, key off-server · Evidence: S9 · Gap: D14
### T0.2 Posting model [CP]
Owner: KAD Builder · Outputs: `posted_at` + document number per type (sale, credit note, receipt, stock move, purchase), void/reverse instead of delete (remove admin hard delete of posted orders), period lock setting (month closed by accountant), audit log reused
Success: tests prove a posted record cannot be deleted or edited in a locked period; numbers gap-free per type · 3–5 weeks [ESTIMATE] · Evidence: S6, S13, S14, S28 · Gap: D15
### T0.3 Per-module source switch + sync guard [CP]
Outputs: App configuration "Source of truth" per module (excel / shadow / app); `/api/erp-sync` refuses to write a module set to app (logs + alert); staleness alerts follow the switch · Success: test — push of order_lines while sales=app → rejected, data intact · 1–2 weeks [ESTIMATE] · Evidence: I2 trap 16 · Gap: D17
### T0.3b Facts layer
Outputs: SQL views `fact_sales`, `fact_receipts`, `fact_stock_moves`, `ar_ledger` that read Excel or app tables by switch; consumers re-pointed one by one · Success: architecture test — no new code reads erp_* directly · 2–4 weeks [ESTIMATE] · Gap: D12
### T0.4 Build Reconciler [CP]
Owner: KAD Builder (Agent spec 02) · Success: acceptance tests 1–3 · 1–2 weeks [ESTIMATE] · Gap: D17
### T0.5 Master-data cleansing with the accountant
Outputs: list of the 16 traps (I2) with a fix per item (duplicate id, case-variant ProductIDs, receipts without customer, Balance0 orphans, customer 10000) signed by the accountant · 1–3 weeks · Gap: D16
### T0.6 Tax questions answered
Owner: Tax Insider drafts, accountant + adviser answer (Law 12) · Outputs: answers on C1 excise, C2 document timing, B2B cash register, e-document weight, PD law · 2–4 weeks [ESTIMATE] · Gap: D19, D20
### T0.7 Accountant workflow study
Owner: owner + accountant · Outputs: every Excel task today, minutes/day, which app screen replaces it · 1 week · Gap: D21

## P1 Cash → M1: customer receipts and the cash ledger are app-owned (Cashflow sheet read-only)
- T1.1 Receipts: number, approval chain ends at accountant = posted; "in Excel" checks replaced by internal posting (reuse `payments_cutover`) — 2–3 weeks
- T1.2 Full ledger: expenses, structured salary payments, transfers, bank lines, supplier payments placeholder; Excel rows become app-owned at opening date — 3–5 weeks
- T1.3 Feed receipts to the books (Lily endpoint) — 1–2 weeks
- T1.4 [CP] Shadow run → Gate G1 (20 working days zero diff incl. one month-end) → flip cash=app
## P2 Sales, returns, debt → M2: AR ledger app-owned; ORDERS + Debits sheets read-only
- T2.1 Posted sale = delivered order with document; office/counter sale; samples, write-offs and internal issues (replaces customer 10000) — 3–5 weeks
- T2.2 Credit notes (numbered, reduce AR, feed books) — 2–3 weeks
- T2.3 [CP] AR ledger: opening balance per customer at switch date + postings; aging from ledger — 3–4 weeks
- T2.4 Re-point all debt consumers through `ar_ledger` (credit limit, tasks, Vaghinak, KAD OS, PDFs) — 2–4 weeks
- T2.5 Plan/KPI actuals from fact_sales / fact_receipts — 1–2 weeks
- T2.6 [CP] Shadow → G1 + G3 (tax answers in hand) → flip sales=app, debt=app
## P3 Products & prices → M3: prices and SKU lifecycle app-owned
- T3.1 Prices/status/HC owned by app; sync stops writing them; cost rates with valid-from + source — 1–2 weeks → shadow → flip
## P4 Purchasing + stock → M4: Purchase_IN + Inventory sheets read-only
- T4.1 Suppliers, purchase orders, shipments, landed-cost allocation per shipment (S10, C1) — 4–8 weeks
- T4.2 [CP] Stock ledger: receipts, issues from posted sales, returns, count adjustments (S7), weighted-average valuation (S5/S10; method = accountant decision) — 4–6 weeks
- T4.3 Opening stock = full physical count on switch date — 1 day + preparation
- T4.4 [CP] Shadow → G1 → flip
- T4.5 Supplier payables + payments — 2–4 weeks (gate G4: may follow later)
## P5 Payroll inputs → M5: commission and paid amounts from app data — 1–2 weeks
## P6 Exit → M6: success criterion 2
- T6.1 Bot reads app API for Telegram reports (start right after P0) — 3–5 weeks
- T6.2 "Excel export" button per module for the accountant
- T6.3 [CP] Sync off; erp_* tables archived read-only; 30 days zero sync calls

## Critical path
T0.1 → T0.2 → T0.3 → T0.4 → T1.4 → T2.3 → T2.6 → T4.2 → T4.4 → T6.3
## Gates
G0 no module leaves "excel" before a restore drill passed. G1 per module: ≥ 20 consecutive working days zero diff incl. one month-end + accountant sign-off. G3 tax answers (T0.6) before P2 flip. G4 if P4 is not in shadow within 3 months of P2 flip → split payables out. G5 > 2 modules in shadow → stop starting new ones.
