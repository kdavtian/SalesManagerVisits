# 02 — Expertise map (Phase 3) — excel-off-single-erp

Registry checked: `kds-agents/registry.md` did not exist in this project → new registry created. Reusable existing assistants in the app: **Vaghinak** (AI ops deputy, anti-fraud, tasks) and **Lily** (accountant agent, documents to the accounting program).

| role / skill | decision (rule #) | reason |
|---|---|---|
| ERP product owner (owner) | LEARN (3) | decides every switch; needs ~10 h to read reconciliation reports and go/no-go criteria |
| Chief accountant / financial director (Mane) | HIRE-in-place (1) | licensed-type decisions (VAT, settlement documents, opening balances, period close) — already employed; time must be allocated |
| Armenian tax / legal adviser | HIRE (1) | confirm C1/C2, e-document legal weight, cash-register scope for B2B field collection, PD law — 4–8 h engagement |
| Software engineer (sole developer) | AGENT (2): **KAD Builder** = Claude with KADDev + kad-edit | public knowledge, repeatable, every change reviewed + CI + owner sees it before merge |
| Data-migration / reconciliation analyst | AGENT (2): **Reconciler** | repeatable daily diff; low liability (reports only, never edits data) |
| Domain expert (Armenian tax & document rules) | AGENT (2) for preparation: **Tax Insider**; decision stays with accountant/adviser (Law 12) | drafts questions + checklists from S17; never decides |
| Warehouse lead (stock counts, receiving) | LEARN (3) | daily; counting procedure learnable in a few hours (S7) |
| Sales director (custody, approvals) | LEARN (3) | already uses the app; new screens only |
| Internal-control reviewer | LEARN + AGENT (5) | owner learns segregation-of-duties basics (S28); Vaghinak runs detectors |

## Role notes (real-world experience)
### Chief accountant
Knowledge: Tax Code settlement documents (S17 Art.55–56), VAT, retention (S17 Art.33), accounting program, the workbook (I2).
Daily routine today (kadprocesses §3.3, I2): receives paper cash lists (photo) → types Cashflow + ORDERS → posts workbook to Telegram → Lily issues waybills/invoices → answers reps' "not in Excel" questions.
Pains: four hand copies of each cash number; re-typing orders the app already holds; formula errors (#NAME?, unit bug) → "Debits Risk=High" on every row (I2).
Likes/hates [UNVERIFIED — ask]: likely hates double entry during the side-by-side period → the plan must cut her Excel work, not add to it (see T1.x "Excel export").
Quality judgement: month-end ties to the books to 0 AMD; nothing posted can silently change.
Decision: HIRE-in-place (rule 1). Allocation: ~2 h/week for reviews + 1 h/day during each module's side-by-side.

### Armenian tax / legal adviser
Role spec: licensed tax consultant or audit-firm tax partner; deliverable = written answers to the Tax Insider question list (≤ 2 pages). Where to find: audit firms with Armenian tax practices (EY/PwC/KPMG/Grant Thornton Armenia have tax alert pages — S27 is PwC) or the accountant's own adviser. Budget: [ESTIMATE — no reference class] a few hours of consultant time; owner to confirm fee. Selection test: ask "must a waybill exist before goods leave the warehouse after 2026-09-01, and under which article?" — a strong answer cites the article and amending law (C2).

## Agent specs
### Agent: Reconciler
Role: compares app data with the workbook per module every day and explains every difference.
Knowledge: I1 table map, I2 sheet map + 16 data traps, S1 go/no-go, S2 migration data classes.
Tasks: (1) daily per-module diff (count, sum AMD, litres, per customer/product) → table; (2) classify each difference: app-only, Excel-only, amount mismatch, timing (≤ 1 day), known trap → with record ids; (3) streak counter "consecutive zero-difference working days" per module.
Inputs: app DB (read-only), latest workbook sync payload. Outputs: Reports > Reconciliation page + 19:00 summary line.
Boundaries: never edits either side; never closes a difference itself; a module's switch is flipped only by admin.
Acceptance tests: 1) seeded test DB with 10 planted differences of 5 kinds → reports all 10, classes ≥ 9 correct; 2) identical data → reports 0 and streak +1; 3) a sync that would TRUNCATE an app-owned module → refused and alerted.
Build prompt: see 10-roadmap-v2 §AI layer.

### Agent: Tax Insider
Role: prepares Armenian tax/document questions and checklists for the accountant and adviser.
Knowledge: S17 (Art.33, 55, 56, 88, 380–381), S18, S31, C1–C3.
Tasks: (1) for each module, list the settlement documents it creates or affects → checklist; (2) question list for the adviser with article refs; (3) review a module design: which fields a tax invoice/consignment note needs.
Boundaries: never states a rule as final; every item ends "to confirm: accountant/adviser"; no advice to customers.
Acceptance: 1) 15 questions with article refs, accountant confirms ≥ 12 are relevant; 2) for the sales module, lists every Art.55 document type the module touches; 3) refuses "decide if we need a cash register" → escalates.

### Agent: KAD Builder (exists: Claude + KADDev + kad-edit)
Acceptance per step: CI `test` + `e2e-smoke` green; kad-edit five-block verdict; owner screenshot check; version bump.
