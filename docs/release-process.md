# Release process

## Versioning policy

This project follows [Semantic Versioning](https://semver.org/) for
`server/package.json`'s `version` (tracked in [`../CHANGELOG.md`](../CHANGELOG.md)):

- **MAJOR** — incompatible workflow, API, or database contract changes
  (a role loses a capability, an endpoint's request/response shape breaks
  existing clients, a migration that isn't backward-compatible with the
  previous release's code).
- **MINOR** — backward-compatible features (a new endpoint, a new optional
  field, a new report).
- **PATCH** — backward-compatible fixes.

This is a solo-maintained internal tool, not a published package with
external consumers — there's no npm registry audience depending on strict
adherence. The value of SemVer here is internal: a version number that
actually means something when you're deciding whether it's safe to roll
back, and a CHANGELOG entry that exists for every release instead of
relying on memory of `git log`.

**Starting point:** `0.9.0`, reflecting that production-readiness work
(this documentation pass, closing the gaps tracked in
[`governance/risk-and-technical-debt-register.md`](governance/risk-and-technical-debt-register.md))
is still in progress even though the app itself has been in real production
use for a while. See [`../README.md`](../README.md#status) for the
distinction between "code is live and used daily" and "all five
production-readiness workstreams below are done."

### Path to 1.0.0

Release `1.0.0` only once all five workstreams pass their gates:

1. **Documentation** — this `docs/` tree and the governance baseline are
   accurate and cover the "Documentation completion criteria" below.
2. **Backup/restore** — a practice restore has actually been performed and
   timed (see [`backup-restore.md`](backup-restore.md#doing-a-practice-restore)),
   not just documented as a procedure.
3. **Monitoring** — at minimum, external uptime monitoring exists (see
   [`monitoring.md`](monitoring.md#whats-missing)); the app doesn't rely on
   a user noticing it's down.
4. **Incident response** — the Emergency Disconnect lockdown has a real UI
   trigger (see [`incident-response.md`](incident-response.md#3-contain)),
   not just an API endpoint reachable from the browser console.
5. **Risk register** — the Critical/High-severity rows in
   [`governance/risk-and-technical-debt-register.md`](governance/risk-and-technical-debt-register.md)
   are closed or explicitly accepted, not silently ignored.

None of these block continuing to ship `0.9.x`/`0.x.0` releases in the
meantime — 1.0.0 is a milestone marker, not a gate on shipping.

### Documentation completion criteria

Documentation is "done" (for the purposes of workstream 1 above) when:

- A new engineer can get the app running locally in under 30 minutes using
  only [`local-development.md`](local-development.md).
- Deployment and restore can be performed from documentation alone
  ([`deployment.md`](deployment.md), [`backup-restore.md`](backup-restore.md)),
  without asking whoever last did it.
- Every environment variable and external dependency is documented
  ([`configuration.md`](configuration.md)).
- Role/permission documentation ([`roles-permissions.md`](roles-permissions.md))
  matches what `server/src/roles.js` and the test suite actually enforce —
  re-check this doc whenever `roles.js` changes.
- Every release is reproducible from a Git tag (see below).
- This doc's freshness is reviewed as part of any PR that changes
  versioning, deployment, or release mechanics — not on a separate
  schedule nobody follows.

## Release ceremony (lightweight)

This is deliberately not a heavy process. For a normal (non-schema-changing)
release:

1. Bump `server/package.json`'s `version`.
2. Move the relevant `[Unreleased]` entries in `CHANGELOG.md` under a new
   `## [x.y.z] — YYYY-MM-DD` heading, and add the two compare-link lines at
   the bottom of the file.
3. Tag the merge commit: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. Deploy as usual (see [`deployment.md`](deployment.md)) — the tag marks
   what's running, it doesn't trigger the deploy itself.

That's the whole ceremony — no separate deployment-record document and no
mandatory rollback rehearsal for a routine release. A release is "genuinely
risky" (and gets more ceremony) when it includes a schema-changing
migration or touches auth/payments/cash-custody: for those, before tagging,
also confirm the migration is reversible or has a documented forward-fix
path (see the migration checklist in
[`governance/definition-of-done.md`](governance/definition-of-done.md)),
and note in the CHANGELOG entry itself what rollback would involve if the
release goes wrong.

## CI version consistency check

`server/scripts/check-version-consistency.mjs` runs in CI on every PR and
fails the build if `server/package.json`'s `version` has no matching
`## [x.y.z]` heading in `CHANGELOG.md`. This doesn't force a version bump
on every PR — most PRs land under the existing `[Unreleased]` section and
the check passes trivially (current `package.json` version already has an
entry from the last release). It only fails if someone bumps the version
in `package.json` without also writing the CHANGELOG entry for it, which
is exactly the kind of drift this check exists to catch — see the `sw.js`
`CACHE_VERSION` incident referenced in
[`deployment.md#client-side-cache-versioning`](deployment.md#client-side-cache-versioning)
for what "a required-by-convention step silently skipped for a long time"
costs in practice.

This check is about the *server* release version only. `APP_VERSION`/
`CACHE_VERSION` consistency (the client PWA cache-bust pair) is a separate,
unrelated concern, enforced by the PR template and `CLAUDE.md`, not by this
script.
