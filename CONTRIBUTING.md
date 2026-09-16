# Contributing

This is a solo-maintained internal tool (one company's field sales/
warehouse/delivery/accounting teams), not an open-source project soliciting
outside contributors — but the same discipline applies to every change,
including ones made with AI assistance. This file is the short version;
the full policy lives in [`docs/governance/`](docs/governance/README.md).

## Before you start

1. Read [`docs/local-development.md`](docs/local-development.md) to get a
   working local environment.
2. Skim [`docs/governance/architecture.md`](docs/governance/architecture.md)
   if you're touching an area you haven't worked in before.
3. Check [`docs/governance/critical-user-journeys.md`](docs/governance/critical-user-journeys.md)
   — if your change touches one of these, it needs an integration test,
   not just a manual check.

## Workflow

1. **Branch from current `main`** — never stack on stale history.
2. Make your change. Keep it scoped to one topic; don't bundle an
   unrelated fix into a feature PR.
3. Run the checks locally before pushing (see
   [`docs/local-development.md`](docs/local-development.md#running-checks)):
   - `npm test` (server integration/unit suite)
   - `npm run verify:ui` (static UI-regression checks)
   - `npm run test:e2e:smoke` if you touched a flow covered by the
     Playwright suite
4. **If your change touches anything under `client/public/`**, bump both
   `APP_VERSION` (`client/public/js/version.js`) *and* `CACHE_VERSION`
   (`client/public/sw.js`). This is not optional — see `CLAUDE.md` and
   [`docs/release-process.md`](docs/release-process.md) for why: bumping
   only `APP_VERSION` does nothing for update delivery, and this was
   missed for 11 releases in a row before being caught.
5. Open a PR against `main`. The template
   (`.github/pull_request_template.md`) walks through the
   [Definition of Done](docs/governance/definition-of-done.md) checklist —
   fill it in honestly, don't just check boxes.
6. Wait for CI (`.github/workflows/ci.yml`) to go green. A local pass that
   fails in CI means something environment-dependent snuck in — fix the
   root cause, don't just re-run.
7. Squash-merge once green.

## Commit and PR conventions

- Commit messages and PR descriptions explain **why**, not just what —
  the diff already shows what changed.
- If a change knowingly leaves a gap open (deferred scope, a flaky test,
  an accepted risk), log it in
  [`docs/governance/risk-and-technical-debt-register.md`](docs/governance/risk-and-technical-debt-register.md)
  rather than letting it live only in the PR description.
- Security-sensitive changes (auth, payments, file uploads, any new
  mutating route, anything touching roles/permissions) get checked
  against [`docs/governance/service-objectives-and-security.md`](docs/governance/service-objectives-and-security.md)
  before merging.

## Database migrations

- Prefer additive changes (new column/table/index) over destructive ones
  (dropping a column, renaming in place) where the workflow allows it.
- Apply and test the migration against a real local Postgres
  (`npm run migrate`) before pushing — don't just eyeball the SQL.
- Destructive migrations (`DROP COLUMN`, `ALTER ... TYPE`, data backfills)
  get an explicit callout in the PR description.
- See [`docs/data-model.md`](docs/data-model.md) for the current schema
  and [`docs/governance/definition-of-done.md`](docs/governance/definition-of-done.md)
  for the full migration checklist.

## Versioning and releases

See [`docs/release-process.md`](docs/release-process.md). Short version:
Semantic Versioning, a `CHANGELOG.md` entry per release, a git tag.

## Getting help

There is currently one maintainer — see
[`docs/governance/release-and-incident-ownership-matrix.md`](docs/governance/release-and-incident-ownership-matrix.md)
for the honest current state of review/ownership.
