# Service objectives and security responsibilities

## Service objectives (SLOs)

This is an internal operations tool (field sales, warehouse, delivery,
accounting) for one company, not an external customer-facing SaaS product
— these are **proposed working targets**, not contractual SLAs. They're
set conservatively against what the current single-droplet, no-staging
infrastructure can actually deliver today, with the gap to a better target
made explicit rather than pretending it's already met.

| Objective | Target | Current reality | Gap |
|---|---|---|---|
| **Availability** | 99% monthly (~7.5h downtime budget/month) | No uptime monitoring exists to actually measure this against. | Add an external uptime check (even a free-tier one) hitting `GET /api/health` before claiming this is met. |
| **Planned deploy downtime** | < 2 minutes per deploy | `deploy.sh` rebuilds and restarts the `app` container; `db` stays up. Actual gap is typically container-restart time. | Acceptable as-is; revisit only if deploys become more frequent than a few per week. |
| **Recovery Point Objective (RPO)** — max acceptable data loss in a disaster | 24 hours | **Not met.** Backups are a manual command someone has to remember to run (risk R-02). | Automate nightly `pg_dump` + uploads-volume snapshot before this target can be honestly claimed. |
| **Recovery Time Objective (RTO)** — max acceptable time to restore service | 4 hours | **Untested.** No restore has been rehearsed; the backup command exists but restoring from it has never been dry-run. | Do at least one practice restore onto a scratch instance; document the actual steps and how long they took. |
| **Incident response — Critical** | Acknowledged and worked immediately | See [ownership matrix](release-and-incident-ownership-matrix.md) — currently one person, no on-call rotation, no paging. | Realistic given team size; the target itself is fine, the *guarantee* of it (no vacation/illness coverage) is the gap. |
| **Incident response — High** | Within 1 business day | Same as above. | Same as above. |
| **Incident response — Medium/Low** | Tracked in the [risk register](risk-and-technical-debt-register.md), fixed within the current or next iteration | Working as intended for this baseline's own findings (R-01 through R-11). | — |

Revisit these numbers once the automated-backup and staging-environment
work (risk R-01, R-02) actually lands — right now the RPO/RTO rows are
aspirational targets, not measured facts, and this doc says so on purpose.

## Security responsibilities

This summarizes what's actually implemented today (so it's traceable) and
who's accountable for keeping it that way — full detail on ownership is in
the [ownership matrix](release-and-incident-ownership-matrix.md).

### Implemented controls

| Control | Where | Notes |
|---|---|---|
| Password hashing | `bcryptjs`, `server/src/routes/auth.js` | Standard bcrypt, no plaintext/reversible storage. |
| Session auth | httpOnly, `sameSite=lax` JWT cookie | `server/src/middleware/auth.js`. |
| CSRF protection | Double-submit cookie, `server/src/middleware/csrf.js` | Applied to every mutating request carrying the session cookie. |
| Per-account brute-force lockout | 5 failed attempts → 15 min lock | `server/src/routes/auth.js`, migration `075`. |
| IP-scoped rate limiting | `express-rate-limit` on login + password-change | Complements, doesn't replace, the account lockout above. |
| Security headers | `helmet` (CSP, HSTS, frame/content-type/referrer defaults) | `server/src/app.js`. |
| Upload validation | MIME allow-list, size limits, server-generated filenames (no path traversal from user input) | `server/src/upload.js`. |
| Immutable audit trails | `payment_status_history`, `order_status_history` — `BEFORE UPDATE` triggers reject modification | Migration `071`. Deliberately not blocking `DELETE`, to preserve legitimate cascade cleanup — see that migration's own comment for why. |
| Emergency kill-switch | `server/src/routes/lockdown.js` | Logs out every session and blocks all data app-wide until an admin lifts it — the actual incident-containment lever, see the ownership matrix. |
| Dependency scanning | `npm audit --audit-level=high` in CI, Dependabot weekly | Added this baseline — first CI this repo has ever had. |
| Access control | Role-based, enforced in application code (`server/src/roles.js`) | No DB-level row-level security; see below. |

### Known limitations (also in the risk register where relevant)

- **No database-level row-level security.** Every access check is
  application-code enforcement (a capability function checked in the route
  handler). A bug in a route handler is the only thing standing between a
  `sales_manager` and another rep's data — there's no second layer.
- **No secrets manager.** Secrets live in a `.env` file on the droplet,
  not in a vault/secrets service. Acceptable at current scale; worth
  revisiting if the team or infrastructure footprint grows.
- **No WAF / DDoS protection** beyond whatever DigitalOcean provides at
  the network level by default.
- **No automated penetration testing or security scanning of the running
  app** (only static `npm audit` of dependencies). A periodic manual
  review is the closest substitute today.

### Responsibility for keeping this current

Whoever merges a PR touching auth, payments, uploads, or roles is
responsible for checking it against this list — that's also called out in
the [Definition of Done](definition-of-done.md). This document itself
should be revisited whenever a control here changes, so it never silently
goes stale relative to the code.
