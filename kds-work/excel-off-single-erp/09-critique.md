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
