# Monitoring

**Honest status**: there is no external uptime monitoring or metrics
dashboard today — see the availability row in
[`governance/service-objectives-and-security.md`](governance/service-objectives-and-security.md).
This doc describes what actually exists to observe the app's health, and
what's genuinely missing.

## What exists today

### Health and readiness endpoints

`GET /api/health` — liveness only, no dependency checks. Used by:
- The Docker `HEALTHCHECK` in `Dockerfile` (container-level restart
  trigger if the process stops responding). Deliberately stays on this
  endpoint, not `/api/ready` below — a DB outage shouldn't make Docker
  restart the app container in a loop, since restarting the app can't fix
  a downstream database problem.
- `deploy/deploy.sh`'s `docker compose run --rm app npm run migrate` step
  implicitly depends on the `db` health check passing first.

`GET /api/ready` — also confirms Postgres is actually reachable (a short
`SELECT 1` with a 3s timeout), returning `503` if not. Registered ahead of
`lockdownGate`/CSRF middleware in `app.js` on purpose, since those also
touch the database — a DB-down check has to survive the DB being down.
Used by:
- `server/scripts/verify-deployment.mjs` (run at the end of every deploy)
  polls both endpoints — health first, then readiness — before declaring
  the deploy successful, so a deploy that came up but can't reach the
  database (bad credentials after a `.env` edit, wrong database) fails
  verification instead of getting recorded as a known-good deploy.

Nothing external polls either endpoint — no uptime service is wired up.
**Adding one (even a free-tier external check hitting `/api/health`) is
the single highest-value gap to close here.**

### Application-level monitors (in-process, no separate infra)

These all run as `setInterval` timers inside the one Express process
(see [`governance/architecture.md`](governance/architecture.md) — no
separate job runner exists):

| Monitor | File | What it watches | Alerts via |
|---|---|---|---|
| ERP sync staleness | `server/src/erpSyncMonitor.js` | Any ERP-sourced table not synced in >72h (`ERP_STALE_AFTER_HOURS`, `erpSyncFreshness.js`) | Notifies admin/CEO in-app + Telegram if configured |
| Overdue visits | `server/src/overdueReminders.js` | Planned visits that passed without a check-in | Rep notification |
| Stale packed orders | `server/src/stalePackedReminder.js` | Orders sitting in `packed_stock_out` too long without delivery | Warehouse/delivery notification |

### Logs

- Application logs go to stdout/stderr — captured by `docker compose logs
  app` (or `docker compose logs -f app` to follow). No log aggregation/
  shipping to an external service.
- `client_error_log` table (see [`data-model.md`](data-model.md)) —
  frontend JS errors reported from the browser, queryable directly.
- `notification_delivery_log` — every push/Telegram delivery attempt and
  its outcome, useful for debugging "why didn't this alert arrive."

### Dependency/security scanning

- `npm audit --audit-level=high` runs in CI on every PR.
- Dependabot opens PRs weekly for outdated dependencies.

Neither of these is "monitoring" in the uptime sense, but both are the
closest thing this repo has to automated security observability — see
[`../SECURITY.md`](../SECURITY.md).

## What's missing

- **External uptime/availability monitoring.** Nothing alerts if the
  droplet or app goes down; the first signal today is a user reporting it.
- **Resource metrics** (CPU, memory, disk, Postgres connection count).
  No Grafana/Prometheus/equivalent. A slow disk-fill on the `uploads_data`
  volume, for example, would surface as a confusing upload failure, not a
  clear "disk 90% full" alert.
- **Log aggregation/search.** `docker compose logs` on the droplet
  directly is the only way to see application logs; nothing is shipped
  off-box or indexed.
- **Structured alerting escalation.** The in-app/Telegram notifications
  above go to whichever users are configured — there's no on-call
  rotation, paging service, or escalation policy (see
  [`governance/release-and-incident-ownership-matrix.md`](governance/release-and-incident-ownership-matrix.md),
  which states this plainly for a one-person team).

## Where to look when something seems wrong

1. `GET /api/health` — is the process even responding? Then `GET
   /api/ready` — can it actually reach Postgres?
2. `docker compose ps` on the droplet — are all three containers
   (`app`, `db`, `osrm`) up?
3. `docker compose logs --tail=200 app` — recent errors.
4. Settings → Data & Sync (in-app) — for a specific user's own
   sync/offline-queue state.
5. `client_error_log` / `notification_delivery_log` tables — for
   frontend errors or "why didn't this notification arrive."

See [`incident-response.md`](incident-response.md) for what to do once
you've found the problem.
