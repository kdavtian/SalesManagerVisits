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
./deploy/deploy.sh          # fast unless new migrations are detected
./deploy/deploy.sh --full   # always run the full test/UI checks
./deploy/deploy.sh --fast   # always skip them, even with new migrations
```

### Fast vs. full

- **Fast** (the default for most deploys): pull → build → migrate → start
  → health check (`verify:deployment`). Skips the integration test suite
  and UI-regression check, since GitHub Actions CI already ran both on
  every commit before it was mergeable — re-running them again on the
  droplet is redundant for a commit that went through the normal PR flow.
- **Full**: adds `npm test` (276+ integration tests) and `npm run
  verify:ui` back in. **Auto-triggered** when the deploy introduces new
  files under `server/migrations/` — a real local run against the
  actually-migrated database catches things CI's separate database run
  wouldn't. Detection works via a gitignored local marker file
  (`.last-deploy-sha`) tracking the last deployed commit; if that marker
  is missing (first run on this droplet, or lost state), it runs full
  once to establish a safe baseline rather than assume fast is safe.

Use `--full` yourself for a deploy you want extra confidence on even
without a migration (a big refactor, a security-sensitive change). Use
`--fast` to explicitly skip checks on a migration you're confident is
trivial — rare, use with judgment.

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
