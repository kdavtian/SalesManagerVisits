# Ops API (`/api/ops/v1`): the Claude agents' read-only feed

Owner, 2026-11-07: Claude scheduled agents (cloud scheduled tasks) work while the owner sleeps: a daily **Reconciler** (app vs Excel,
message only when something differs), a **Monday business brief**, later analyst / department agents (cash forecast, churn, purchasing).
They read the app through this API and nothing else.

## The privacy rule (owner's decision, 2026-11-07)

Agents never see personal data. Customer and staff names, phones, addresses, TINs, salaries, notes and free text **never leave the app**.

- A customer appears only as its **ERP customer ID** (`customer_erp_id`; `null` for a customer the Excel does not know yet).
- No staff appear at all (no rep, holder or creator, not even as a code).
- Amounts are **whole AMD**; dates are `YYYY-MM-DD` (Yerevan calendar) or ISO timestamps.
- No error text (a sync error can quote a customer): only counts and endpoint names.
- `test/integration/opsApi.test.js` seeds a customer and a rep with a name, phone, TIN, address and legal name, calls every endpoint and
  fails when any answer has a name / phone / TIN / address / email / salary / note / rep / user field, or contains any of the seeded values.
  A new endpoint must be added to that scan.

## Access

- `Authorization: Bearer kad_ops_...`: an integration token of scope **`ops-read`** (migration 194). Only this router accepts it; Lily's
  `/api/integration/v1` answers **403 `wrong_scope`** to it, and this router answers 403 to Lily's `accounting` token. No / unknown / revoked
  token: **401**. A person's login cookie is not accepted.
- **GET only** (HEAD too; anything else: 405). 30 requests a minute per address (429 after that). `Cache-Control: no-store`.
- Every call is written to `integration_audit_log` (token, path, status, IP). An ops token does not make Lily look "online".
- Errors: `{ "error": { "code", "message" } }`, also for a server failure (500 `internal`, never with the underlying text).

### Creating and revoking the token (admin)

On the droplet (the token is printed ONCE; put it straight into the agent's secret settings, never into a chat):

```
cd /opt/field-visits && docker compose exec app node scripts/integration-token.mjs create "Claude agents" --ops
docker compose exec app node scripts/integration-token.mjs list
docker compose exec app node scripts/integration-token.mjs revoke <id>
```

Or as admin over the app API: `POST /api/integration-tokens {"name":"Claude agents","scope":"ops-read"}`; list / revoke as for Lily
(docs/lily-integration.md). Only a SHA-256 of the token is stored.

## GET /reconcile

What the app knows differs from the Excel. Every rule is the one the app's own screens use, so the agent can never disagree with the app.
A row younger than `grace_days` (the anti-fraud "not in Excel after N days" setting, default 3) is not called missing yet. Each module looks
back as far as the screen whose rule it uses: cash payments and field expenses 120 days (Fraud alerts / Expense watch), bank payments,
deliveries and returns 60 days (the live debt's window; an older unmatched delivery is a known data gap for Data quality, not news).

```json
{
  "ok": false,                       // true only when every module is empty, no sync failed since the last success (24 h),
                                     // and neither the sync nor the workbook file is older than 72 h
  "generated_at": "2026-11-07T05:00:00.000Z",
  "grace_days": 3,
  "modules": {
    "cash_payments":  { "count": 1, "amount_amd": 12345, "oldest_age_days": 10, "truncated": false,
                        "items": [{ "customer_erp_id": "1234", "kind": "cash_payment_not_in_excel", "amount_amd": 12345, "age_days": 10 }] },
    "bank_payments":  { ... "kind": "bank_payment_not_in_excel" },
    "orders":         { ... "kind": "order_not_in_excel" },
    "returns":        { ... "kind": "return_not_in_excel" },
    "field_expenses": { ... "kind": "field_expense_not_in_excel", "customer_erp_id": null }
  },
  "erp_sync": { "last_success_at": "...", "hours_since_success": 5.2, "workbook_age_hours": 20.5, "stale": false, "workbook_stale": false, "stale_after_hours": 72,
                "failed_attempts_24h": 0, "failed_endpoints_24h": [] }
}
```

| Module | Rule (source) |
|---|---|
| `cash_payments` | app payment (pending / approved) with an ERP id and no Excel cashflow line of the same amount within 5 days (`money/paymentExcelMatch.js`, the Payments page and Fraud alerts) |
| `bank_payments` | bank / card payment (Bank & cash desks) whose books are still open, since the payments cut-over (`money/liveDebt.js`, the money board) |
| `orders` | app order delivered, not delivered by the sync, and not matched to an Excel order (`erp_matched_order_id`; `orders/appStock.js`) |
| `returns` | goods returned to the warehouse (done) the Excel does not have yet (`recorded_at` empty; `orders/appStock.js`) |
| `field_expenses` | rep's field cash expense with no Excel expense row of the same amount within 5 days, after 5 days (`money/expenseWatch.js`) |
| `erp_sync` | the Settings > Excel sync status (`erp/erpSyncStatus.js`): last success, sync and workbook file age (stale after 72 h); failed attempts of the last 24 h that came after the last success (a failure fixed by a retry does not count) |

`items` lists at most 50 rows per module, oldest first (`truncated: true` when there are more); `count` / `amount_amd` cover all of them.

## GET /kpi?period=week|month[&mode=complete|to_date]

- `period=week`: `complete` (default) = the last Monday-Sunday week; `to_date` = this Monday .. today. Last year = the same weekdays
  52 weeks earlier.
- `period=month`: `complete` = the last calendar month; `to_date` = the 1st .. today. Previous and last year use the same day numbers.

```json
{
  "period": "week", "mode": "complete", "currency": "AMD", "today": "2026-11-09",
  "data_through": { "sales": "2026-11-08", "collections": "2026-11-08" },   // the Excel's latest order / cashflow date
  "flows": {
    "current":   { "from": "2026-11-02", "to": "2026-11-08", "sales_amd": 0, "liters": 0, "gross_profit_amd": 0, "gross_margin_pct": null,
                   "cost_coverage_pct": null, "orders": 0, "active_customers": 0, "collections_amd": 0 },
    "previous":  { ... },
    "last_year": { ... }
  },
  "change_pct": { "vs_previous": { "sales_amd": 12.5, ... }, "vs_last_year": { ... } },   // null when the base is 0
  "receivables": { "as_of": "2026-11-09", "total_amd": 0, "overdue_amd": 0, "customers": 0,
                   "aging_buckets_amd": { "not_due": 0, "d1_30": 0, "d31_60": 0, "d61_90": 0, "d90_plus": 0, "opening": 0 },
                   "top_debtors": [{ "customer_erp_id": "1234", "debt_amd": 0, "overdue_amd": 0, "oldest_due_days": 12 }] },
  "stock": { "as_of": "...", "value_landing_amd": 0, "products_in_stock": 0, "products_without_landing_cost": 0 }
}
```

- **Flows** come from the Excel (ERP order lines and cashflow), customer 10000 excluded (the same rule as Operations control and Ask KAD).
  `liters` = quantity x pack size. `orders` = distinct Excel orders, `active_customers` = customers with a sale.
  `collections_amd` = incoming cashflow lines.
- **Gross profit** = revenue - quantity x the product's **current** landing cost, over the lines whose product has a landing cost;
  `cost_coverage_pct` says how much of the revenue that covers (below ~95 % the margin is less reliable).
- **Receivables** = the live debt the app shows everywhere (Excel debt + app deliveries - app payments the Excel lacks, net of frozen
  credit; `money/liveDebt.js`), aged by due date (`money/debtAging.js`); top 10 debtors by ERP id. A snapshot of today, not of the period.
- **Stock** = Excel stock of active products x landing cost, as of the last sync.
