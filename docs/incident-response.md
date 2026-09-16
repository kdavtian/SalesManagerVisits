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
