# Cashflow module (owner, 2026-10-23)

The Excel **Cashflow** sheet (table `Cash`: one row per money movement) lives in the app too. Phase 1: Excel stays the source, the app mirrors it.

## Data
- `cash_accounts` (the sheet's `Source`: Cash, Cash YVN, EvocaBank AMD, ABB Bank USD, Evoca Credit Line ...; names compare case-insensitively, `Evocabank AMD` = `EvocaBank AMD`).
- `cash_categories` (the sheet's `For`) with a **kind**: `income` (Oil order), `expense` (Purchase, Customs, Tax, Salary, Fuel, ...), `owner` (Divident, Personal, Armen Loans, Investment), `internal` (To bank, Exchange, Transfer, Balance, Credit Line, Poxarutyun, Veradarcvox). **Internal moves are never counted as money in or out.** A category the sheet invents is created as `expense` until classified.
- `cash_entries`: signed `amount` in `currency` (AMD / USD), `fx_rate` (USD rows), `amount_amd`, `erp_customer_id` (Oil order rows) or `ref` (other rows: plate, model...), `info`, `sales_rep`, `transaction_id`, `origin` (`excel` | `manual` | `bank`).
- `cash_syncs`: every refresh (who / how many rows).

## How the ledger gets in (both replace ONLY the `origin = 'excel'` rows; manual rows stay)
1. **Bot**: after its usual Field Visits sync the bot (`work/sync_field_visits.py`, repo castrol_ceo_report) posts every sheet row to `POST /api/erp-sync/cashflow-ledger` (header `X-Sync-Key`, body `{ "rows": [{date, amount, currency, for, id, source, info, currency_rate, amount_amd, sales_rep, transaction_id, excel_row}] }`).
2. **Upload**: Cashflow -> "Import Excel" (admin / CEO / accountant) reads the workbook's `Cashflow` sheet (header row found by its labels).

## Balances
Per account and currency: `SUM(amount)` up to the chosen date. They match the sheet's own control-panel balances (`SUMIFS(Cash[Amount], Cash[Source], x, Cash[Currency], c)`): verified on the 2.1.1 workbook (10 of 11 sources exactly; Cash YVN differed by one 50,000 row, probably a stale cached value in the sheet).

## Who
Read: admin, CEO, operations director, accountant. Import / change: admin, CEO, accountant. (Salaries are in this ledger, so no sales roles.)

## Add / edit in the app (phase 2, 1.391.0)
Admin / CEO / accountant: **Add** on the Cashflow screen (direction In / Out + a positive amount, date, currency + USD rate, account, category, customer ID for "Oil order", sales channel, note; new accounts / categories can be created in the form). Tap a row made in the app to edit or delete it. Rows that came from Excel are read-only while Excel is the source (the next refresh replaces them); rows made in the app (`origin = 'manual'`) are never touched by a refresh. Salary: pick the Staff person and the month and the note becomes `<position> YYYY MON`, which is what Staff matches payments on.
Risk (shown behind the "!"): the same movement entered in both Excel and the app is counted twice, until Excel is switched off.

## Not yet (next phases, owner's list)
- Switching Excel off (stop the bot push / upload, Excel rows become editable) -- waits for the owner's decision, because customer debt and the CEO bot still read the workbook.
- Bank statements (CSV / Excel) from the Telegram group -> automatic entries (`origin = 'bank'`) with matching to customers and duplicate detection.

## Bank statements (phase 3a, 1.398.0, migration 146)
Excel stays the main ledger for now, so a bank line and its Excel row are the **same money**; the statement is reconciled, never added blindly.
* **Upload** (Cashflow -> Bank, accountant / CEO / admin): pick the bank account and the statement file (CSV with `,` `;` tab or `|`, UTF-8 / UTF-16 / Windows-1251, or `.xlsx`). The header row is found by its words (English, Armenian, Russian: Date, Amount or Debit / Credit, Description, Counterparty, Reference, Currency, Balance); when it is not recognised the sheet asks which column holds what. A preview shows the lines, the period and how many are already imported; nothing is saved until "Import".
* **No double import**: every line keeps a hash (account, date, amount, currency, reference, text, balance, and its order inside the file); importing the same or an overlapping statement again skips the lines already kept. Lines in another currency than AMD / USD are skipped and counted.
* **Reconciliation** (computed from the current ledger every time, because the Excel refresh replaces its rows): a line is **matched** when the ledger has a row of the same account, the same signed amount and currency within 3 days (nearest date first, every row used once). Matched ledger rows show a green "bank" mark. Lines with no row are **To check**: *Add to Cashflow* makes a manual row (origin `bank`; the category is chosen, the customer ID optional) or *Ignore* (can be reopened). If the Excel row arrives later, the line turns into a match by itself. The red number on "Bank" is the count of lines to check.
* API: `POST /api/cashflow/bank/preview|import`, `GET /bank/lines`, `POST /bank/lines/:id/add|ignore|reopen`.
* Phase 3b (next): the bot picks the statement up from the Telegram group and posts it to the same import (owner: "now upload in the app and then automatically to Telegram").
