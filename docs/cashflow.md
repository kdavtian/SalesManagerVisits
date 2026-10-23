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

## Not yet (next phases, owner's list)
- Add / edit entries in the app and switch Excel off (rows from Excel are read-only while Excel is the source).
- Bank statements (CSV / Excel) from the Telegram group -> automatic entries (`origin = 'bank'`) with matching to customers and duplicate detection.
- Salary payments linked to Staff (payroll) so the salary balance = what is due minus what the ledger paid.
