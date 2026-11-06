# 06 — Options scored (Phase 7) — excel-off-single-erp
Weights (intake): risk 35 · quality 25 · speed 15 · reversibility 15 · cost 10. Scores 1 (worst) – 5 (best).

- **A. Strangler inside the KAD app** — per module: build → shadow run with daily Reconciler → go/no-go → flip a per-module source switch; Excel sheet becomes a read-only export. [KDS recommendation]
- **B. Big bang at 2027-01-01** — build every missing module first, opening balances at year start, Excel off in one day.
- **C. Buy an ERP core (e.g. Odoo) for stock/purchasing/AR**, keep the field app and integrate both ways.

| criterion (weight) | A | basis | B | basis | C | basis |
|---|---|---|---|---|---|---|
| risk (35) | 4 → 140 | rollback per module + rehearsal + go/no-go (S1); limits blast radius (S20 T3, context) | 2 → 70 | no rollback once Excel stops; purchasing/stock do not exist yet (I1) | 3 → 105 | mature ledger (S15) but two-way integration is a new failure point (S3) [ESTIMATE] |
| quality (25) | 4 → 100 | one system, posting model designed for KAD (S13/S14) [ESTIMATE] | 3 → 75 | same design, less testing time [ESTIMATE] | 4 → 100 | proven stock valuation (S15) |
| speed (15) | 3 → 45 | first module (cash) can flip within weeks; whole program long [ESTIMATE] | 3 → 45 | one date, but 8 weeks to build 3 missing modules is not credible [ESTIMATE] | 2 → 30 | new system + localisation [UNVERIFIED] + integration [ESTIMATE] |
| reversibility (15) | 5 → 75 | switch back per module, data kept | 2 → 30 | reverting means re-typing Excel | 2 → 30 | data split across two systems |
| cost (10) | 4 → 40 | no licences; developer = KAD Builder | 4 → 40 | same | 2 → 20 | licences + implementer [ESTIMATE — no reference class] |
| **total /500** | **400** | | **260** | | **285** | |

Winner: **A** (400). Trade-off: A is slower to finish than a big bang would be on paper, but it never puts debts or stock at risk on a single day; C would win only if KAD wanted a ready accounting ledger inside the ERP — excluded by the owner's answer "accounting stays outside".
Sensitivity: A quality 3 (single developer risk) → 375, still wins; C risk 4 → 320, still second. Robust to both. Evidence strength: A rests on S1–S4 (T1, fetched).

## v2 rescore (Phase 10, after critique 🟠 06 / ❌ option B)
Option B removed as a strawman. Added **D. Hybrid**: the app owns cash, sales, returns, AR, prices; stock + purchasing run in a bought module (e.g. Odoo Inventory/Purchase) integrated with the app. Reversibility of A lowered to 4 (rollback needs back-fill of Excel, time-limited — see v2 R-rollback).
| criterion (weight) | A | basis | C | basis | D | basis |
|---|---|---|---|---|---|---|
| risk (35) | 4 → 140 | per-module rollback + rehearsal + go/no-go (S1); app already holds cash/orders (I1) | 3 → 105 | two-way integration of a whole ERP (S3) | 3 → 105 | integration only for stock/purchasing (S3); vendor ledger proven (S15) |
| quality (25) | 4 → 100 | one data model; accountant-signed golden scenarios (v2 T0.9) | 4 → 100 | S15, S16 | 4 → 100 | S15 for stock |
| speed (15) | 2 → 30 | calendar dominated by shadow periods [ESTIMATE, I4] | 2 → 30 | new system + localisation [UNVERIFIED] | 3 → 45 | stock module bought [ESTIMATE] |
| reversibility (15) | 4 → 60 | back-fill export per module | 2 → 30 | data split | 3 → 45 | split only for stock |
| cost (10) | 4 → 40 | no licences | 2 → 20 | licences + implementer | 3 → 30 | one module licence + implementer [ESTIMATE] |
| **total /500** | **370** | | **285** | | **325** | |
Sensitivity: speed weight 25 (risk 25) → A 350, D 325: A still wins. A speed 1 (program > 18 months) → A 355 vs D 325 (A still wins); A speed 1 AND speed weight 25 → A 325 vs D 325 (tie) → this becomes **Gate G4** before P4: fetch Odoo Armenian localisation + one implementer quote; if D's stock module is quoted ≤ the app's P4 estimate and passes the golden scenarios, take D for P4 only.
