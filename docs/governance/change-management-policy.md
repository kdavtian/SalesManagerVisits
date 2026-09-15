# Change-management policy

## The freeze: no undocumented direct production changes

Effective from this baseline: **no change reaches production except by
being merged to `main` through a reviewed pull request that passed CI,
then deployed via `deploy/deploy.sh`.** Specifically prohibited:

- SSHing to the droplet and hand-editing application code, config, or the
  database schema outside of a migration file.
- Manually running SQL against production that isn't a checked-in,
  reviewed migration under `server/migrations/`.
- Pushing directly to `main` (bypassing PR + CI).
- Deploying a commit that hasn't been merged to `main`.

**Exception**: a genuine Critical incident (per
[severity-definitions.md](severity-definitions.md)) may require an
immediate manual intervention on the droplet to stop active harm (e.g.
the Emergency Disconnect lockdown, or killing a runaway process). If that
happens: do the minimum needed to contain it, then **within 24 hours**
open a PR that (a) makes the same change properly through the normal path
if it needs to persist, and (b) documents in the PR description exactly
what was done manually and why, so it's never truly "undocumented" even
when it had to happen out of band. Add a row to the [risk
register](risk-and-technical-debt-register.md) if the incident revealed a
gap worth tracking.

## Enable branch protection (manual step — required to close this out)

No tool available in this session could set GitHub branch protection via
API, so this has to be applied by hand, once, in the GitHub UI. This is
the step that turns the policy above from a convention into something
actually enforced.

1. Go to **Settings → Branches** in the `kdavtian/SalesManagerVisits` repo.
2. Add a branch protection rule for `main`.
3. Enable:
   - **Require a pull request before merging.**
     - Required approvals: set to **0** for now, honestly reflecting that
       there is no second reviewer yet (see risk R-03 and the [ownership
       matrix](release-and-incident-ownership-matrix.md)). Raise this to
       **1** the moment a second collaborator exists — don't leave it at 0
       past that point.
   - **Require status checks to pass before merging**, and select the
     `test` check (from `.github/workflows/ci.yml`).
   - **Require branches to be up to date before merging.**
   - **Do not allow bypassing the above settings** (even for admins) —
     if this is left enabled for admins, the freeze is a suggestion, not a
     gate.
   - **Restrict force pushes** and **restrict deletions** on `main`.
4. Save. From that point on, GitHub itself refuses a direct push or a
   merge without a green `test` check — matching what's already been this
   session's actual practice (every change this baseline and the eight
   feature areas before it went through a branch → PR → CI → squash-merge
   flow), now made structural instead of just habitual.

Until this step is done, treat R-04 in the risk register as open.

## Staging environment plan

No staging environment exists today (risk R-01). This repo's `docker-compose.yml`
and `deploy/` scripts already assume "one droplet = one environment," so
standing up staging is an infrastructure decision, not a code change —
this session has no SSH access to provision it. Recommended approach,
sized to this project (small team, one existing droplet, Docker Compose
stack that already works):

1. **Provision a second droplet** (smallest size that runs Postgres +
   Node comfortably — the existing droplet's size is a reasonable
   starting point) with its own subdomain, e.g.
   `staging.fieldvisits.yourcompany.com`. Follow
   `deploy/digitalocean.md` exactly as written for production — it's
   already a clean, repeatable walkthrough; running it twice against two
   droplets *is* the staging setup.
2. **Separate secrets**: a different `JWT_SECRET`, `POSTGRES_PASSWORD`,
   and (if used) `ERP_SYNC_KEY` from production, in staging's own `.env`.
   Never point staging at the production database.
3. **Seed staging data**: either `npm run seed` fresh, or a periodic
   anonymized copy of production (strip customer PII/contact info,
   payment amounts can stay as-is since this is an internal tool, not
   something with external privacy exposure beyond the company itself —
   use judgment here, but don't casually copy live customer phone numbers
   into a less-guarded environment without a reason to).
4. **CI/CD hook**: once staging exists, extend `.github/workflows/ci.yml`
   (or a second workflow) to auto-deploy `main` to staging on every merge
   — this is the natural place to actually *exercise* a migration before
   it touches production, closing the gap called out in the [Definition
   of Done](definition-of-done.md)'s migration checklist. Production
   deploys stay manual (`deploy/deploy.sh`, run deliberately) until
   there's enough confidence (and enough staging track record) to
   consider otherwise.
5. **Promotion path**: `main` → auto-deployed to staging → manually
   verified against the [critical user journeys](critical-user-journeys.md)
   → `./deploy/deploy.sh` run against production when ready.

This is intentionally the smallest version of "real staging" that fits a
one-droplet, one-maintainer project today — not a fully separate cloud
account, Kubernetes, or IaC setup that would be disproportionate to the
team size. Revisit if the team or infrastructure footprint grows.
