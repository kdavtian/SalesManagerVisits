# Data model

PostgreSQL, plain SQL migrations (`server/migrations/*.sql`, applied in
order by `server/src/db/migrate.js`) — no ORM, no schema-definition file
separate from the migrations themselves. 75 migrations, ~50 tables as of
this writing. This doc groups them by domain area with each table's
purpose and key relationships; it is **not** a column-by-column
dictionary — for exact columns/types, read the migration that created (or
last altered) the table, or introspect a running instance:

```sql
\d table_name              -- psql: full column/constraint detail
\dt                          -- list all tables
```

If this doc and the actual schema ever disagree, the schema (and the
migrations that built it) wins — this is a snapshot, not the source of
truth. Regenerate the foreign-key list below with:

```sql
SELECT tc.table_name, kcu.column_name, ccu.table_name AS references
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY' ORDER BY 1, 2;
```

## Identity and access

| Table | Purpose |
|---|---|
| `users` | One row per person. `role` (see [roles-permissions.md](roles-permissions.md)), `token_version` (bump invalidates every session), `last_seen_at`/`last_seen_app_version` (heartbeat). |
| `app_settings` | Singleton row: `lockdown_enabled` (emergency kill-switch, see [incident-response.md](incident-response.md)), `calculator_mode_enabled` (the app-disguise feature). |
| `push_subscriptions` | Web Push subscription per device, FK to `users`. |
| `user_locations` | Latest foreground GPS broadcast per user (see `broadcastsLocation` in roles-permissions.md). |
| `client_error_log` | Frontend error reports, FK to `users` (nullable — pre-login errors still get logged). |

## Customers

| Table | Purpose |
|---|---|
| `customers` | The core CRM record: name, location, tier, category, `assigned_manager_id`, `created_by`, optional `erp_customer_id` link. |
| `customer_edit_requests` | Proposed edits from a `sales_manager` awaiting admin review (the approval flow `canDeleteOrEditDirectly`-lacking roles go through). |
| `customer_level_audit` | History of tier/category changes. |
| `route_distribution` | Suggested region→channel/manager assignment used when creating a customer. |

## Check-ins

| Table | Purpose |
|---|---|
| `checkins` | GPS-verified visit record: `customer_id`, `user_id`, distance from customer, photo/note. |
| `checkin_photos` | One or more photos per check-in. |

## Orders

| Table | Purpose |
|---|---|
| `orders` | The order record: `customer_id`, `user_id`, `status` (state machine — see [offline-sync.md](offline-sync.md) and `server/migrations/051_warehouse_delivery_v3.sql`), `approval_status` (discount review), optional `checkin_id` link. |
| `order_items` | Line items, FK to `orders` and `products`. |
| `order_status_history` | Immutable audit trail (`BEFORE UPDATE` trigger rejects modification — migration `071`) of every status transition. |
| `daily_order_seq` | Sequence backing human-readable order codes. |

## Products and pricing

| Table | Purpose |
|---|---|
| `products` | Catalog: name, unit, standard/retail price, brand, active flag. |
| `product_price_history` | Every price change, who made it. |
| `product_promos` | Time-bounded special prices. |
| `company_profile` | Branding/contact info shown on generated pricelists. |

## Payments and cash custody

| Table | Purpose |
|---|---|
| `payments` | A collected payment: `customer_id`, `sales_manager_id`, `amount_amd`, `status` (`pending`/`approved`/`rejected`), `current_holder_id`, `pending_handoff_id`. |
| `payment_status_history` | Immutable audit trail, same trigger pattern as `order_status_history`. |
| `cash_handoffs` | One hop in the custody chain: `from_user_id`, `to_user_id`, `submitted_by`, `confirmed_by`/`rejected_by`. See [roles-permissions.md](roles-permissions.md)'s custody-chain table for who can hand off to whom. |
| `cash_handoff_items` | Which payments are bundled into a given handoff. |
| `cash_expenses` | Standalone cash-expense records (not tied to a customer payment). |

## Warehouse and delivery

| Table | Purpose |
|---|---|
| `delivery_routes` | A planned route: `driver_id`, `created_by`. |
| `route_stops` | Ordered stops on a route, FK to `orders`. |
| `pod_records` | Proof-of-delivery: signature, FK to `orders`, `payments`, `driver_id`. |

## ERP-sourced data (see [erp-integration.md](erp-integration.md))

Truncate-and-replace on every sync — treat these as a mirror of the ERP
export, not app-owned data.

| Table | Purpose |
|---|---|
| `erp_customer_data` | Debt balance and other ERP-side customer facts. |
| `erp_customer_first_seen` | First-seen tracking for new-customer detection. |
| `erp_order_lines` | Invoiced order line items — backs the Sales screen. |
| `erp_daily_report` | The CEO's daily summary numbers. |
| `generated_reports` | Pre-generated report files pushed from the ERP bot, stored as-is. |
| `report_access` | Who's viewed which generated report. |

## Team Performance

| Table | Purpose |
|---|---|
| `sales_channels` | Channel definitions (`owner_role`, optional `parent_channel_id` for hierarchy). |
| `perf_plans` | A channel's plan for a period: `created_by`, `submitted_by`, `approved_by`, `closed_by`, `supersedes_plan_id` (versioning). |
| `perf_plan_targets` / `perf_plan_brand_targets` | Target numbers per plan, optionally per brand. |
| `perf_plan_comments` | Review discussion on a plan. |
| `perf_plan_audit` | Action log (submit/approve/reject/reopen), `actor_id`. |
| `perf_plan_closed_snapshot` | Frozen final numbers once a month is closed — immutable by design. |
| `perf_actuals_brand_monthly` | Actual (as opposed to target) monthly numbers by brand. |
| `sales_performance` | ERP-sourced performance numbers backing actuals. |
| `monthly_points_closeouts` | Leaderboard/points closeout per user per month. |

## Visit planning

| Table | Purpose |
|---|---|
| `visit_plans` | A rep's planned route for a day/period: `user_id`, `created_by`, `reviewed_by`. |
| `visit_plan_rules` | Recurring planning rules. |

## Notifications

| Table | Purpose |
|---|---|
| `notifications` | In-app notification feed, FK to `users`. |
| `notification_delivery_log` | Push/Telegram delivery attempts and outcomes, FK to `notifications` and `users`. |
| `notification_settings` | Per-user notification preferences. |

## Misc

| Table | Purpose |
|---|---|
| `company_holidays` | Used by working-day calculations (performance targets, plan periods). |
| `schema_migrations` | Migration-runner bookkeeping — don't hand-edit. |

## Key relationship patterns

- **Almost every table references `users(id)`** (creator, actor, or
  subject) with **no `ON DELETE CASCADE`** — this is why deleting a user
  who has ever done anything in the app fails with a foreign-key
  violation; see the fix in `server/src/routes/users.js`'s `DELETE
  /:id` handler for the current behavior (a clear 409, not a raw error).
- **Immutable-history pattern**: `order_status_history` and
  `payment_status_history` both use a `BEFORE UPDATE` trigger that
  rejects modification (migration `071`) — append-only by design, `DELETE`
  is still allowed for legitimate cascade cleanup.
- **Versioning-by-supersession**: `perf_plans.supersedes_plan_id`
  self-references — a revised plan is a new row pointing at the one it
  replaces, not an in-place edit.
- **No database-level row-level security** anywhere — every access check
  in the tables above is enforced in the route handler that reads/writes
  them, per [roles-permissions.md](roles-permissions.md).
