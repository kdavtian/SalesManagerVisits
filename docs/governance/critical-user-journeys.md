# Critical user journeys

These are the workflows where a break is a **High or Critical** severity
incident by definition (see [severity-definitions.md](severity-definitions.md)),
because the business runs on them daily. Any PR touching the files listed
for a journey should be treated as higher-risk review, and any incident
affecting one should be triaged at least High.

| # | Journey | Primary role(s) | Key entry points (routes/views) | Why it's critical | If broken |
|---|---|---|---|---|---|
| 1 | **Login & session** | All | `server/src/routes/auth.js`, `server/src/middleware/auth.js` | Gates every other journey. | Nobody can use the app at all. **Critical.** |
| 2 | **Field check-in** (GPS-verified visit at a customer, optional photo/note) | `sales_manager` | `server/src/routes/checkins.js`, `client/public/js/views/map.js` | The core field activity the whole app exists to capture. Works offline and queues (see #9). | Field reps can't log visits; if it also breaks the offline queue, visit history for that day is at risk. **High**, **Critical** if it also breaks offline queuing. |
| 3 | **Order lifecycle**: create → submit → confirm (director) → pack (warehouse) → deliver (driver, POD signature) → recorded (accountant) | `sales_manager`, `sales_director`/`ceo`, `warehouse_manager`, `delivery_manager`, `accountant` | `server/src/routes/orders.js`, `warehouse.js`, `delivery.js`; `client/public/js/views/orders.js`, `recorded.js` | This is the revenue path — every sale flows through it. A break anywhere in this chain stalls real orders mid-flight. | Orders stuck in one status, undeliverable, or (worse) double-created/double-delivered. **High**, **Critical** if it causes financial double-counting. |
| 4 | **Payments & cash custody**: submission → approval, cash handoff between holders | `sales_manager`, `accountant`, `sales_director`/`ceo`/`admin` | `server/src/routes/payments.js`, `cashHandoffs.js` | Directly touches money. Has DB-level duplicate-payment detection and immutable audit trails (`payment_status_history`) specifically because of this. | Missed, duplicated, or unaccountable cash. **Critical** — this is the one journey where a bug can look like theft even when it's just a bug. |
| 5 | **Delivery route planning** | `delivery_manager` (plans), driver (`delivery_manager` role, executes) | `server/src/routes/delivery.js`, `osrm.js` | Determines whether packed orders actually reach customers same-day. | Deliveries delayed or misrouted; degrades gracefully to straight-line distance if OSRM itself is down, but not if the planning endpoints are. **High.** |
| 6 | **Visit plan submission & approval** | `sales_manager` (submits), `admin`/`sales_director`/`ceo` (approve) | `server/src/routes/visitPlans.js` | Sets each rep's planned stops for the day, which check-ins and overdue-visit tracking are measured against. | Reps can't plan their day, or planned/actual visit tracking goes wrong for everyone downstream. **High.** |
| 7 | **ERP sync ingestion** (external bot push) | System (external Python pipeline) | `server/src/routes/erpSync.js`, contract in `docs/erp-sync-contract.md` | Every ERP-sourced number in the app (debt balances, sales performance, brand actuals) depends on this landing correctly. TRUNCATE-and-replace semantics mean a bad push can wipe good data, not just skip an update. | Reports/dashboards silently show stale or wiped ERP data across the whole company. `erpSyncMonitor.js` alerts after 72h stale, but a *bad* (not just missing) push isn't caught by that at all. **High**, **Critical** if a bad push destroys data with no way to re-pull it. |
| 8 | **Offline queue & sync** (check-ins/orders created without connectivity, replayed on reconnect) | `sales_manager` | `client/public/js/offlineQueue.js`, idempotency via `client_ref` on `server/src/routes/orders.js` / `checkins.js` | Field reps routinely work in low/no-signal areas; this is what makes the app usable there at all. | Data silently lost, or (if idempotency breaks) duplicated on reconnect. **Critical** if it loses data; **High** if it duplicates it. |
| 9 | **Notifications & daily summary** | All (recipients vary by event); `admin`/`ceo`/`sales_director`/`accountant` (daily summary) | `server/src/notifications.js`, `push.js`, `dailySummary.js` | The mechanism by which unresolved work (pending orders/payments/overdue visits) surfaces to the people who need to act on it. | Silent — nobody notices anything is wrong until someone happens to check manually. **Medium** on its own, but raises the severity of whatever it failed to surface. |
| 10 | **Emergency lockdown (kill-switch)** | `admin` | `server/src/routes/lockdown.js`, `client/public/js/lockdownScreen.js` | The safety mechanism for a real security incident — logs every session out and blocks all data until lifted. | If this doesn't work during an actual incident, there is no fallback. **Critical**, tested rarely by definition — treat any change here as maximum-scrutiny. |

## Coverage note

Journeys 3, 4, and 8 have integration-test coverage
(`server/test/integration/orderLifecycle.test.js`, `rolePermissions.test.js`,
`offlineIdempotency.test.js`). Journeys 1, 7, 9, and 10 currently have
**no automated test coverage** — that gap belongs in the [risk
register](risk-and-technical-debt-register.md) the next time it's revisited
in depth; it's noted here rather than duplicated there to avoid the two
documents drifting out of sync.
