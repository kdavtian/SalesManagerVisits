# Security policy

## Reporting a vulnerability

This is an internal tool for one company's field sales/warehouse/delivery/
accounting operations, not a public product with a bug-bounty program —
but a real vulnerability here can expose customer data, payment records,
or ERP-sourced financial data, so it's treated seriously.

**Do not open a public GitHub issue for a security vulnerability.**

Instead, contact the repository owner directly (see
[`docs/governance/release-and-incident-ownership-matrix.md`](docs/governance/release-and-incident-ownership-matrix.md)
for current ownership) with:

- What you found and where (file/route/endpoint).
- Steps to reproduce, if safe to include in writing.
- What you think the impact is (data exposure, privilege escalation,
  auth bypass, etc.).

Expect an acknowledgment within one business day and a fix timeline based
on severity (see
[`docs/governance/severity-definitions.md`](docs/governance/severity-definitions.md)
— a real auth bypass or data-exposure bug is Critical/High and gets
worked immediately).

## Supported versions

There is one deployed environment (production) and no long-term-support
branches — the latest `main` is the only supported version. See
[`docs/release-process.md`](docs/release-process.md).

## Current security posture

The full inventory of implemented controls, known limitations, and who's
responsible for keeping each current lives in
[`docs/governance/service-objectives-and-security.md`](docs/governance/service-objectives-and-security.md).
Summary of what's in place today:

- Password hashing (bcrypt), httpOnly session cookies, double-submit CSRF
  protection on every mutating request.
- Per-account brute-force lockout plus IP-scoped rate limiting on login.
- Security headers via `helmet` (CSP, HSTS, frame/content-type/referrer
  defaults).
- Upload validation: MIME allow-list, size limits, server-generated
  filenames.
- Immutable audit trails on payment/order status history.
- An app-wide emergency lockdown kill-switch (see
  [`docs/incident-response.md`](docs/incident-response.md)).
- Dependency scanning (`npm audit` in CI, Dependabot).

Known gaps (tracked, not hidden) are in
[`docs/governance/risk-and-technical-debt-register.md`](docs/governance/risk-and-technical-debt-register.md) —
notably: no database-level row-level security (access control is
application-code only), no secrets manager, no automated penetration
testing.

## Secret rotation

`JWT_SECRET`, `ERP_SYNC_KEY`, and the VAPID key pair live in a `.env` file
on the production droplet, not a secrets manager. There is no automated
rotation — see risk **R-09** in the
[risk register](docs/governance/risk-and-technical-debt-register.md).
Rotating `JWT_SECRET` invalidates every active session; if you rotate it,
expect every logged-in user to be signed out.
