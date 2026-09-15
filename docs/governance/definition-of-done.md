# Definition of Done

Applies to every change merged to `main` from this point forward — this is
the [completion gate](README.md#completion-gate) this baseline exists to
establish. `.github/pull_request_template.md` turns the checklist below
into an actual PR checkbox list so it can't be skipped by accident.

## Required for every PR

- [ ] **Branched from current `main`**, not stacked on stale history.
- [ ] **`npm test` passes** (`server/`) — currently 44 unit + integration
      tests. A new integration test is expected for changes to any
      [critical user journey](critical-user-journeys.md), not just "would
      be nice."
- [ ] **`npm run verify:ui` passes** — the UI-regression static checks
      (currently 27).
- [ ] **CI is green** on the PR (`.github/workflows/ci.yml`) — this
      re-runs the two checks above from a clean checkout against a fresh
      Postgres instance, plus `npm audit --audit-level=high`. A pass
      locally that fails in CI means something environment-dependent
      snuck in; fix the root cause, don't just re-run.
- [ ] **No unreviewed direct changes to `main`** — every change goes
      through a PR (see [change-management-policy.md](change-management-policy.md)).
- [ ] **Migrations are additive/backward-compatible** where practical (see
      the migration checklist below) and were actually applied and tested
      against a real Postgres instance, not just eyeballed.
- [ ] **If the change touches anything under `client/public/`**: both
      `APP_VERSION` (`client/public/js/version.js`) *and* `CACHE_VERSION`
      (`client/public/sw.js`) are bumped — per `CLAUDE.md`, bumping only
      the former does nothing for update delivery. This was missed for 11
      releases in a row before being caught; there is no excuse to miss it
      again now that it's in this checklist.
- [ ] **Security-sensitive changes** (auth, payments, file uploads, any
      new mutating route, anything touching roles/permissions) get a
      second look against `docs/governance/service-objectives-and-security.md`'s
      security-responsibilities section before merging.
- [ ] **New/changed risk is logged**: if the PR knowingly leaves a gap open
      (deferred scope, a flaky test, a dependency advisory not fixed), add
      or update a row in the [risk register](risk-and-technical-debt-register.md)
      rather than letting it live only in the PR description.

## Migration checklist (when a PR includes one)

- [ ] Applied against a real local/dev Postgres and verified with `npm run
      migrate` before pushing — not just written and assumed correct.
- [ ] Prefer additive changes (new column/table/index) over
      destructive ones (dropping a column, renaming in place) where the
      journey allows it, so a rollback of the *application* code doesn't
      require also rolling back the schema.
- [ ] A new index on a table used by a [critical user
      journey](critical-user-journeys.md) is justified by an actual query
      it supports (name the route/query in the migration's comment), not
      speculative.
- [ ] Destructive migrations (`DROP COLUMN`, `ALTER ... TYPE`, data
      backfills) get an explicit callout in the PR description — these are
      the ones a staging environment (once it exists, see R-01 in the risk
      register) should be exercised against before touching production.

## Review requirements

See the [ownership matrix](release-and-incident-ownership-matrix.md) for
who currently reviews what. Until a second human collaborator exists on
this repo, the enforced gate is: **CI must pass, and the author must
self-attest to this checklist in the PR description** (the template does
this). This is a real, stated limitation, not a hidden one — see risk R-03.

## Definition of Done for an entire feature/area (not just one PR)

Beyond the per-PR checklist, a feature counts as *done* only when:

1. It's been exercised against a running instance (not just unit tests) —
   via `curl`/Playwright against a local dev server, or (once staging
   exists) against staging.
2. Any new admin-facing data is actually visible in the Settings/Admin UI,
   not just reachable via the API.
3. i18n strings exist for both `en` and `hy` (this app is bilingual
   throughout — see `client/public/js/i18n.js`).
4. The PR description states what was tested and how, specifically enough
   that someone else could repeat it without guessing.
