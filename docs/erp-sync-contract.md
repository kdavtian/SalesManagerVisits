# ERP sync JSON contract

Reference for the external Python pipeline (`ceo_agent.py` / `work/sync_field_visits.py`
on the sync PC) that pushes data into this app. Written directly from the
parsing code in `server/src/routes/erpSync.js` -- if this doc and that file
ever disagree, the code wins; update this doc to match it, not the other way
around.

Both endpoints require the header `X-Sync-Key: <ERP_SYNC_KEY>` (the shared
secret, set as an env var on this app's server -- not a user's login token).

## POST /api/erp-sync

The main extract sync. `customers` is the only required field; everything
else is an independent optional array -- omitting a key entirely leaves that
table untouched by this call (its data stays whatever the last sync with
that key present left it). Sending an *empty* array `[]` for a key that was
previously present, on the other hand, DOES wipe that table -- these are all
TRUNCATE-and-replace-whole tables, not merged row by row (except `products`,
which is upsert-only and never truncated).

```jsonc
{
  "customers": [
    {
      "erp_customer_id": "12345",       // required -- entry skipped without it
      "customer_name": "...",
      "assigned_sales_rep": "SM YVN",    // free-text rep/channel name
      "debt_amd": 150000,
      "last_payment_date": "2026-08-20", // YYYY-MM-DD
      "days_since_payment": 12,
      "aging_bucket": "0-30",
      "recent_orders": [ /* up to 10 kept */ ],
      "region": "Yerevan",               // only backfills customers.region where still unset
      "subregion": "Kentron"
    }
  ],

  "order_lines": [
    {
      "erp_customer_id": "12345", "order_id": "ORD-1", "date": "2026-09-01", // all three required
      "product_id": "P1", "brand": "Castrol", "product": "...", "size_l": "4",
      "qty": 4, "unit_price_amd": 12000, "revenue_amd": 48000
    }
  ],

  "sales_performance": [
    {
      "rep_name": "SM YVN",              // required -- matches sales_channels.code
      "monthly": [
        { "month": "2026-09-01", "sales_amd": 5000000, "collected_amd": 4800000, "budget_amd": 6000000 }
      ]
    }
  ],

  "products": [
    {
      "erp_product_id": "P1", "name": "...", "unit_price_amd": 12000, // all three required
      "brand": "Castrol", "unit": "L", "family": "...",
      "bronze_price_amd": 12000, "silver_price_amd": 11500, "gold_price_amd": 11000,
      "stock_qty": 240
    }
  ],

  // Backs the "Brand volume" report (server/src/routes/reports.js
  // GET /reports/brand-volume) and Team Performance's own actuals.
  // THIS KEY MUST BE PRESENT for that report to ever show anything -- if
  // it's omitted from every sync call, perf_actuals_brand_monthly is never
  // written and the report stays permanently empty.
  "brand_volume": [
    {
      "channel_code": "SM YVN",    // required -- matches sales_channels.code
      "month": "2026-09-01",       // required -- first-of-month date
      "brand": "castrol",          // required
      "liters": 320.5
    }
  ]
}
```

Response: `{ synced, order_lines_synced, sales_performance_synced, products_synced, brand_volume_synced }`
-- each `*_synced` count is `undefined` (not `0`) when that key was omitted
from the request, so the pipeline can tell "I sent an empty batch" apart
from "I didn't send this at all". **If `brand_volume_synced` keeps coming
back `undefined`, the `brand_volume` key isn't being sent.**

## POST /api/erp-sync/daily-report

Separate, standalone endpoint on its own daily schedule -- the CEO Telegram
bot's sales/collections/balance summary, pushed here once per
`(period, report_date)` so it's also browsable in-app
(`GET /reports/daily-management?period=...`). Upserted by `(period,
report_date)`: a same-day re-push of the same period replaces, never
duplicates.

`period` is optional in the request and defaults to `"daily"` -- pass
`"weekly"`, `"monthly"`, `"quarterly"`, or `"annual"` to push that period's
own snapshot instead (e.g. `build_ceo_report.py`'s `operational_reports`
already computes all five; loop over them and call this endpoint once per
period). Only a `period: "daily"` push triggers the `daily_report_ready`
push notification -- the other periods land at the same time and would
just be a duplicate ping.

**If this endpoint is never called at all, the "Daily management report"
page has nothing to show -- it isn't derived from the other synced tables,
only from what's pushed here.**

```jsonc
{
  "report_date": "2026-09-08",   // required, YYYY-MM-DD
  "period": "daily",             // optional, default "daily" -- one of daily/weekly/monthly/quarterly/annual

  "sales": {
    "ytd_amd": 0, "ytd_liters": 0, "ytd_orders": 0,
    "mtd_amd": 0, "mtd_liters": 0, "mtd_orders": 0,
    "wtd_amd": 0, "wtd_liters": 0, "wtd_orders": 0,
    "day_amd": 0, "day_liters": 0, "day_orders": 0,
    "change_amd": 0, "change_liters": 0,       // vs. previous comparable period; omit/null if N/A
    "margin_amd": 0, "margin_pct": 0,
    "by_channel": [ { "channel_code": "SM YVN", "amd": 0, "liters": 0, "orders": 0 } ]
  },

  "payments": {
    "ytd_amd": 0, "ytd_customers": 0,
    "mtd_amd": 0, "mtd_customers": 0,
    "wtd_amd": 0, "wtd_customers": 0,
    "day_amd": 0, "day_customers": 0,
    "by_channel": [ { "channel_code": "SM YVN", "amd": 0, "customers": 0 } ]
  },

  "balance": {
    "amd": 0, "usd": 0,
    "total_amd": 0, "total_usd": 0,
    "cash_amd": 0, "cash_usd": 0,
    "noncash_amd": 0, "noncash_usd": 0,
    "with_managers_amd": 0,
    "with_managers_by_manager": [ { "manager_name": "...", "amd": 0 } ],
    "credit_line_usd": 0,
    "receivables_total_amd": 0, "receivables_net_amd": 0,
    "warehouse_value_amd": 0, "warehouse_liters": 0,
    "prev_report_date": "2026-09-07",  // optional, for the "change since" line
    "change_total_amd": 0, "change_overdue_amd": 0
  }
}
```

`sales`, `payments`, and `balance` objects are all required (can't be
omitted), but every individual field inside them is optional -- anything
missing or non-numeric is stored as `NULL` and the report shows "—" for it
rather than erroring. `report_date` is the only hard requirement.

Response: `{ synced: true, report_date, period }`.

## POST /api/erp-sync/reports

Pushes a generated report *file* (Sales Director workbook, debt/receivables
Excel, CEO management workbook) exactly as the Python pipeline already
builds it -- not re-parsed into structured columns, just stored and made
downloadable in-app (`GET /reports/documents`, `GET
/reports/documents/:id/download`). This is deliberate: those workbooks are
rich, multi-sheet files (dashboards, charts, full inventory, price lists)
that would be a large, drift-prone effort to re-derive as native app
screens, so the app just serves the real file back.

`multipart/form-data`, not JSON (same `X-Sync-Key` header auth as every
other endpoint on this router):

| Field | Required | Notes |
| --- | --- | --- |
| `report_type` | yes | one of `sales_director`, `debt_receivables`, `ceo_management` |
| `report_date` | yes | `YYYY-MM-DD` |
| `file` | yes | the workbook itself, as a file part |

Upserted by `(report_type, report_date)`: a same-day re-push replaces, never
duplicates. Triggers a `generated_report_ready` push notification to every
admin/ceo/sales_director/accountant user.

Response: `{ synced: true, report_type, report_date }`.

## Quick way to tell which side the problem is on

- `GET /api/reports/customer-debt` and `sales-budget` have data (fed by
  `customers` / `sales_performance`, sent on every regular sync) but
  `brand-volume` / `daily-management` are empty → the pipeline isn't sending
  `brand_volume` and isn't calling `/daily-report` yet. This is the pipeline
  side, not an app bug.
- A sync call is being made (check `*_synced` counts in the main sync's
  response, or a 200 from `/daily-report`) but the report still shows no
  data in-app → that's an app bug, worth a fresh report with the actual
  response body from the sync call.
