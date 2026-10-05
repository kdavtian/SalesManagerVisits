# Data-quality findings and rules for code that reads the workbook

Found by profiling `Castrol_2.0.7.xlsx` (values as of 2026-10-03). Use `scripts/inspect_workbook.py` to re-run the checks on any new file.

## A. Defects that change numbers (fix at source or defend in code)
1. **Debits `Assigned To` returns the TIER, not the channel (2.0.7 regression).** Formula `VLOOKUP(id, Customers[[Customer ID]:[Assigned To]], 4, 0)`; when the owner inserted `Tier` as column D, index 4 became Tier. All 415 Debits rows now say Gold/Silver. The bot's `build_ar_detail` (`row["Assigned To"]`), the sales-director debt-by-rep and `sync_field_visits` (`assigned_sales_rep`) read this column, so **AR by channel and the rep shown on ERP customer data are wrong until fixed**. Fix at source: change the index 4 -> 5 in `Debit[Assigned To]`; defend in code: take the channel from the `Customers` sheet by Customer ID (and treat Gold/Silver/Bronze as invalid channel values). Any other VLOOKUP/INDEX with a hard-coded column index can break the same way when a column is inserted - re-check Orders `Tier` (index 4, correct now), Cash `Customer_Name` (index 2), Pricelist (23,30-34), Products->Pricelist (6), Inventory (5,7).
2. **ORDERS `Sales_Rep` contains tier words**: 53 orders / 171 rows between 2026-07-07 and 2026-07-15 have `Silver` (150 rows) or `Gold` (21) instead of a channel (11.8M AMD). Orders_P pivot shows them as fake channels. They are mis-keyed; the real channel is probably the customer's `Assigned To`. Until corrected, channel sales/plan KPIs under-count the real channels. The bot should map unknown channel names via Customers.Assigned To.
3. **ProductID case mismatches**: six ORDERS ProductIDs differ from PriceList only by case (`CastrolDot40,5` vs `CastrolDOT40,5`, `castrolMagnatec 10w401`, `LotosPARUS GL4 80w90205`, `LotosLithium Grease LT43205`, `CastrolHyspin AWS 46208`, `RoyalDOT40,5`). Excel matches case-insensitively, Python does not: always compare `str.casefold()`/the bot's `_product_key`. One order line has brand `castrol` lowercase.
4. **Duplicate PriceList rows** for `CastrolCRB Tmax 15w40 CI4/SL/E77` and `...E7208` (247 rows, 245 IDs): sync dict keeps the last. Inventory/Orders unaffected but the app can show duplicate product cards if not deduped by ProductID.
5. **Empty bronze prices**: 99 of 247 PriceList rows show Bronze 0 (77 Castrol); they then have Margin `#DIV/0!` and Net Cost = Landing Cost (the % add-ons depend on bronze). Business rule: bronze empty -> silver. 61 have no silver, 83 no gold, 111 no retail.
6. **Excel errors in cached values**: PriceList Margin/Discount (`#DIV/0!` x99/x111), Debits Risk (1), Sales Team_2026 Total column (`#VALUE!`) and months with no sales (`#DIV/0!`). Code must treat `#...` strings as missing, not as 0 (`bcr.number` coerces to 0 - check `is_error_string` where a silent 0 would hide a debt).
7. **Cashflow header block**: `A1` (report month) is stale (2026-08-01) so the month boxes in rows 1-8 show August; always read the ledger rows (header row 9), never the control-panel cells. Cash `Customer_Name` and `Customers.Total Paid` rely on `ID` being numeric; expense rows put free text (plates/models) in `ID`.
8. **Blank-ID receipts**: 80 Oil-order rows (2025-05) have no Customer ID ("Slav/ Castrol" etc.) - they count in company collections (465.7M) but in no customer's `Total Paid` (454.8M) - a 10.8M reconciliation gap by design. Possible duplicate receipts: 4 rows share date+amount+ID.
9. **Sales_Rep vs Assigned To**: 26% of order rows (80M AMD) are sold by a different channel than the customer's home channel (SM YVN sells to Shirak/Davtashen customers, SM CAS to PCO, ...). Intentional; keep both concepts.
10. **Customer 10000 "Inventory"**: zero-value internal rows (2024-01 .. 2025-06, plus a batch in 2025-12; 98 rows in 2025) = monthly stock write-outs of the pre-ERP period; must be excluded from sales, customers, velocity. It is Tier Gold, channel KF by accident.
11. **Customers without `Assigned To`** (27, the newest IDs 10368+), without Region (39), Subregion (63), Phone (175), TIN (179). New customers are added without full data - the app's autofill and data-quality dashboard exist for this.
12. **Tier column is almost uniform**: 411 Silver / 5 Gold (one is customer 10000). Bronze/Potential do not exist in Excel; the app's `potential` customers (no ERP id) stay app-only. Syncing Excel tier overrides manual app tiers for ERP-linked customers.
13. **Inventory `Days`**: all-time-average velocity => unstable (min -47,792, max 12,343 days) and blank for unsold items; the app computes its own recent-demand days. Stock valuation uses landing cost.
14. **FX inconsistency**: 377.5 (Products), 385 (Purchase_IN), 380 (Cashflow panel), 370 (Inventory order summary), per-row 360-392 (USD cash rows). Don't "unify" silently; state which rate a number uses.
15. **Manual constant** in ORDERS `L1`: `+235,683,700` is added to the discount subtotal (an opening adjustment); ignore L1 for analysis.
16. **Orders_P** pivot is stale; **KPI_2025** is hidden legacy; `Tabel` is confidential; never feed them into reports.

## B. Parsing rules for the bot/app (what the readers must do)
- Read with `openpyxl.load_workbook(read_only=True, data_only=True)`; header rows per the dictionary; trim header text; accept old+new names (`Price T1`/`Price T1 Bronze`, `GMM Price T3`/`Price T3 Gold`, `Net Cost`/`Net Cost AMD`).
- Dates: ORDERS `Date` is a datetime but also derivable from `Order ID`; Cash `Date` datetime; Customers `Partner Since` may be a `time` object (0) when no order.
- Numbers may be int/float/str; strip, treat `""`, `None`, `#N/A`-style strings as missing; AMD values should be rounded to whole drams for display (owner rule).
- Keys: Customer ID as text of an int; ProductID casefolded; channel codes compared case-insensitively (`SM YVN` == `SM Yvn`); channel display names in the app are title-cased except codes.
- Never treat Gold/Silver/Bronze as a channel. Never use Orders `Tier` as the price tier of that order.
- A customer's debt as of D = Balance0 + sum(ORDERS.Total, Date <= D) - sum(Cash Oil-order Amount AMD, Date <= D) - not `Customers.Total Paid` (which is unfiltered and in original currency).
- Collections in AMD must use `Amount AMD`, never `Amount`, for USD rows.
- Idempotency: the file is re-sent daily; every sync is TRUNCATE-and-replace per table (except products upsert), so a partial/old workbook can wipe data - validate required sheets/row counts first (bot's `validate_source`).

## C. Checklist when the owner announces a new file version / structure
1. Run `python3 scripts/inspect_workbook.py new.xlsx`; compare headers with `references/sheet-dictionary.md`; list added/removed/renamed columns and moved header rows.
2. Re-test every VLOOKUP-fed column (Debits Assigned To, Pricelist, Inventory) against the Customers/Products source by recomputing in Python.
3. Update bot readers (accept both names), the sync payload, app transform/tests, then docs/skills (sheet-dictionary, bot-architecture).
4. Ask the owner only about business meaning (e.g. what a new column is for); decide technical details yourself.
5. After deploy: re-send the workbook to the bot, check the journal line `Field Visits sync: pushed N customer records, ... products`, then spot-check one customer's debt and one product's prices in the app against Excel.

## D. Questions worth putting to the owner (unresolved)
- Fix `Debits[Assigned To]` in Excel (index 5) or should the bot read the channel from Customers?
- Correct the 53 orders with Silver/Gold in Sales_Rep (which channel were they?).
- Should import VAT be inside Landing/Net cost? Should Net Cost use the price tier actually sold rather than bronze, and what Net Cost for products without bronze?
- Gold prices below landing cost (12 products) - intentional?
- How should Balance0-only customers with big debt and no orders (e.g. >10M) be followed up?
