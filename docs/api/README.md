# API overview

This is a conventions-and-map overview, not a full per-endpoint reference —
with ~36 route modules under `server/src/routes/`, the source is the
authoritative contract; use this doc to find the right file, then read it.

## Base

All routes are mounted under `/api` in `server/src/app.js`. Requests and
responses are JSON (`express.json()`) except file-upload endpoints
(`checkins`, some `customers`/`products` routes) which accept
`multipart/form-data`.

## Authentication

Session-based, not bearer tokens: `POST /api/auth/login` sets a signed
session cookie (JWT). Every subsequent request relies on that cookie —
there's no `Authorization` header to attach. `requireAuth`
(`server/src/middleware/auth.js`) gates any route that needs a logged-in
user; most routes go through it, either directly or via role-capability
checks layered on top (see [`../roles-permissions.md`](../roles-permissions.md)).

## CSRF

State-changing requests (anything not `GET`) additionally require a
`X-CSRF-Token` header matching the `csrf_token` cookie issued at login —
enforced by `requireCsrf` (`server/src/middleware/csrf.js`). The frontend's
`api.js` client attaches this automatically for any same-origin request;
this only matters if you're calling the API directly (`curl`, a script) —
see the direct-request example in
[`../incident-response.md`](../incident-response.md#3-contain) for what
that looks like in practice.

## Error format

Errors are JSON: `{ "error": "human-readable message" }`, with the HTTP
status carrying the category —

- `400` — bad input (missing/invalid fields), checked before touching the
  database.
- `401` — not authenticated (no/invalid session).
- `403` — authenticated, but the role doesn't have this capability.
- `404` — the resource doesn't exist (or doesn't belong to a scope this
  user can see — the API doesn't distinguish "not found" from "not yours"
  to avoid leaking existence).
- `409` — conflict (a unique-constraint hit, a state-machine transition
  that isn't valid from the resource's current status, an idempotency-key
  collision resolved as a duplicate).
- `423` — the app-wide Emergency Disconnect lockdown is engaged (see
  [`../incident-response.md`](../incident-response.md#3-contain)).
- `429` — rate-limited.
- `5xx` — unexpected server error; not intentionally shaped, worth a look
  at the logs (see [`../monitoring.md`](../monitoring.md)).

Some routes return a richer object on `409` (e.g. `customers.js`'s
duplicate-detection conflict payload includes the conflicting record) —
check the specific route file for anything beyond the plain `{ error }`
shape.

## Route areas

Grouped roughly by the domain areas in
[`../roles-permissions.md`](../roles-permissions.md) and
[`../data-model.md`](../data-model.md); see each file for the actual
handlers.

| Area | Routes | File(s) |
|---|---|---|
| Auth & identity | login/logout, current user, user management | `auth.js`, `users.js` |
| Customers | CRUD, social links, reassignment | `customers.js`, `customerSocial.js` |
| Check-ins | GPS-verified visit submission, photo upload | `checkins.js` |
| Visit planning | planned-visit scheduling | `visitPlans.js`, `routeDistribution.js` |
| Products & pricing | catalog, price lists | `products.js` |
| Orders | order lifecycle (draft → delivered) | `orders.js`, `orderMeta.js` |
| Warehouse & delivery | packing, stock-out, delivery confirmation | `warehouse.js`, `delivery.js` |
| Payments & cash custody | payment status, cash handoff chain, expenses, debt | `payments.js`, `cashHandoffs.js`, `cashExpenses.js`, `debtBalances.js` |
| Dashboard & reporting | admin dashboard, sales/team performance, exports | `dashboard.js`, `salesPerformance.js`, `teamPerformance.js`, `reports.js`, `exports.js` |
| ERP integration | external sync endpoints (see [`../erp-integration.md`](../erp-integration.md)) | `erpSync.js` |
| Data quality | duplicate/anomaly detection tooling | `dataQuality.js` |
| Notifications | push subscriptions, in-app + Telegram settings | `push.js`, `notifications.js`, `notificationSettings.js` |
| Locations & geocoding | map data, address lookup | `locations.js`, `geocode.js` |
| Edit requests | change-approval workflow for restricted fields | `editRequests.js` |
| Settings & company profile | app-wide/company settings | `settings.js`, `companyProfile.js` |
| Badges & gamification | rep badges | `badges.js` |
| Calculator lock | pricing-calculator lock state | `calculatorLock.js` |
| Emergency lockdown | app-wide kill switch | `lockdown.js` |
| Client error reporting | frontend error ingestion | `clientErrors.js` |

## Testing the API

`server/test/` has route-level integration tests (run via `npm test`) that
double as the most precise, always-current contract for request/response
shapes — when this doc and a test disagree, trust the test.
