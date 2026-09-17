# Incident response

For **who** is responsible at each phase, see
[`governance/release-and-incident-ownership-matrix.md`](governance/release-and-incident-ownership-matrix.md)
(currently one person). For severity levels, see
[`governance/severity-definitions.md`](governance/severity-definitions.md).
This doc is the **how** — the concrete steps.

## 1. Detect

There's no external monitoring paging anyone (see
[`monitoring.md`](monitoring.md)) — in practice, an incident is noticed
via a user report, an ERP-sync-staleness alert, or manual inspection.
Start with `GET /api/health` and `docker compose logs --tail=200 app` on
the droplet (see [`monitoring.md`](monitoring.md#where-to-look-when-something-seems-wrong)
for the fuller checklist).

## 2. Triage severity

Apply [`governance/severity-definitions.md`](governance/severity-definitions.md).
A Critical incident (data loss, security breach, full outage) means act
immediately, any hour — don't wait for business hours to start containing
it.

## 3. Contain

**For a security incident specifically** (suspected credential exposure,
auth bypass, a compromised account): the Emergency Disconnect / lockdown
feature is the first lever. It logs out **every** session app-wide
(admin's own included) and blocks all data access until lifted —
`server/src/routes/lockdown.js`.

**There is currently no UI button for this** — `api.js` exposes
`engageLockdown()`/`liftLockdown()`, but nothing in the admin screens
calls them yet. Trigger it today from an authenticated admin session,
either:

- **Browser console**, logged into the app as an admin: `await
  api.engageLockdown()` (the `api` module is already loaded on any page).
- **Direct request**, if you have the admin's session + CSRF cookies:
  ```bash
  curl -X POST https://<host>/api/lockdown/engage \
    -H "Cookie: session=<value>; csrf_token=<value>" \
    -H "X-CSRF-Token: <same csrf_token value>"
  ```

Lift it the same way against `/api/lockdown/lift` once the threat is
contained. **A UI button for this belongs in a future PR** — logged as a
gap here rather than assumed to exist.

**For a data-integrity incident** (a bad migration, a bug corrupting
records): consider whether containment means rolling back the app code
(see [`deployment.md#rollback`](deployment.md#rollback)), stopping writes
to a specific table, or just fixing forward — depends entirely on the
specific bug. There's no generic "stop all writes" switch short of full
lockdown.

## 4. Fix or roll back

- **Roll back**: redeploy the last known-good commit — see
  [`deployment.md#rollback`](deployment.md#rollback). Always use
  `--full` when rolling back; don't trust the fast deploy path during an
  incident.
- **Fix forward**: same PR → CI → merge → deploy flow as any other
  change, just faster and with more scrutiny given the stakes. Don't skip
  CI or `verify:ui`/`verify:deployment` under pressure — that's exactly
  when a second mistake is most likely.
- **Data recovery**: if data was lost/corrupted, see
  [`backup-restore.md`](backup-restore.md) — and remember that doc's own
  honesty flag: restore has not been rehearsed, budget more time than you
  think.

## 5. Communicate

No formal communication channel/template exists today (one-person team).
At minimum: if the incident affects users (reps can't check in, orders
aren't going through), let them know work is in progress and roughly when
to expect it resolved — this is an operational tool people depend on
during their workday.

## 6. Resolve and verify

Same checklist as any deploy: `verify:deployment` passes, spot-check the
actual affected workflow (see
[`governance/critical-user-journeys.md`](governance/critical-user-journeys.md)),
confirm the app is reachable and usable end-to-end before declaring it
resolved.

## 7. Postmortem

Not currently a formalized step, but should be for any Critical or High
incident:

1. Write a short summary: what happened, when detected, when resolved,
   root cause, what would have caught it sooner.
2. Add or update a row in
   [`governance/risk-and-technical-debt-register.md`](governance/risk-and-technical-debt-register.md)
   so the same class of failure is tracked, not just fixed once.
3. If the incident revealed a gap in this doc or `monitoring.md`, fix the
   doc in the same PR as the follow-up work — don't let it go stale.

## Postmortem log

The format §7 above asks for, started with the first real incident it
applied to.

### 2026-09-17 — `deploy.sh --full` ran the integration test suite against production

**What happened**: Deploying the Bonuses module's migrations required
`--full` (auto-triggered by new files under `server/migrations/`), which
ran `docker compose run --rm app npm test`. `docker-compose.yml` only
defined one Postgres service (`db`, the real production database) — the
`app` service's `DATABASE_URL` always pointed at it, and `docker compose
run` inherits that. So the real integration suite (`test/integration/*`)
ran directly against production. This happened 3 times across the
session (deploy attempts ~30 minutes apart while working through
unrelated `psql` role/auth issues), confirmed by timestamps on the
leftover fixture rows below.

**Impact**:
- Real Web Push notifications (`push.js`) were sent to real subscribed
  devices, for fake orders/checkins/payments the test suite created and
  then deleted — visible in server logs as `Push delivered to
  subscription <id> (user <id>): "<title>"` with real subscription and
  user IDs, real Armenian notification text ("Նոր պատվեր" /
  "Պատվերն առաքվեց" / etc.). Telegram (`telegram.js`, same code shape)
  was not configured in this production `.env`, so it didn't also fire —
  but would have under the same conditions.
- 3 of `test/integration/bonusSourceIngest.test.js`'s office-attendance
  tests failed with a unique-constraint violation on
  `customers.erp_customer_id = 10000` — a real production customer's ERP
  ID, which a hardcoded test fixture collided with. Confirmed the suite
  was reading/writing real data, not an isolated copy.
- Those 3 failures happened before their test file's own cleanup step, so
  6 fixture `users` rows (from a separate, unrelated test file that did
  complete) were left behind across the 3 runs — found via a targeted
  query (fixture email/name patterns) and deleted manually. No customer,
  order, payment, or checkin rows were left behind — every other test
  file's own `test.after` cleanup ran successfully.

**Detection**: Not caught by any automated signal — noticed by a human
reading the deploy's own terminal output line by line while
troubleshooting an unrelated `psql` connection issue, and recognizing the
`Push delivered to subscription ...` lines as real, not test log noise.

**Root cause**: `docker-compose.yml` had no isolated test-database
service — unlike CI (`.github/workflows/ci.yml`), which spins up its own
ephemeral `postgres` service container per run and never touches
anything durable. `deploy.sh` was written assuming "the test suite is
just redundant with CI, safe to occasionally re-run" without noticing it
was re-running against a fundamentally different (real, persistent,
externally-connected) database. Compounding factor: `push.js`/
`telegram.js` had no test-mode guard at all — `enabled` was purely
"are credentials configured," so a real, configured production
environment always sends real notifications regardless of who's asking or
why.

**Fix** (see R-13 in the risk register):
1. `docker-compose.yml` gained a `db-test` service, gated behind
   `profiles: ["test"]` (invisible to a normal `up`/`up -d db`), with no
   named volume so every run starts empty.
2. `deploy.sh`'s full-test step now starts `db-test`, runs `npm run
   migrate` and `npm test` against it via `docker compose run -e
   DATABASE_URL=... -e NODE_ENV=test`, and tears it down in a trap (so a
   real test failure, which is `set -e`'s whole point, still cleans up).
3. `push.js`/`telegram.js` now also require `NODE_ENV !== "test"` to be
   `enabled`, independent of whether real credentials are configured —
   defense in depth so a future test run misconfigured some other way
   still can't send a real notification.

**What would have caught it sooner**: a staging environment (R-01,
already tracked, unrelated root cause but would have made this
unreachable from `--full` against anything resembling production) or,
more directly, noticing during Phase 8's original production runbook
write-up that `deploy.sh --full` and `npm test`'s DB target had never
actually been audited together. Logged as its own root cause here rather
than folded into R-01, since the fix didn't require standing up a second
environment.
