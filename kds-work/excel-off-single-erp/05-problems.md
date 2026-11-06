# 05 — Problems, solutions, hidden stones (Phase 6) — excel-off-single-erp

## Pre-mortem — "It is 2027-12. Excel is still running, or the app's debts are wrong."
| # | failure reason (angle) | evidence | early-warning sign | mitigation (enters roadmap) |
|---|---|---|---|---|
| 1 | Droplet disk/DB lost after Excel was switched off → no second copy of the books (tech) | I1 backups not on production (R-02 High); S9 | no successful off-site backup in 24 h; no restore drill on record | G0: off-site encrypted backups + monthly restore drill BEFORE any module goes app-only (T0.1) |
| 2 | A stale workbook push wipes app-owned data (tech) | I2 trap 16: sync TRUNCATE-replaces tables | any sync touching an app-owned module | per-module source switch; sync refuses writes for app-owned modules (T0.3) |
| 3 | Accountant keeps typing Excel forever because the app takes more steps (people) | S26 change management; kadprocesses | accountant's Excel edits continue after switch; time per task > Excel | design screens with her; each switch removes an Excel task the same day; Excel export button (T0.7, per-module tasks) |
| 4 | Debts never reconcile because history re-prices with tier changes (data) | I2 trap 8; 9 | non-zero diff on old periods | reconcile only from the opening-balance date forward; freeze history (T0.4) |
| 5 | Opening balances wrong (receipts without customer id, duplicate ids, Balance0 for never-ordered customers) (data) | I2 traps 2–4 | Reconciler diff on day 1 | cleansing list signed by accountant before mock migration (T0.5) |
| 6 | Landed cost wrong (excise/duty rates stale) → margins and stock value wrong (law/money) | C1 | app vs workbook landing cost > 20 % (exists as data-quality check) | rates with valid-from dates; accountant confirms; per-shipment allocation (P5) |
| 7 | Tax documents issued late or by the wrong system after the 2026-09 rule change (law) | S17, S23, C2 | waybill created after delivery timestamp | Tax Insider checklist + adviser answer (T0.6); app blocks "delivered" without document when the rule applies |
| 8 | Posted records edited/deleted → trust lost (control) | I1 admin hard-delete of delivered orders; no period lock | any delete of a posted record | posting model: void/reverse only, period lock (T0.2) |
| 9 | Reports silently show half Excel, half app data (tech) | I1 ~30 modules read erp_* directly | two screens disagree on the same number | one facts layer that follows the switch (T0.3b) |
| 10 | Purchasing/stock module too big, stalls the program (scope) | I1: zero tables exist | P5 not in shadow 3 months after P4 | split: receipts + stock first, supplier payables later; gate G4 |
| 11 | Bot reports die when Excel stops (tech) | I2 all reports parse workbook | bot "file missing" errors | bot reads app API before any module flips (P6 early) |
| 12 | Single developer + owner bandwidth (team) | KADDev: one developer, owner reviews by phone | > 2 modules in shadow at once | WIP limit: max 2 modules in shadow at a time |

## Root cause (5 whys, the central problem)
Problem: every cash number is typed 4 times and debts are only trusted from Excel → why: the app's records are not "posted" documents → why: Excel was the first system and the app was built as a field tool reading Excel (I1 docs/erp-integration.md) → why: no app ledger exists for AR, stock, purchasing → root (controllable): missing posting model + per-module ownership → solution: posting model + source switch + Reconciler (S1, S2, S13/S14).

## Existing-solutions check (why not buy an ERP?)
| solution | does well | misses for KAD | evidence |
|---|---|---|---|
| Odoo (has an Armenian localisation module on its app store per research agent B, unfetched) | full ERP incl. perpetual stock valuation, opening balances | KAD's field app, custody chain, Vaghinak, KAD OS, Platform would need re-integration; second system to learn | S15, S16 (fetched); localisation [UNVERIFIED] |
| ArmSoft AS-Accountant / 1C (local accounting) | Armenian books, tax filings | not an operational field ERP; no public API found | S30 T4 [UNVERIFIED] |
| Keep Excel + sync (status quo) | accountant knows it | 4 copies per number; formula errors (S11, S12); TRUNCATE risk | I2 |

## Hidden stones (non-obvious)
- Customer 10000 "Inventory" is an internal stock account mixed into ORDERS (I2 trap 1) → app needs internal stock movements, not fake customers.
- ORDERS Sales_Rep ≠ customer's home channel on ~26 % of lines by design (I2 trap 9) → keep both on the app sale line.
- Payroll "paid" matched by note text (I1) → salary payments must become structured rows before Cashflow flips.
- `payments_cutover` already exists (I1) → reuse, do not invent a second cutover mechanism.
- Staleness alerts (`erpSyncMonitor`) will fire once pushes stop → must be tied to the switch.
- Cash register (HDM) rule targets retail/services to the public (S17 Art.380); B2B field collection status is [UNVERIFIED] → adviser question.
