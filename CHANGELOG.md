# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/); versioning
follows [Semantic Versioning](https://semver.org/) — see
[`docs/release-process.md`](docs/release-process.md) for what that means
in practice for this app (a solo-maintained internal tool, not a
published package).

This file tracks the **server release version** (`server/package.json`'s
`version`), not the PWA's own `APP_VERSION` (`client/public/js/version.js`)
— that one is a separate, much-more-frequent cache-busting counter bumped
on almost every client-touching change. See
[`docs/release-process.md`](docs/release-process.md) for why these are two
different numbers on purpose.

## [Unreleased]

Changes merged to `main` since the last tagged release, not yet cut into
one.

## [0.9.0] — 2026-09-16

First tagged release under the versioning policy established in this
change. Marks "production-readiness work in progress" — see
[`docs/release-process.md`](docs/release-process.md) for the gates that
must pass before `1.0.0`.

### Added

- Documentation structure: `CONTRIBUTING.md`, `SECURITY.md`, this file,
  and `docs/` (local development, configuration, data model, roles and
  permissions, offline sync, deployment, backup/restore, monitoring,
  incident response, release process, API overview). Complements the
  existing `docs/governance/` quality-baseline docs and
  `docs/erp-sync-contract.md` rather than duplicating them.
- Versioning policy (Semantic Versioning) and a CI check that a release's
  `package.json` version has a matching `CHANGELOG.md` entry.

### Context (already shipped, prior to this file existing)

The app was already in active production use — checkins/GPS verification,
customer/order/payment/delivery workflows, ERP sync, offline queueing,
push notifications, role-based access across seven roles — before this
changelog started. See [`docs/governance/architecture.md`](docs/governance/architecture.md)
for the current-state snapshot and `git log` for the full history; this
file only tracks changes from `0.9.0` forward.

[Unreleased]: https://github.com/kdavtian/SalesManagerVisits/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/kdavtian/SalesManagerVisits/releases/tag/v0.9.0
