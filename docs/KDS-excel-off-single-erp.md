# KDS — Excel off: the KAD Motors app as the single, complete operational ERP
Depth: standard · 2026-11-06 · English · Sources: 31 (T1 21 / T2 2 / T3 4 / T4 4) · Fetch-verified: 18 · Working files: `kds-work/excel-off-single-erp/`

> **Licensed-profession notice.** This document prepares material for decisions that legally require a licensed professional in Armenia: the company's chief accountant and an Armenian tax / legal adviser (settlement documents, VAT, excise, cash-register scope, personal data, opening balances, period close). KDS and the agents it specifies may draft, summarise and check; they do not decide, certify, sign or advise in a regulated sense. The people named in section 10 must review those items before action. Nothing here is legal, tax or investment advice.

## 1. Executive summary
- **Goal:** every business record is typed once, directly in the KAD Motors app. The Excel → bot → `/api/erp-sync` pipeline is switched off module by module, and the accountant's program only keeps the books.
- **Verdict:** doable, but the danger is not the code. It is (a) deciding to switch before backups and the posting rules are safe, and (b) side-by-side periods that end up measuring Excel's typing errors instead of the app's.
- **Chosen path:** Option A, a "strangler" built inside the app. Each module goes Excel → side-by-side → app, controlled by a per-module "source of truth" switch, a Reconciler (an agent that compares the app with Excel every day), a go/no-go gate (G1) and a 30-day rollback window. It scores 370/500, ahead of a hybrid with a bought stock module (325) and a full ERP purchase (285). Gate G4 re-checks the hybrid before purchasing and stock are built.
- **Order:** P0 foundations (until 31 Dec 2026) → cash (side-by-side in January 2027) → sales, returns and debt (March) → prices (together with sales) → purchasing and stock (June) → payroll → exit. Most likely finish: September 2027 (best case June 2027, worst case March 2028).
- **Biggest risk:** the droplet holds the only copy of the books while backups are not yet scheduled and files over 50 MB are not copied.
- **First action:** finish the backups and run a restore drill (T0.1), and close every path that can delete a posted record (T0.2a). Both are needed before anything leaves Excel.

## 2. Success criteria & priorities
| # | Exit criterion |
|---|---|
| E1 | Every module has passed gate G1 and been switched to the app. |
| E2 | For 30 days the accountant confirms no business entry was typed in the workbook, nothing reads the workbook, and the sync is disabled. |
| E3 | Each event is typed once (one cash number: 4 copies today → 1). |
| E4 | At month-end, app and accounting program differ by 0 AMD, signed off by the accountant. |

**Gate G1 (per module).** All of these must hold:
- the side-by-side period covers at least one month-end and at least 20 working days;
- 100 % of differences are explained;
- zero errors on the app's side for the last 10 working days;
- the accountant's test cases ("golden scenarios") pass;
- the accountant has tested the module (UAT) and signed it off.

If the side-by-side period runs longer than 8 weeks, the owner decides what happens next.

**Priorities:** risk 35, quality 25, speed 15, reversibility 15, cost 10. Answers in force: switch off module by module with no fixed date; accounting stays in the outside program; run side by side, then switch.

## 3. Ideal Baseline
**[Proven]**
- Migration data has two classes, master data and open transactions (open orders, stock on hand, open balances), and each needs its own plan and check (S2).
- Inventory cost includes all purchase costs (duties, transport); interchangeable goods use FIFO or weighted average (S10, S5, S15).
- Perpetual inventory records every movement as it happens; stock counts are posted as adjustments (S15, S7).

**[Expert consensus, one vendor, T1]**
- A cutover plan names an owner for each task and includes sign-off steps, a rollback plan, go/no-go criteria and a dress rehearsal (S1, S3, S8).
- Posting is locked to an allowed period (S6).
- Disaster-recovery plans are tested and written down (S9).

**[Expert consensus]**
- Correct a record with a reversing entry and never rewrite history (S13, S14).
- Spreadsheet cell errors are routine; lab studies average 3.9 % (S11, S12).

**[UNVERIFIED — adviser to confirm]** Armenian Tax Code (S17, official translation, amended to March 2025):
- settlement documents are electronic and are issued when goods are supplied (Art. 56);
- records are kept at least 5 years (Art. 33);
- excise on lubricating oil is 550 AMD/kg (Art. 88);
- a cash-register receipt is required for retail sales (Art. 380).

**Hidden traps found in the code and workbook:**
- the sync wipes and replaces whole tables;
- "From ERP" and "in Excel" statuses are copied from Excel, which makes comparisons circular;
- the test-user purge and the Excel cash delete can remove posted money;
- customer 10000 is really an internal stock account;
- old orders are re-priced when a customer's tier changes;
- the excise rate in the workbook (682 AMD/kg) differs from the Tax Code text (550).

## 4. Gap Analysis
| domain | rating | key gap |
|---|---|---|
| Customers | partial | Tier is overwritten by every sync; no ERP-id generator |
| Products & prices | partial | the sync re-applies prices, stock and status even after a manual edit |
| Sales documents | partial | revenue truth is the ORDERS sheet; no "posted" state; delivered orders can be hard-deleted |
| Returns | partial | no credit-note number, no stock effect, no feed to the books |
| Receipts & cash custody | partial (strongest) | "in Excel" checks; `payments_cutover` already exists |
| Cash ledger | partial | Excel rows are deleted and re-imported on every push |
| Debt / AR | partial (comes from Excel) | no ledger owned by the app; 43 files read the `erp_*` tables |
| Stock | missing | snapshot only; no stock movements |
| Purchasing / imports | missing | no tables at all |
| Plan / KPI | partial | actuals come from Excel |
| Payroll | partial | "paid" amounts are matched by note text |
| Backups | partial | no cron yet; files over 50 MB are skipped |
| Posting controls | partial | no period lock; several delete paths |
| Reconciliation + source switch | missing | — |
| Feed to the books | partial | Lily sends sales only |
| Tax documents / personal data | partial, UNVERIFIED | — |
| People / change | missing | the accountant still types two sheets daily |

Full table: `kds-work/excel-off-single-erp/01-gap.md`.

## 5. Expertise Map
| role | decision | reason |
|---|---|---|
| Owner | LEARN (rule 3) | decides each switch from the G1 pack |
| Chief accountant | HIRE-in-place (rule 1, licensed-type decisions) | golden scenarios, sign-offs, period close |
| Armenian tax / legal adviser | HIRE (rule 1) | 4–8 h on the T0.6 questions |
| Developer | AGENT: KAD Builder (Claude with KADDev and kad-edit) | its real acceptance test = CI + accountant-signed golden scenarios |
| Reconciliation analyst | AGENT: Reconciler | spec, 4 tests and build prompt in section 10 |
| Warehouse lead, sales director | LEARN (rule 3) | new screens and count procedure |

The planned "Tax Insider" agent was retired and turned into task T0.6.

## 6. Problems, Solutions & Hidden Stones
**Pre-mortem: 12 failure reasons → warning sign → fix** (full table in `05-problems.md`):
1. Lost database with no tested backup → T0.1 and gate G0.
2. A stale workbook push wipes app data → per-module sync guard covering all three write patterns.
3. The accountant keeps Excel because the app takes more steps → T0.0 time study; each switch removes her Excel task the same day.
4. Re-priced history never reconciles → compare only from the opening date.
5. Wrong opening balances → T0.5 cleansing list, signed.
6. Stale excise and duty rates → rates with a valid-from date; question to the adviser.
7. Tax documents issued late → T0.6 with the stricter reading as the fallback.
8. Posted records deleted → T0.2a and T0.2.
9. Half-Excel, half-app reports → time-boxed facts layer.
10. Purchasing and stock too large → G4 (hybrid option).
11. Bot reports die when Excel stops → the bot moves to app data module by module.
12. One developer and one reviewer → the work-in-progress rule (one side-by-side for the accountant at a time).

**Buy instead of build?** Odoo has perpetual stock valuation (S15), but its Armenian localisation is UNVERIFIED and it would mean a second system. ArmSoft and 1C keep the books but are not a field ERP (S30, T4). Decided at gate G4.

## 7. Options scored
| option | total /500 |
|---|---|
| **A. Strangler in the app** | **370** |
| D. Hybrid with a bought stock / purchasing module | 325 |
| C. Buy a full ERP core | 285 |

- Option B (big bang) was removed as a strawman.
- **Trade-off:** A never bets debts or stock on a single day, but takes longer than buying.
- **Sensitivity:** if the program runs past 18 months and speed weighs 25, A and D tie. That is gate G4.

## 8. Roadmap v2 (final)
See `kds-work/excel-off-single-erp/10-roadmap-v2.md` for every task in full (owner, inputs, outputs, success, duration, risk, evidence). Overview:

**P0 Foundations** (9 Nov → 31 Dec 2026)

| task | what |
|---|---|
| T0.0 | Accountant time study |
| **T0.1** | Backups: cron, a second target for files over 50 MB, uploads included, restore drill (gate G0) |
| **T0.2a** | Close every delete path: test-user purge, Excel cash delete, row delete, admin order delete |
| **T0.2** | Posting model per document type: server numbering at posting, void/reverse, Yerevan-month period lock, role matrix, decision records |
| **T0.3** | Source switch per module, sync guard ×3 write patterns, per-module freshness alerts, Excel-copied statuses off during side-by-side |
| T0.3b | Facts layer that re-points the 43 readers, deleted at exit |
| **T0.4** | Reconciler (≥ 100 planted differences) |
| T0.5 | Data cleansing + exchange-rate table |
| T0.6 | Tax and legal answers (blocks the T2.1 design) |
| T0.7 | Find out the accounting program and its import format |
| T0.8 | Staging copy with names, phones and tax IDs masked |
| T0.9 | ≥ 25 golden scenarios signed by the accountant |
| T0.10 | Export from the app back into the workbook's sheet format (keeps Excel formulas working and makes rollback possible) |

**P1 Cash.** Opening balances at 31 Dec 2026, side-by-side in January 2027 → switch about February.
- Receipts are posted and numbered.
- Full cash ledger, including structured salary payments.
- Receipts are sent to the books.

**P2 Sales, returns and debt.** Side-by-side in March → switch about April.
- Posted sale.
- Office/counter sale and internal stock issues.
- Conditional cash-register branch (only if the adviser says one is needed).
- Credit notes.
- Debt ledger owned by the app.
- Every debt reader re-pointed, including KAD OS (balance, payments, dispute, orders) and PDFs.
- KPI actuals.

**P3 Prices.** Automated side-by-side alongside P2.
- The app owns prices, SKU status and HC codes.
- The Platform and the KAD OS catalog update on a price change instead of on the Excel push.

**P4 Purchasing and stock.** Gate G4 in April, side-by-side over the June month-end → switch about July.
- Suppliers, purchase orders, shipments, exchange rates and landed cost.
- Stock ledger with locations.
- Opening stock from a full count with the existing count module, after a rehearsal.
- Supplier payables can follow later.

**P5 Payroll inputs** (about August).

**P6 Exit** (about September). Bot reports move as each module switches; the `erp_*` tables go into a read-only archive; criteria E1–E4.

**Critical path:** T0.1 → T0.2a → T0.2 → T0.3 → T0.4 → T0.9 → P1 switch → [T0.6] → T2.1 → T2.2 → T2.3 → T2.4 → P2 switch → G4 → T4.1 → T4.2 → T4.3 → P4 switch → T6.3.

**Gates:**
- **G0:** restore drill passed.
- **G1:** per module (section 2).
- **G3:** tax answers in hand, or the stricter reading adopted.
- **G4:** hybrid quote compared before P4.
- **G5:** work-in-progress rule (one accountant side-by-side at a time).
- **G6:** 30-day rollback window per module.

## 9. Critique Resolution Table
All 39 critical, major, hidden-risk, remove and missing items: 38 resolved, 1 open (budget figures). Full table: `10-roadmap-v2.md` § Critique Resolution Table.

## 10. Resources & AI Layer
**People:**
- Owner: about 3–5 h a week in switch weeks, about 1 h otherwise.
- Accountant: 1 h a day during her one side-by-side period.
- External tax adviser: 4–8 h.
- Warehouse, sales director and drivers: 1 h of training per switch.

**Tools:** the existing stack, no licences. Backups need a second storage target. The Odoo stock module is the fallback (G4).

**AI layer:**
- **Reconciler** (new): build prompt in `10-roadmap-v2.md`.
- **KAD Builder:** Claude with KADDev and kad-edit; accepted only when CI and the golden scenarios pass.
- **Vaghinak:** "unposted document" and "period not closed" nudges, after the debt switch.
- **Lily:** feeds for receipts, credit notes and purchases to the books.
- **CEO bot:** reads the app instead of the workbook.

**Budget:** licences 0. Adviser fee, backup storage and AI usage are open (no figures without a basis).

## 11. What I need from you
1. Who types each Excel sheet and how long it takes (T0.0, with the accountant).
2. The accounting program's name and how it imports data (T0.7).
3. An adviser to answer T0.6, or the accountant's own adviser.
4. Where the second backup copy should live (DigitalOcean Spaces, a second server, or similar) and the encryption-key holder.
5. Your OK on the proposed G1 gate and the 30-day rollback window.

## 12. Improvement Ideas
- **Faster:** start the cash side-by-side on 1 January 2027 with a 31 December opening balance. The year boundary gives a natural month-end and a clean cut. Trade-off: P0 must be done in about 7 weeks.
- **Cheaper:** no ERP licence. Reuse `payments_cutover`, the stock-count module, Lily and Vaghinak instead of building new ones. Trade-off: more design work for KAD Builder.
- **More robust:** a monthly automated restore drill that posts its result to Settings > System health. Trade-off: a little droplet time each month.
- **More ambitious** [KDS recommendation]: once the debt ledger is the app's, let KAD OS customers see and confirm their statement each month (the customer becomes a control). Trade-off: a customer-facing feature with its own risk review.
- **More automated:** have Reconciler explain each difference in Armenian in the 19:00 summary and open a task for whoever caused it (rep, accountant). Trade-off: more notifications; keep it to one line.

## 13. Confidence & gaps
**Overall confidence: medium.** Architecture and sequence rest on official T1 practice sources and on code facts I checked myself. The calendar rests on one internal reference case (this repo's git history: 50 PRs in 8 days; the payments redesign took 2 days). The Armenian document rules wait for the adviser.

**Weakest claims:**
1. The September 2027 most-likely finish.
2. When the settlement document must exist after 2026-09 (conflict C2).
3. The excise rate used for landed cost (conflict C1).

**Verify later** (sites the session could not open):
- petekamutner.am (SRC)
- the e-invoicing API (S24)
- the 2019 Law on Accounting (S31)
- the personal data law (S25)

## 14. Open questions
1. **G1 gate:** do you accept "100 % of differences explained and zero app errors for 10 days" instead of "zero difference", given that Excel itself carries typing errors? (Recommended: yes.)
2. **Rollback window:** 30 days per module, then Excel for that sheet is closed for good? (Recommended: 30.)
3. **Second backup target:** DigitalOcean Spaces, a second server, or something else, and who holds the encryption key?
4. **Adviser:** do you have a tax adviser, or should the accountant ask hers?
5. **Stock valuation:** weighted average (recommended, simpler) or FIFO? This is the accountant's call.
6. **Aging buckets:** the bot uses 0-7/8-14/15-30/30+ and the app uses 0-30/31-60/61-90/91-180/180+. Which single set should be kept? (Recommended: the app's.)
7. **Budget:** the adviser fee and backup storage cost (open critique item 38).
8. **Unverified facts:** C1 excise rate, C2 document timing, B2B cash register, backups in Telegram under the data-protection law. All go to T0.6.


## Appendix A: Roadmap v1

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

## Appendix B: Brutal Critique

Isolation: fresh subagent; received only files 01-08 + brutal-critic.md

# 09 — Brutal critique (Phase 9, standard mode) — excel-off-single-erp

Method: files 01–08 read cold; claims about the current system checked against the code in `SalesManagerVisits` (version.js 1.523.0, 188 migrations) and `castrol_ceo_report` main on 2026-11-06. Code checks are marked **[code]** with the file that proves them. No intake, no conversation, no KADDev context was used.

## 1. 🔴 Critical Failures (must fix immediately)
- 🔴 `07 Critical path` + `07 all durations`: summed build ranges of every task are ~44–78 single-developer weeks BEFORE any shadow period (P0 12–23, P1 6–10, P2 11–18, P4 10–18, P6 3–5), and the CP adds 4 shadows of ≥20 working days plus 30 days exit; the pre-mortem horizon in `05` (2027-12, ~13 months) is therefore already blown on paper. Fix: sum the plan honestly, publish a P10/P50/P90 total, and cut scope (e.g. P4 payables, P5) or re-open option C for stock/purchasing.
- 🔴 `07 Critical path`: it is not a path — T1.4/T2.6/T4.4 shadows cannot start without T1.1–T1.2, T2.1–T2.2, T4.1 which are omitted, and T0.3b facts layer + T2.4 re-pointing are off the CP although `05 #9` names half-Excel/half-app reports as a top failure. Fix: rebuild the CP as a dependency graph that includes every build task a gate needs.
- 🔴 `07 G1` (zero diff for 20 consecutive working days incl. a month-end): the Excel side is hand-typed with documented formula errors and 16 data traps (`01 D16`, `03 S12`), so "zero diff" measures the accountant's typing, not the app; the gate is either never met or met by "fixing" Excel to match. Fix: replace with "every difference classified and attributed, app-side errors = 0, Excel-side errors logged", plus a hard cap on shadow length followed by an owner decision.
- 🔴 `02 Reconciler` + `07 T1.4/T2.6` circularity: **[code]** the app already derives order "delivered" status from Excel ORDERS matches ("From ERP" auto-deliver, `01 D3`) and payment "in Excel" status from Excel rows (`01 D5`); a diff of app vs Excel on fields that were copied from Excel produces false zero-difference streaks. Fix: in shadow, switch off every Excel-to-app derivation for that module and exclude Excel-derived fields from the diff; add this as Reconciler acceptance test 4.
- 🔴 `01 D15` + `07 T0.2`: hard-delete paths are under-counted — **[code]** `server/src/team/userPurge.js` deletes orders, customer_payments, payments and cash handoffs of any user whose NAME matches /test/ (renaming a real user makes posted money deletable), and `server/src/money/cashflow.js:154` deletes all `origin='excel'` cash rows on each push. Fix: T0.2 must start with a grep inventory of every `DELETE FROM` on posting tables and block each one for posted records, purge included.
- 🔴 `01 D14` + `07 T0.1`: D14 is rated "missing" and T0.1 is scoped as a build, but **[code]** `deploy/send-backup-telegram.sh` already ships encrypted (7z/AES) backups to Telegram; the real gaps are cron, restore drill on the Docker Compose shape (`docs/backup-restore.md`), and the 50 MB Telegram bot upload cap that the DB plus the uploads (photos/POD) volume will exceed — oversize files are skipped. Fix: re-rate D14 "partial", re-scope T0.1 to cron + size alarm + second target for files > 50 MB + drill log, and include the uploads volume in G0.
- 🔴 `04 Principles` (Armenian law marked [Proven]) + `03 C2`: the Tax Code text is a translation that `03` itself says "may lag later amendments", the timing rule conflicts with a T4 source, and the PD-law and cash-register items are UNFETCHED — calling this [Proven] fails Law 4, while `07 T2.1` (posted sale = delivered order) depends on the answer. Fix: downgrade to [UNVERIFIED — adviser], and make T0.6 a blocking input to T2.1 design, not only to the P2 flip (G3).

## 2. 🟠 Major Weaknesses
- 🟠 `06 scoring`: every score is the author's own [ESTIMATE]; B is a strawman (one date, 8 weeks — no one proposed that) and C is excluded by "accounting stays outside" although C was scoped as stock/purchasing/AR, not books. Fix: add option D (hybrid: app keeps cash + sales + AR, buy/rent a stock-purchasing module) and score with written evidence per cell.
- 🟠 `06 Sensitivity`: only two cells are perturbed; A's reversibility 5 is false after P2 (once AR is app-owned, switching back requires back-filling Excel), and speed weight 15 hides a 1–2 year program. Fix: rerun sensitivity on reversibility (A=3) and speed weight 25.
- 🟠 `02 KAD Builder` (AGENT, rule 2 "public knowledge, repeatable, low liability"): designing a posting model, AR ledger and stock valuation is neither repeatable nor low-liability, and the acceptance tests (CI green, owner screenshot) cannot detect a wrong ledger. Fix: add accountant-signed golden scenarios (posting, void, credit note, period lock, month-end AR) as a test suite, plus one external human review of the T0.2 design.
- 🟠 `02 Chief accountant` + `08 People`: 2 h/week + 1 h/day per shadow, with up to 2 shadows at once (`07 G5`), on top of the Excel typing she still does — the plan adds work, contradicting its own claim in `02` ("must cut her Excel work"). Fix: cap concurrent shadows touching her at 1 and remove one Excel task per shadow on day 1.
- 🟠 `08 Owner ~2 h/week`: the owner decides every switch, reviews dozens of ledger PRs on a phone and runs every deploy; 2 h/week is not credible. Fix: estimate from PR count per phase and state what the owner will NOT review.
- 🟠 `07 T0.2` (3–5 weeks): retrofitting `posted_at`, gap-free numbers, void/reverse and period lock across orders, payments v2, returns, cash and future stock — with existing rows to backfill — is a multi-table migration; no backfill rule for historical records is stated. Fix: split T0.2 per document type, define "historical rows = posted at migration date, numbered with prefix", and estimate each.
- 🟠 `07 T0.2` numbering vs offline PWA: gap-free sequential numbers cannot be assigned on an offline phone (receipts and orders are captured offline). Fix: state that the number is assigned at server posting, and the capture slip keeps its own id.
- 🟠 `01 D12` "~30 server modules read erp_* directly": **[code]** 43 non-test files contain `FROM erp_`/`JOIN erp_` across customers, money, orders, products, reports, pivot, team/askKad, vaghinak, system. Fix: recount, list them in T0.3b, and size T0.3b/T2.4 from the real list.
- 🟠 `01 I1/I2` evidence scope: KAD OS and the Platform are listed as consumers (D12, T2.4) but neither repo was inventoried. Fix: add an I3 inventory of what KAD OS and Platform read (debt, prices, customer 10001) before T2.4 is sized.
- 🟠 `07 T0.3b` facts layer "reads Excel or app tables by switch": dual-source views become permanent complexity and a second place where numbers can diverge. Fix: either time-box the views (deleted at T6.3) with a test that fails if they outlive the exit, or re-point consumers per module at flip time.
- 🟠 `05 #2` / `07 T0.3`: the sync guard is described for TRUNCATE only, but products are upsert (re-applying prices/tiers after manual edits, `01 D1/D2`) and cash uses delete-by-origin. Fix: guard must cover all three write patterns per module with one test each.
- 🟠 `07 T6.1` (bot reads app API, 3–5 weeks, "start right after P0"): **[code]** the bot is one 3,700-line Python file parsing the workbook with openpyxl and has Windows-startup scripts as well as Linux config; starting it in parallel breaks the single-developer WIP logic of `05 #12`. Fix: inventory the bot's reports, migrate them per module at each flip, and count it in the WIP limit.
- 🟠 `07 T4.3` opening stock "1 day + preparation": no reference class, ignores goods in transit, goods on vans, returns awaiting inspection and customer 10000 internal stock. Fix: list stock locations first; reuse the existing stock-count module and plan a count rehearsal.

## 3. 🟡 Medium Issues
- 🟡 `04 Principles` (cutover practice [Proven]): admitted `[SINGLE-SOURCE]` organisationally (Microsoft) yet labelled Proven. Fix: label [Expert consensus — single vendor] or add a non-vendor source.
- 🟡 `04 "Proven step sequence"`: the heading says Proven, the body says "synthesis". Fix: rename to "Recommended sequence [KDS synthesis]".
- 🟡 `04 Principles` (spreadsheet errors [Proven]): S11 and S12 are the same author, S21 unfetched. Fix: label Expert consensus or drop (it is not on any decision).
- 🟡 `03 register`: 11 of 18 fetched sources are Microsoft/Odoo vendor guides written for large implementations; none covers an SME building its own ERP with one developer. Fix: search for a reference class (in-house/custom ERP builds, SME) or state the gap in Saturation.
- 🟡 `02 Tax adviser selection test`: the test question is built on S23 (T4, unfetched). Fix: ask an open question ("when must the settlement document exist for a B2B delivery today, and under which article?").
- 🟡 `02 Reconciler acceptance test 1` (10 planted differences, ≥ 9 classed right): too small a sample to trust a go/no-go gate. Fix: ≥ 100 planted differences over all kinds incl. timing across month-end and a known-trap set.
- 🟡 `01 D7` rated "missing": the app already has as-of-date debt and a live-debt overlay. Fix: rate "partial (Excel-sourced)" so the gap note matches what exists.
- 🟡 `01 D8` + `07 T4.2/T4.3`: stock counts are native (D8 says so) but T4 never says "reuse". Fix: name the existing stock-count feature as T4.3's tool.
- 🟡 `05 #10` vs `07 G4`: `05` says "P5 not in shadow 3 months after P4" while purchasing is P4 in `07` and G4 measures from the P2 flip. Fix: one consistent gate text.
- 🟡 `07 T0.6` (2–4 weeks) gates P2 but depends on an adviser not yet found and a fee not confirmed. Fix: start T0.6 in week 1 with a fallback "design for the stricter reading if no answer by week 4".
- 🟡 `07 T1.3/T2.2/T4.x` Lily feeds: the accounting program and its import format are unknown (`03 S30`, `08 Data`). Fix: add a T0 discovery task; no feed estimate before it.
- 🟡 `01 D16` mixed FX rates trap: no task handles currency of supplier invoices or historical FX. Fix: add FX rate table with valid-from to T4.1 and to T0.5 cleansing.

## 4. 🔵 Minor Improvements
- 🔵 `03 Totals`: S20 is counted as T3 although tagged "T3/T4". Fix: tier it once.
- 🔵 `02` names the accountant by first name in a planning file. Fix: use the role only.
- 🔵 `07 T0.7` (1 week) is listed last but its output decides screen design for P1. Fix: move it first in P0.
- 🔵 `07` period lock: month boundary timezone not stated. Fix: Yerevan calendar month.
- 🔵 `01 D11` "paid" matched by note text: no data-quality count of unmatched notes. Fix: measure before P5.

## 5. ⚠️ Hidden Risks & Future Problems
- ⚠️ `07 T1.4/T2.6` rollback "switch back (data kept)": after a flip Excel stops receiving that module, so switching back leaves Excel missing every day since the flip. Fix: define rollback = app export re-imported into the workbook, tested in the mock cutover, with a time limit after which rollback is closed.
- ⚠️ `07 T2.1` office/counter sale: if the adviser says cash-register rules apply (`05 hidden stones`), the app needs fiscal-register integration — a project not in the roadmap. Fix: add a conditional branch task with its own estimate.
- ⚠️ `01 D20` "not on critical path": T0.1 ships an encrypted customer + debt database to a Telegram group (a foreign processor) — a personal-data question on the critical path. Fix: include it in T0.6 questions before G0.
- ⚠️ `07 T0.2` period lock vs `01 D6` 3-day cash edit window **[code]** (`CASH_EDIT_WINDOW_DAYS`): two different "locks" with different rules will confuse users. Fix: define how the edit window and period lock combine.
- ⚠️ `05 #12` single developer = an AI agent session: no continuity of knowledge between sessions beyond docs; a ledger bug found months later has no one who "remembers". Fix: ADR per posting decision in docs, linked from tests.
- ⚠️ `07 T6.3` "30 days zero sync calls": trivially met by turning the bot push off while people still keep the workbook by hand for their own use. Fix: success = the workbook is no longer the place any business entry is typed (accountant confirms), plus no report reads it.
- ⚠️ `05 Existing-solutions` dismisses Odoo localisation as [UNVERIFIED] without fetching; if a credible local implementer exists, stock/purchasing could be bought in months. Fix: one fetch + one implementer quote before P4 starts.
- ⚠️ `07 P1` staleness alerts **[code]** (`erpSyncFreshness.js`, jobs) fire on every missed push; with modules flipping one by one they will fire falsely or be muted globally. Fix: per-module freshness keyed to the switch, with a test.

## 6. ❌ What Should Be Removed
- ❌ `06 option B` as written: a strawman that inflates A's lead. Fix: replace with a real alternative (option D hybrid).
- ❌ `02 Tax Insider` as an "agent": a one-off list of ~15 questions is a task, not an agent with tests. Fix: make it a T0.6 deliverable.
- ❌ `03 S22, S29` (Reinhart-Rogoff, UK Covid file) and C5: anecdote padding with no decision attached. Fix: delete.
- ❌ `08 AI layer` Vaghinak "unposted document / period not closed" nudges: premature before a posting model exists. Fix: move to after M2.

## 7. ➕ What Is Missing
- ➕ Program-level success criteria: `07 P6` cites "success criterion 2" that no file 01–08 defines. Fix: restate measurable exit criteria in 07.
- ➕ A staging/sandbox environment with a masked production copy for mock cutovers (`04` step 3, `03 S8`). Fix: add T0 task; no real customer data in tests.
- ➕ Role matrix for posting: who can post, void, reverse, close and reopen a period (S28 is unfetched T3). Fix: add to T0.2 with server-side checks and tests.
- ➕ UAT and performance testing (cited in `03 S4`, absent in `07`). Fix: add UAT with accountant + load test of ledger queries per gate.
- ➕ Data-retention/archive plan for `erp_*` tables after exit beyond "archived read-only". Fix: state where, how long, who can read.
- ➕ Cost of the program: `08 Budget` has no numbers at all (AI usage, adviser, storage, owner and accountant time). Fix: ranges with basis.
- ➕ Communication/training plan for reps and drivers per flip (what changes on their screens, what "in Excel" status disappears). Fix: one-page release note per flip.

## 8. 🧠 If I were your competitor, how I would beat you
- 🧠 A local ERP implementer would put stock, purchasing and AR on a ready ledger in a few months and integrate the field app once, while this plan spends 1–2 years hand-building ledgers with one AI developer and a phone reviewer; the moment a stock valuation or AR bug reaches the books, the owner's trust flips to the vendor. Fix: keep cash + sales (where the app is strong) in-house and price option D honestly before P4.

## 9. 💡 Brutal Action Plan (step-by-step fixes)
1. Re-sum `07` with all tasks and shadows; publish P10/P50/P90 and compare with the 2027-12 pre-mortem horizon.
2. Rebuild the critical path as a full dependency graph (include T1.1–T1.2, T2.1–T2.2, T4.1, T0.3b, T2.4).
3. Replace G1 "zero diff" with "all differences attributed, app errors = 0", cap shadow length, and kill every Excel-to-app derivation in shadowed modules.
4. Re-scope T0.1 to what is really missing (cron, 50 MB limit, uploads volume, Compose-shape drill) and finish it first.
5. Inventory every DELETE path (incl. test-user purge and cash delete-by-origin) and put each under T0.2.
6. Downgrade Armenian-law and cutover [Proven] labels; start T0.6 week 1 with a stricter-reading fallback.
7. Add option D, rescore `06` with evidence per cell, rerun sensitivity on reversibility and speed.
8. Add golden accounting scenarios signed by the accountant as the KAD Builder acceptance suite.
9. Recount erp_* consumers (43 files), inventory KAD OS and Platform reads, then size T0.3b/T2.4.
10. Add staging, role matrix, UAT, budget ranges, rollback-with-back-fill and exit criteria to `07`/`08`.

## Appendix C: Sources

# 03 — Source register (Phase 4) — excel-off-single-erp

Fetch method: `curl -sS -L` through the session proxy after the owner's environment allowed the hosts (2026-11-06); text extracted and grepped; anchors copied from the extracted text. Search: WebSearch (EN + HY attempted by research agents; Armenian queries returned nothing relevant). Freshness override (intake): ERP-implementation and accounting frameworks ≤ 10 years; classic spreadsheet-error research allowed.
Internal evidence (not web sources): **I1** app code inventory (SalesManagerVisits @ fd4fe54), **I2** bot + workbook inventory (castrol_ceo_report main + Castrol-file skill).

| id | claim it supports | title | author/org | year | URL | tier | fetched? | language | notes/conflicts |
|----|---|---|---|---|---|---|---|---|---|
| S1 | Cutover plan has owners, verification/sign-off, a rollback plan, a go/no-go decision with criteria and a mock cutover (dress rehearsal) | Prepare go-live: cutover strategy (Implementation Guide) | Microsoft | 2024-02-01 | https://learn.microsoft.com/en-us/dynamics365/guidance/implementation-guide/prepare-go-live-cutover-strategy | T1 | VERIFIED-FETCH | en | anchor: "A rollback plan in case something goes wrong" · "This is called a mock cutover or a dress rehearsal" · "This is called the go/no-go decision" |
| S2 | Migration data = master data (customers, products, vendors) + open transactions (sales orders, purchase orders, stock on hand, open balances) | Manage configuration and migration data | Microsoft | 2024-01-23 | https://learn.microsoft.com/en-us/dynamics365/guidance/implementation-guide/data-management-configuration-data-migration | T1 | VERIFIED-FETCH | en | anchor: "open transactions, such as sales orders, purchase orders, stock on hand, and open balances" |
| S3 | Before go-live: integrations tested, deployment execution plan exists | Prepare to go live | Microsoft | 2024-02-01 | https://learn.microsoft.com/en-us/dynamics365/guidance/implementation-guide/prepare-to-go-live | T1 | VERIFIED-FETCH | en | anchor: "integrations with all external systems should be tested, and you should have a high-level deployment execution plan" |
| S4 | Test strategy spans unit → UAT, incl. performance and usability, mapped to success criteria | Testing strategy | Microsoft | 2025-01-07 | https://learn.microsoft.com/en-us/dynamics365/guidance/implementation-guide/testing-strategy | T1 | VERIFIED-FETCH | en | anchor: "you might start with unit testing and end with user acceptance testing (UAT)" |
| S5 | Costing methods FIFO / Average / Standard and when to use each | Design details: costing methods (Business Central) | Microsoft | 2026-03-17 | https://learn.microsoft.com/en-us/dynamics365/business-central/design-details-costing-methods | T1 | VERIFIED-FETCH | en | anchor: "Average An item's unit cost is calculated as the average unit cost at each point in time after a purchase" |
| S6 | ERPs restrict the period during which posting is allowed (period lock) | Set up finance (Business Central) | Microsoft | 2026-04-01 | https://learn.microsoft.com/en-us/dynamics365/business-central/finance-setup-finance | T1 | VERIFIED-FETCH | en | anchor: "specifying the period during which posting is allowed" |
| S7 | Stock counts (annual or cycle) posted through journals as adjustments | Count, adjust, and reclassify inventory | Microsoft | 2026-06-17 | https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-count-adjust-reclassify | T1 | VERIFIED-FETCH | en | anchor: "Some businesses do an annual physical count, and others count all or only some items more often" |
| S8 | Practise in a sandbox company before production | Migrate customer data (Business Central) | Microsoft | 2023-05-11 | https://learn.microsoft.com/en-us/dynamics365/business-central/admin-migrate-customer-data | T1 | VERIFIED-FETCH | en | anchor: "Start by setting up a company in a sandbox so that users can practice before they start" · [DATED — verify] (product doc > 12 mo; practice stable) |
| S9 | DR plans must be structured, tested, documented and aligned to recovery targets | Disaster recovery (Well-Architected RE:09) | Microsoft | 2025-11-19 | https://learn.microsoft.com/en-us/azure/well-architected/reliability/disaster-recovery | T1 | VERIFIED-FETCH | en | anchor: "Implement structured, tested, and documented disaster recovery (DR) plans that align with the recovery targets" |
| S10 | Inventory cost = all costs of purchase + costs to bring to present location; FIFO or weighted average for interchangeable items | IAS 2 Inventories (summary) | IFRS Foundation | n/d (standard in force) | https://www.ifrs.org/issued-standards/list-of-standards/ias-2-inventories/ | T1 | VERIFIED-FETCH | en | anchor: "the first-in, first-out or weighted average cost formula for items that are ordinarily interchangeable" |
| S11 | Spreadsheet errors are common and non-trivial (15 years of studies) | Spreadsheet Errors: What We Know. What We Think We Can Do | R. Panko (EuSpRIG 2000) | 2008 (arXiv) | https://arxiv.org/abs/0802.3457 | T1 | VERIFIED-FETCH | en | anchor: "spreadsheet errors are both common and non-trivial" · classic, override applies |
| S12 | Lab studies' average cell error rate 3.9 %; expected 1 %–5 % | What We Don't Know About Spreadsheet Errors Today | R. Panko | 2016 (arXiv) | https://arxiv.org/pdf/1602.02601 | T1 | VERIFIED-FETCH | en | anchor: "The average across these studies is a cell error rate of 3.9%" |
| S13 | Store all changes as a sequence of events → audit log, rebuild past states | Event Sourcing | Martin Fowler | 2005 | https://martinfowler.com/eaaDev/EventSourcing.html | T2 | VERIFIED-FETCH | en | anchor: "Event Sourcing ensures that all changes to application state are stored as a sequence of events" · [DATED — verify] pattern stable |
| S14 | Double-entry / accounting entries as the model for money movements | Patterns for Accounting | Martin Fowler | 2006 | https://martinfowler.com/eaaDev/AccountingNarrative.html | T2 | VERIFIED-FETCH | en | anchor: "One of the most fundamental concepts in accounting is double-entry bookkeeping" · [DATED — verify] |
| S15 | Perpetual (automatic) valuation posts in real time when stock enters or leaves | Inventory valuation configuration (Odoo 18) | Odoo S.A. | 2025 (v18 docs) | https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/product_management/inventory_valuation/inventory_valuation_config.html | T1 (official product docs) | VERIFIED-FETCH | en | anchor: "perpetual (automatic) inventory valuation creates real-time journal entries ... whenever stock enters or leaves" |
| S16 | Opening balances are entered at set-up per account | Accounting: get started (Odoo 18) | Odoo S.A. | 2025 | https://www.odoo.com/documentation/18.0/applications/finance/accounting/get_started.html | T1 | VERIFIED-FETCH | en | anchor: "add accounts to your Chart of Accounts and indicate their initial opening balances" |
| S17 | RA Tax Code: settlement documents (tax invoice, adjusting invoice, consignment note, cash-register receipt) — Art.55; issued in electronic form and upon supply — Art.56(3),(4); records kept ≥ 5 years — Art.33; excise on lubricating oil 550 AMD/kg — Art.88; cash register mandatory for retail / services to the public — Art.380 | Tax Code of the Republic of Armenia (official translation, incl. HO-72-N of 26 Mar 2025) | ARLIS / National Assembly | 2016, amended to 2025-03-26 | https://arlis.am/en/acts/216349 | T1 | VERIFIED-FETCH | en | anchors: "Settlement documents shall be issued in electronic form" · "issued upon supplying goods" · "for a period of not less than five years" · "lubricating oil 1 kg 550" · "mandatory when making retail sale" · translation may lag later amendments → see C1, C2 |
| S18 | The 2002 Law on Accounting was in force 2003-02-22 → 2020-01-01 (superseded) | Law on Accounting LA-515-N | ARLIS | 2002 | https://www.arlis.am/en/acts/117025 | T1 | VERIFIED-FETCH | en | anchor: "Status Passive (22.02.2003-01.01.2020)" · current law = S31 |
| S19 | ERP implementation procedures and critical success factors | Enterprise resource planning: implementation procedures and CSFs (EJOR 146(2)) | Umble, Haft, Umble | 2003 | https://www.sciencedirect.com/science/article/abs/pii/S0377221702005477 | T1 | UNFETCHED | en | blocked (bot gate); bibliographic only; [DATED — verify] |
| S20 | Phased go-live contains problems but takes longer than big bang | How to Determine a Phasing Approach | Panorama Consulting | n/d | https://www.panorama-consulting.com/how-to-determine-a-phasing-approach-for-your-erp-system | T3 | UNFETCHED | en | search summary only — context |
| S21 | Audit of 50 operational spreadsheets: errors in ~1 % of formula cells | Errors in Operational Spreadsheets (JOEUC 21(3)) | Powell, Baker, Lawson | 2009 | https://mba.tuck.dartmouth.edu/spreadsheet/product_pubs_files/Errors.pdf | T1 | UNFETCHED | en | host not allowed; search summary only |
| S22 | Spreadsheet coding error excluded countries from an influential result | Does high public debt consistently stifle growth? (CJE 38(2)) | Herndon, Ash, Pollin | 2014 | https://econpapers.repec.org/RePEc:oup:cambje:v:38:y:2014:i:2:p:257-279 | T1 | UNFETCHED | en | retired: no decision attached (critique ❌) |
| S23 | From 2026-09-01 settlement documents for goods due before supply | Settlement document deadlines 2026 | LookupTax | 2026 | https://lookuptax.com/tax-changes/armenia/settlement-document-deadlines-2026 | T4 | UNFETCHED | en | conflicts with S17 text (C2) |
| S24 | SRC e-settlement-document system has API / XML import | Electronic settlement documents e-invoicing Armenia | LookupTax | n/d | https://lookuptax.com/docs/einvoicing/electronic-settlement-documents-einvoicing-armenia | T4 | UNFETCHED | en | `[UNVERIFIED]` — e-invoicing.taxservice.am is a JS-only page (fetched, empty shell) |
| S25 | PD law HO-49-N (2015): lawful basis, Agency notifications, breach reporting | Data Protection in Armenia | DLA Piper | n/d | https://www.dlapiperdataprotection.com/index.html?c=AM&t=law | T3 | UNFETCHED | en | off critical path |
| S26 | ERP CSF compilation; change management under-researched yet critical | ERP implementation: a compilation and analysis of CSFs (BPMJ 13(3)) | Finney & Corbett | 2007 | https://www.doi.org/10.1108/14637150710752272 | T1 | UNFETCHED | en | [DATED — verify]; 45 vs 70 articles (C6) |
| S27 | Excise on lubricating oil 550 AMD/kg | Armenia — Corporate — Other taxes | PwC Worldwide Tax Summaries | n/d | https://taxsummaries.pwc.com/Armenia/Corporate/Other-taxes | T3 | UNFETCHED | en | triangulates S17 Art.88 (snippet) |
| S28 | COSO 2013: 5 components, 17 principles; segregation of duties under control activities | COSO control activities | Deloitte (secondary) | n/d | https://www.deloitte.com/ng/en/services/audit/perspectives/coso-control-activities.html | T3 | UNFETCHED | en | coso.org page fetched but JS-rendered (no text) |
| S29 | Excel file limit dropped 15,841 Covid cases (UK PHE, 2020) | PHE confirms file size issue | UKAuthority | 2020 | https://ukauthority.com/articles/phe-confirms-file-size-issue-caused-covid-19-undercounting/ | T4 | UNFETCHED | en | retired: no decision attached (critique ❌) |
| S30 | ArmSoft sells AS-Accountant (hy/en/ru) — no public API found | AS-Accountant (App Store) | Armenian Software | n/d | https://apps.apple.com/us/app/as-accountant/id1585804135 | T4 | UNFETCHED | en | which program KAD uses = owner question |
| S31 | Law on Accounting HO-282-N (2019): primary documents and databases kept ≥ 5 years | Law on accounting (CBA translation) | Central Bank of Armenia | 2019 | https://www.cba.am/EN/lalaws/8-Law%20on%20accounting.pdf | T1 | UNFETCHED | en | 404 at fetch; article no. disputed (C3); S17 Art.33 gives the 5-year rule for tax records (fetched) |

Totals: 31 sources · T1 21 / T2 2 / T3 4 / T4 4 · fetch-verified 18 (S1–S18).

## Conflicts
- **C1 excise rate** · workbook Products row-1 parameter used by the landing-cost model = 682 AMD/kg (I2) · S17 Art.88 (text amended to 2025-03-26) = 550 AMD/kg · S27 (T3) = 550. Reason: the translation may lag a later amendment, or the workbook parameter includes other per-kg costs. Chosen: neither — the roadmap makes every cost rate an app setting with source + valid-from date, and the accountant confirms the current rate (task T0.6). 
- **C2 settlement-document timing** · S17 (2025 text) "issued upon supplying goods" · S23 (T4, 2026) "before the supply from 2026-09-01". Chosen: S23 is newer but T4 → accountant confirms (T0.6); design assumes the document must exist **before goods leave** (the stricter reading), which is safe under both.
- **C3 retention article** · S31 Art.16(1) vs Art.19 (secondary sources). Both say 5 years; S17 Art.33 (fetched) independently gives ≥ 5 years for tax records. Chosen: keep everything forever (owner decision 2026-10-26 already) — compliant under both.
- **C4 parallel run** · practitioners rank parallel running as lowest-risk but costly; no peer-reviewed comparison found (research agent A, S20). Chosen: shadow mode with automatic daily reconciliation (cost of the second entry is already being paid — the accountant types Excel today).
- **C5** Reinhart-Rogoff 4 vs 5 countries; context only. **C6** Finney & Corbett 45 vs 70 articles; not used for numbers.
- **C7 cell error rate** · S11/S21 ~1–2 % vs S12 3.9 % lab average · both support "errors are routine"; no number is used on the critical path.

## Saturation
- ERP cutover practice: Saturated on Microsoft guidance (S1–S4, S8) — further searches returned the same implementation-guide family; no peer-reviewed quantitative comparison of parallel vs phased vs big bang exists in reach (stated as a gap).
- Inventory valuation: Saturated — S5, S10, S15 agree (FIFO / weighted average; perpetual).
- Armenian law: NOT saturated — only the Tax Code translation was readable; SRC (petekamutner.am) unreachable (502), e-invoicing portal JS-only; Law on Accounting 2019 not fetched. Gap handled by HIRE task (accountant / tax adviser confirmation, T0.6).
- Spreadsheet risk: Saturated for the qualitative claim (S11, S12).
- Reference class for an SME building its own ERP with one (AI) developer: none found in public sources; internal class I4 (this repo's git history: 50 PRs in 8 days; payments redesign R1–R5 in 2 days) used instead — [SINGLE-SOURCE].
