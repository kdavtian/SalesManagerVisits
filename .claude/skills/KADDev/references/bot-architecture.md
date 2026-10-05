# Castrol CEO Telegram bot + ERP sync (repo `kdavtian/castrol_ceo_report`)

Python bot that turns the Castrol Excel workbook into reports and syncs data to the app. Runs on the same droplet as the app: `/opt/castrol-ceo-bot` (git checkout, venv at `venv/`), systemd unit `castrol-ceo-bot` (user `castrolbot`, `EnvironmentFile=/etc/castrol-ceo-bot.env` holds the Telegram token), config `automation/config.json` (git-untracked; has `field_visits_sync` {enabled, api_url=`https://fieldvisits.164.92.171.41.sslip.io/api/erp-sync`, api_key = app's `ERP_SYNC_KEY`}). Deploy: `cd /opt/castrol-ceo-bot && sudo -u castrolbot git pull origin main && sudo systemctl restart castrol-ceo-bot` (the `deploy/deploy.sh` helper also exists). Original Windows PowerShell scripts remain in `automation/`.

## Flow
1. Accountant posts the workbook (e.g. `Castrol_2.0.7.xlsx`) into the Telegram group/bot chat. `TelegramAgent._handle_document` (automation/ceo_agent.py) downloads, `validate_source` (required sheets ORDERS, PriceList, Cashflow, Debits, Inventory, Plan_2026; min order rows) and runs `ReportPipeline`: builds CEO report (`work/build_ceo_report.py`), sales-director data/report (`work/build_sales_director_*.py`), debt Excel, Armenian text briefings (daily/weekly/monthly/quarterly/annual), snapshots in history dir.
2. After a workbook is accepted, `work/sync_field_visits.py` pushes to the app (sync failures are logged, never block reports). Manual run: `cd /opt/castrol-ceo-bot && sudo -u castrolbot ./venv/bin/python work/sync_field_visits.py --config automation/config.json` (workbook path comes from config `paths.active_workbook`, default `Castrol.xlsx` in repo root; the CLI takes `--source` only if the arg is named so). Easiest: re-send the new file to the bot in Telegram.
3. Generated Excel workbooks + daily/period report payloads also go to the app (`/api/erp-sync/daily-report`, `/api/erp-sync/reports`) so the Reports page and push "daily report ready" work.

## Files
- `automation/ceo_agent.py` (~3.6k lines): config, `ReportPipeline`, Armenian text builders (`build_period_briefing`, `build_management_focus_report`, `debt_analysis`, `manager_scorecard`), `TelegramAPI`, `TelegramAgent` (buttons, admin access commands, role-based access `normalize_staff_role`), `FolderWatcher`, `main` (`telegram` subcommand).
- `work/build_ceo_report.py`: `Source` (openpyxl workbook wrapper), helpers `price_value(row, *names)` (reads tier price columns, tolerant of old/new names), `number`, `parse_date`, `rows_for_sheet(workbook, name, header_row)`, `period_metrics`, `build_ar_detail` (aging), `build_inventory`, `product_recent_velocity`, `build_cash_balance`, `build_plan`, `run_checks`, `build_report_data`, `build_workbook`.
- `work/build_sales_director_data.py` / `_report.py`: per-channel/per-manager sales data (new price column names; inventory "Price T2" fallback).
- `work/sync_field_visits.py` (~900 lines): `build_extract` (customers incl. debt, `balance0_amd`, last payment from Cashflow, aging, region/subregion, `erp_tier`), `build_order_lines`, `build_cashflow_lines`, `build_sales_performance` (Sales Team sheet; falls back to ORDERS when Sales cell is an error), `build_missing_channel_performance`, `build_brand_volume`, `build_products` (PriceList -> tier prices, landing cost, hc_code, stock), `sync`, `build_daily_report_payload`, `build_period_report_payload`, `sync_report_file`.

## Workbook (source of truth) - sheets used
`ORDERS` (order lines per customer, with per-product Discount column), `PriceList` (header row 2: ProductID, Brand, Product_Name, Size L, `Price T1 Bronze`, `Price T2 Silver`, `Price T3 Gold`, Landing Cost, ...; older names `Price T1`, `GMM Price T3`), `Products` (header row 3; has `hc_code`), `Cashflow` ("Oil order" rows, signed amounts), `Debits` (Customer ID, Balance0, debt), `Customers` (header row 2; region/subregion/Tier), `Inventory`, `Plan_2026`, `Sales Team_2026` (rows Sales/Collected/Budget per channel; cells can be Excel errors -> fallback). The owner changes column names/structure occasionally (2.0.5 -> 2.0.7) - when told "I updated the file structure", diff headers, make readers accept both old and new names, and say what changed. Never match by name; use Customer ID / ProductID.

## Payload contract (see app `docs/erp-sync-contract.md`; code wins)
`POST /api/erp-sync` with `X-Sync-Key`: `customers[]` (required: erp_customer_id, customer_name, assigned_sales_rep, debt_amd, balance0_amd, last_payment_date, days_since_payment, aging_bucket, recent_orders, region, subregion, erp_tier), optional `order_lines[]`, `cashflow_lines[]`, `sales_performance[]`, `products[]` (upsert; gated by `manually_edited_at`, but landing cost and `hc_code` always apply), `brand_volume[]`. Omitted key = table untouched; empty array = table wiped (TRUNCATE-and-replace, except products).

## Pricing in the sync
bronze = `Price T1 Bronze` (fallback `Price T1`); if empty -> use silver (`Price T2 Silver`); skip product only if no price at all. silver = T2 (falls back to bronze), gold = T3 (None if empty; the app falls back gold -> silver -> bronze). `unit_price_amd` mirrors bronze. 

## Debt-as-of-date logic (owner-specified)
debt(customer, D) = `Balance0` (Debits/Customers sheet) + SUM(ORDERS revenue up to D) - SUM(Cashflow "Oil order" payments up to D), by Customer ID. App implements this from `balance0_amd`, `order_lines`, `cashflow_lines`; "live" uses the Debits snapshot. Last payment date = latest of app payments and Cashflow rows.

## Bot dev notes
- No tests dir; verify by running the builders against a sample workbook and by `python -c "import ast..."` syntax checks. CI (GitHub Actions) was added for the bot at the owner's request - check the workflow before pushing; the runner can sit "queued".
- Armenian text everywhere in Telegram output; keep AMD formatting consistent (`format_amd_hy`).
- Windows PC no longer runs the bot; only one process may use the Telegram token.
