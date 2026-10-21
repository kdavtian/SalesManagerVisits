# Deployment

## One-time droplet setup

Full walkthrough (provisioning, Docker, nginx, Let's Encrypt, first
deploy): [`../deploy/digitalocean.md`](../deploy/digitalocean.md). Do this
once per new droplet, not per deploy.

## Day-to-day deploys

From the droplet, inside the repo checkout:

```bash
cd /opt/field-visits
./deploy/deploy.sh
```

What it does: pulls `main`, rebuilds the `app` image, runs migrations,
then runs a **fast or full** set of pre-flight checks before restarting
the `app` container — see below for which.

```bash
./deploy/deploy.sh          # fast (default), also when the deploy has migrations
./deploy/deploy.sh --full   # also run the whole test suite + UI checks here (slow, rarely needed)
```

### Fast vs. full

- **Fast** (the default, since 2026-10-21): pull -> build -> migrate -> start -> health check (`verify:deployment`). It does NOT re-run
  the integration tests or the UI-regression check: GitHub Actions CI ran both on this exact commit before it could be merged, and a run on
  the droplet sees nothing CI cannot (it uses an empty throw-away database and the same Postgres 16, not the real data). Every step prints how
  many seconds it took, so a slow deploy shows where the time goes.
- **Full** (`--full`): adds `npm test` (740+ tests, 8-15 minutes on this server, hundreds of log lines) and `npm run verify:ui`. It used to start by itself
  whenever a deploy added a migration; that was removed because it protected nothing the CI run had not already checked. Use it only for a
  deploy where you want a second opinion.

What really protects a migration: it runs against the real database BEFORE the new app starts, and the deploy stops (the old app keeps
running) if it fails. Take a backup first for a migration that rewrites existing data.

### Safety checks `deploy.sh` always runs, every mode

- Refuses to deploy if `.env` is missing.
- Refuses to deploy if `JWT_SECRET` is missing or under 16 characters.
- Refuses to deploy if `POSTGRES_PASSWORD` is unset or still the
  `fieldvisits` default.
- Migrations run against the *new* image, before the app container ever
  starts serving traffic on the new code (closes a window where
  already-running requests could hit new code expecting a column the
  database doesn't have yet).
- `verify:deployment` runs after the app starts — confirms it's actually
  healthy and serving the right static assets before declaring success.

### If the deploy fails

`set -euo pipefail` means the script stops at the first failing step —
nothing after that runs, and (critically) the `.last-deploy-sha` marker
is only written at the very end, after every check has passed. A failed
deploy never gets to claim its commit as a known-good baseline for the
next run's fast-path decision.

If a bad deploy already reached production (checks passed but something's
still wrong), see [`incident-response.md`](incident-response.md).

## Client-side cache versioning

**Every deploy that touches anything under `client/public/` must bump
both** `APP_VERSION` (`client/public/js/version.js`) **and**
`CACHE_VERSION` (`client/public/sw.js`). This is enforced by convention
(the PR template, `CLAUDE.md`) and checked in CI (see
[`release-process.md`](release-process.md#ci-version-consistency-check)),
not automatic — bumping only `APP_VERSION` does nothing for update
delivery, since the service worker only re-installs when `sw.js`'s own
byte content changes. This was missed for 11 releases in a row before
being caught; there is no excuse to miss it again.

## First deploy on a new droplet

After the one-time setup, run once:

```bash
docker compose exec app npm run seed
```

to create the initial admin account.

## Rollback

There is no automated rollback tooling today. To roll back manually:

```bash
git log --oneline -5          # find the last known-good commit
git checkout <good-sha>
./deploy/deploy.sh --full     # always full when rolling back — don't trust the fast path here
```

If the bad deploy included a migration, check whether it's safely
reversible before rolling back the app code underneath it — see the
migration checklist in
[`governance/definition-of-done.md`](governance/definition-of-done.md).
A destructive migration (dropped column, backfilled data) may not have a
clean way back; this is exactly why that checklist asks for additive
migrations where the workflow allows it.
