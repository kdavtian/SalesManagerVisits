---
name: Castrol-file
description: Complete reference to the Castrol Excel workbook (Castrol_x.y.z.xlsx) that is the company's source of truth - every sheet, column, formula, key and business meaning (purchasing, landed/net cost model, 4-tier price lists, orders, cash ledger, debts/AR, inventory/stock days, payroll and KPI sheets, plan vs actual), the data-quality traps found in it, and how the CEO bot and Field Visits app consume it. Use whenever a task touches the workbook, ERP sync, bot reports, prices/costs/margins, debt/sales/cash numbers, tiers, customers/channels, or when the owner ships a new file version.
---

# Castrol-file - the workbook, fully explained

Owner: KAD / "Kalantaryan Family" company, exclusive-style distributor of **Castrol** (plus **Lotos, Royal, Orlen**) lubricants in Armenia. The accountant maintains ONE Excel workbook (versions `Castrol_2.0.5 ... 2.0.7`), posts it into a Telegram group almost daily; the CEO bot (repo castrol_ceo_report) reads it with openpyxl (values only, `data_only=True`) and syncs to the Field Visits app. Everything numeric in the company's reporting derives from this file. It is built on Excel Tables + SUMIFS/SUMPRODUCT/VLOOKUP formulas, so a column insertion silently shifts VLOOKUP indexes (this already broke `Debits` in 2.0.7 - see data-quality file).

Companion skill: `KADDev` (how to change the app/bot). Read the reference you need:

| Need | File |
|---|---|
| Sheet-by-sheet dictionary: header row, first data row, every column, formula, key, gotcha | `references/sheet-dictionary.md` |
| Cost model, price tiers, margins, cash/AR/stock logic, KPI & payroll rules, how money flows | `references/business-and-finance.md` |
| Known data defects, parsing rules the bot/app MUST follow, new-version checklist | `references/data-quality-and-gotchas.md` |
| Numbers as of 2026-10-03 (scale of the business, concentrations, margins) | `references/snapshot-2026-10-03.md` |
| Health-check script for any new workbook | `scripts/inspect_workbook.py` (`python3 inspect_workbook.py file.xlsx`, ~2 s) |

## 30-second mental model

```
Purchase_IN (supplier invoices, USD) --> Products (landed cost model: USD cost + transport + customs + excise + VAT = Landing Cost; + 4% manager salary + 18% profit tax on the bronze price = Net Cost; Price T1/T2/T3 + Retail typed here)
        --> PriceList (pure VLOOKUP view of Products)      --> Inventory (stock = OB + IN - OUT, valued at landing cost)
ORDERS (one row per product line; Total = Qty*(UnitPrice+Discount); Sales_Rep = selling channel) --> Customers (Total Revenue)
Cashflow (ledger of every cash/bank movement; For="Oil order" = customer payment, ID = Customer ID) --> Customers (Total Paid)
Debt(customer) = Balance0 + SUM(ORDERS.Total) - SUM(Cashflow Oil-order Amount)      [Customers.Debit Balance / Debits.Debit]
Sales Team_2026 / Plan_2026 / Tabel = management layers on top: KPI bonuses, liter plans vs actuals, monthly payroll.
```

## Rules of thumb when touching workbook-derived data
1. **Match by IDs, never names**: Customer ID (10000-10418...), ProductID (= Brand & Product_Name & Size, a *text concatenation*, matched case-insensitively), Order ID (`YYMMDDnn`).
2. Customer **10000 "Inventory"** is the internal stock account: its ORDERS rows have Total 0 (Discount = -UnitPrice) and are monthly stock-out/transfer entries of the pre-ERP period (2024-01 to 2025-06, one more batch 2025-12; 85.5k L in total). Exclude it from sales, from "customers", and from sales-velocity (the workbook itself excludes it with `<>10000`).
3. Money is **AMD**; USD only on purchases/costs and some cash rows (`Currency Rate` per row). FX constants differ by sheet (377.5 / 385 / 370) - they are not a single rate.
4. "0" in PriceList tier-price columns means **empty** (VLOOKUP of a blank cell). Bronze empty -> use silver (owner rule); gold empty -> silver -> bronze.
5. **Sales_Rep (ORDERS) = the channel that made the sale**, `Assigned To` (Customers) = the customer's home channel. ~26% of rows differ legitimately (e.g. SM YVN sells to Shirak customers). Performance/plan use ORDERS.Sales_Rep; customer ownership uses Customers.Assigned To.
6. The sheet layouts change between versions. First action on any new file: run `scripts/inspect_workbook.py`, diff headers against `references/sheet-dictionary.md`, then update `work/*.py` readers to accept both old and new names.
7. Personal data (salaries in `Tabel`, phones, TINs) is confidential: never copy it into code, docs, skills, PRs or chat.
