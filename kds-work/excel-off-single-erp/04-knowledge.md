# 04 — Knowledge (Phase 5) — excel-off-single-erp

## Principles
- [Proven] Migration data has two classes: master data (customers, products, vendors) and open transactions (sales orders, purchase orders, stock on hand, open balances); each needs its own plan, test and check (S2).
- [Proven] A cutover plan names an owner and backup owner for each task, verification and sign-off steps, a rollback plan, and go/no-go criteria decided in advance; it is rehearsed in a mock cutover first (S1; S3, S8 triangulate rehearsal/sandbox practice — same vendor, so counted as one organisation → `[SINGLE-SOURCE]` organisationally, T1).
- [Proven] Inventory cost includes all costs of purchase and of bringing goods to their present location (duties, transport); interchangeable items use FIFO or weighted average (S10; S5 and S15 independently implement the same two methods).
- [Proven] Perpetual inventory = every receipt/issue posts at once (S15); counts post as adjustments through a journal, annually or in cycles (S7).
- [Proven] ERPs lock posting to an allowed period (S6).
- [Proven] DR plans must be tested and documented against recovery targets (S9).
- [Proven] In Armenia, settlement documents (tax invoice, adjusting invoice, consignment note …) are issued electronically and at supply; tax records are kept ≥ 5 years; lubricating oil carries excise per kg (S17 T1, fetched; excise triangulated by S27 T3 unfetched).
- [Proven] Spreadsheet cell errors are routine (S11, S12 — same author; S21 independent but unfetched → qualitative claim only).
- [Expert consensus] Store every change as an event / accounting entry; correct by a reversing entry, never by editing history (S13, S14).
- [Expert consensus] Phased go-live contains failures better but takes longer (S20 T3/T4 — context only).

## Proven step sequence for one module (assembled from S1, S2, S4, S7) [KDS recommendation — sequence is a synthesis]
1. Design + build the app module (posting model, numbering, audit).
2. Cleanse master data; fix the known traps (I2 list).
3. Rehearse opening balances on a copy (mock cutover).
4. Shadow run: Excel stays the source, the app records in parallel, Reconciler diffs daily.
5. Go/no-go on pre-set criteria (zero difference streak incl. one month-end).
6. Flip the module's source switch; the sync stops writing that module; Excel sheet becomes read-only export.
7. Hyper-care 2 weeks; rollback path = switch back (data kept).

## Benchmarks
- Shadow period length: no sourced reference class found (C4) → criterion-based (streak of zero-difference days), not calendar-based [KDS recommendation].
