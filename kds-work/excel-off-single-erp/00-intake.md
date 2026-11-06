# Intake — Excel off: the KAD Motors app as the single, complete operational ERP
Goal (one sentence): The owner of KAD Motors wants every business record (sales, deliveries, returns, cash, debts, stock, purchasing/imports, prices, plan, payroll calculation) typed directly into the KAD Motors app instead of the Castrol Excel workbook, switching the Excel → bot → `/api/erp-sync` pipeline off module by module, so that the app is the one operational system of record and the accountant's program only keeps the books.
Date: 2026-11-06 · Depth: standard · Deliverable language: English (owner wrote in English; app texts stay hy + en)

## Owner answers (AskUserQuestion, 2026-11-06)
- Deadline: **module by module, no fixed date** — each Excel sheet is switched off once its app module passes its check.
- Accounting: **stays outside** — the app is the single OPERATIONAL system; the accountant's program keeps ledger / VAT / tax filings, fed automatically (Lily path).
- Cutover style: **side by side, then switch** — Excel and app both kept for a period, the app compares totals daily, switch off only after N days with zero difference.
- Priorities: **zero data loss first**.

## Success criteria (measurable; proposed by KDS from the answers — owner may change N)
1. For each module M (cash, sales/orders, returns, stock, prices, purchasing/landed cost, plan, payroll): the app's daily reconciliation report shows **0 AMD difference** against the workbook for **≥ 20 consecutive working days** (≈ one month-end close included) before M's sheet stops being synced; any difference > 0 restarts the count.
2. After the last module: `POST /api/erp-sync` receives **0 calls for 30 days** while every Reports / Debt / Home / Vaghinak / Platform / KAD OS number still appears, and the bot's Telegram reports are produced from the app's data.
3. Each business event is typed **once** (count of manual copies of one cash number: 4 today → 1), and every posted record has an audit trail (who, when, before/after) with no hard delete.
4. The external accounting program receives every confirmed sale, return, receipt and purchase from the app automatically; month-end reconciliation app ↔ books differs by 0 AMD, signed off by the accountant.

## Priorities (100 points)
risk 35 · quality 25 · speed 15 · reversibility 15 · cost 10 (owner chose "zero data loss first")

## Current state (from repos and skills, 2026-11-06)
- Field Visits app 1.523.0 (Node 22 / Express / Postgres / vanilla PWA), on a DigitalOcean droplet; CEO bot (Python) on the same droplet reads the workbook posted to Telegram and syncs customers, order_lines, cashflow_lines, sales_performance, products, brand_volume, reports.
- App already records natively: visits, orders (draft→confirmed→packed→delivered with signed act), payments + cash custody chain, returns requests, tasks, staff/pay rules, route plans, documents, cashflow rows (manual add allowed), price edits with history, landing-cost calculation. Excel is still the trusted source for debt, sales, plan, prices, HC codes, stock, cash ledger.
- Team: owner (non-programmer), accountant (Mane), sales director, reps, warehouse, drivers; one developer = Claude.

## Constraints
- No business data / secrets in repo, chat or docs. Deploy = one SSH command block. Every change: kad-edit review, version bump, CI green, squash-merge.
- Accounting/tax decisions are the accountant's (Law 12).

## Geography / market
Armenia; languages hy (Armenian) + en (+ ru for some sources); currency AMD; regulators: State Revenue Committee (tax, e-invoicing, cash registers), Personal Data Protection Agency; country is an EAEU member.

## Freshness overrides
- Software-engineering / ERP-implementation frameworks: ≤ 10 years (stable practice), older peer-reviewed classics allowed with `[DATED — verify]` only if superseded.
- Spreadsheet-error research: classic studies allowed (findings replicated since; noted per row).

## What I need from you — status
- Latest workbook structure (sheet list, who types what) · partial (Castrol-file skill) · repo skill
- Who in the team types each Excel sheet today and how often · no · owner/accountant
- Name of the accounting program and whether it imports files / has an API · no · accountant
- Does KAD Motors issue e-invoices / e-waybills itself or does the accountant do it in the accounting program · no · accountant
- Purchasing today: who creates supplier orders, where import costs (freight, customs, excise) are recorded · partial · accountant
- Opening-balance date preference per module · no (default: first day of the month the module starts its side-by-side run)

## Open questions from intake
- N (days of zero difference) = 20 working days proposed; owner may choose 10 / 20 / 30.
