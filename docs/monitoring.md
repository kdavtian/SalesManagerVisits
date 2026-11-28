# Monitoring

**Status (2026-11-28)**: three layers, from outside in. Layers 1 and 2 need the one-time
[Owner steps](#owner-steps-outside-checks) below (free accounts the owner creates); layer 3 is the cron line in
[`backup-restore.md`](backup-restore.md#owner-steps-one-time-on-the-droplet). Until those are done, nothing outside the
app notices the app or the droplet being down -- see the availability row in
[`governance/service-objectives-and-security.md`](governance/service-objectives-and-security.md).

| Layer | Notices | Alerts |
|---|---|---|
| 1. Outside uptime monitor (UptimeRobot, free) on `https://<your-domain>/api/ready` every 5 min | droplet off, nginx/app down, database unreachable, certificate or DNS broken | e-mail + Telegram |
| 2. DigitalOcean droplet alerts | disk > 80 %, memory > 90 %, CPU > 90 % | e-mail |
| 3. `deploy/server-check.sh` on the droplet, every 15 min | disk > 85 % (root disk and Docker's data), app not answering `/api/ready` locally, no good backup for 36 h | Telegram backup group, "back to normal" when it clears |
| 4. In-app monitors (below) | stale ERP feeds, Excel file age, background jobs, last good backup (System health) | in-app / push / Telegram |

## Owner steps (outside checks)

**1. Uptime monitor** (UptimeRobot, free plan; Better Stack works the same way):
1. Sign up at uptimerobot.com. *Integrations & API* (or *My Settings* -> *Alert Contacts*) -> add **Telegram** (it opens a
   chat with the UptimeRobot bot; press Start) and check your **e-mail** contact is there.
2. *Add New Monitor*: type **HTTP(s)**, name `Field Visits`, URL `https://<your-domain>/api/ready`, interval **5 minutes**,
   alert contacts: Telegram + e-mail. Save.
3. Check: the monitor turns green ("Up") within 5 minutes. `/api/ready` answers 200 only when the app AND its database work.

**2. DigitalOcean alerts** (DigitalOcean website):
1. If the droplet's *Graphs* tab says the monitoring agent is missing, run on the droplet:
   `curl -sSL https://repos.insights.digitalocean.com/install.sh | sudo bash`
2. *Monitoring* -> *Create Alert Policy*, choose the droplet, e-mail to you; make three policies:
   - **Disk Utilization** is above **80 %** for **5 minutes**
   - **Memory Utilization** is above **90 %** for **5 minutes**
   - **CPU Utilization** is above **90 %** for **10 minutes**

**3. Server self-check**: the `*/15 * * * * ... server-check.sh` crontab line in
[`backup-restore.md`](backup-restore.md#owner-steps-one-time-on-the-droplet) (step 4). Test it once by hand:
`cd /opt/field-visits && ./deploy/server-check.sh` -> `OK: disks below 85%, app answers, backup fresh.` (before the first
backup it reports the missing backup -- expected). Limits: `DISK_ALERT_PERCENT` (85), `BACKUP_ALERT_HOURS` (36) in `.env`;
the same problem is repeated at most every 12 hours.

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

- The outside uptime monitor (layer 1) and `deploy/server-check.sh` (layer 3) poll `/api/ready` -- not `/api/health`,
  so a database outage alerts too.

### Application-level monitors (in-process, no separate infra)

These all run as `setInterval` timers inside the one Express process
(see [`governance/architecture.md`](governance/architecture.md) — no
separate job runner exists):

| Monitor | File | What it watches | Alerts via |
|---|---|---|---|
| ERP sync staleness | `server/src/erp/erpSyncMonitor.js` | Any ERP-sourced table not synced in >72h (`ERP_STALE_AFTER_HOURS`, `erpSyncFreshness.js`) | Notifies admin/CEO in-app + Telegram if configured |
| Excel FILE age | `server/src/erp/erpSyncMonitor.js` (`checkWorkbookAge`) | The newest workbook the bot synced is older than 48 h (Saturdays and Sundays, Yerevan time, are not counted) (`WORKBOOK_STALE_AFTER_HOURS`; file date = `workbook_modified_at` from the bot) | Once per file date, 08:00-21:00 Yerevan: in-app + push to admin / CEO / operations director (same `erp_sync_stale` preference) |
| Overdue visits | `server/src/field/overdueReminders.js` | Planned visits that passed without a check-in | Rep notification |
| Stale packed orders | `server/src/orders/stalePackedReminder.js` | Orders sitting in `packed_stock_out` too long without delivery | Warehouse/delivery notification |

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

- **Resource history** beyond DigitalOcean's droplet graphs (Postgres connection count, per-container memory). No
  Grafana/Prometheus; the disk/memory/CPU alerts above cover the failures that matter on one droplet.
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
