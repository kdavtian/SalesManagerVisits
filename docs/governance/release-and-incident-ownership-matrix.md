# Release and incident ownership matrix

## Honest starting point

As of this baseline, this repository has **one collaborator**
(`kdavtian`, confirmed via the GitHub API — `admin` role, sole entry).
Every PR merged to date was authored and merged by that same account. This
matrix is written to reflect that reality, not to invent roles that don't
exist yet — and structured so each row is easy to hand off the moment a
second person joins.

Where an AI coding agent (Claude Code) did the implementation work, it is
listed explicitly as the acting party for that step, distinct from the
human accountable for the outcome (`kdavtian` in every case today).

## Release ownership

| Stage | Responsible today | Mechanism | Notes |
|---|---|---|---|
| Author a change | `kdavtian`, frequently via Claude Code | Feature branch → PR | See [definition-of-done.md](definition-of-done.md). |
| Review | `kdavtian` (self-review) + CI + AI-assisted review where used | PR checks, `.github/pull_request_template.md` checklist | No independent second-human reviewer exists yet — logged as risk R-03. |
| Merge to `main` | `kdavtian` | Squash merge, only after CI green | Direct pushes to `main` are policy-frozen; see [change-management-policy.md](change-management-policy.md). |
| Deploy to production | `kdavtian` | Manual SSH to the droplet, `./deploy/deploy.sh` | No auto-deploy-on-merge exists; this is a deliberate manual gate given there's no staging to have already caught problems (risk R-01). |
| Post-deploy verification | `kdavtian` | `deploy.sh`'s own `verify:ui` + `verify:deployment` steps | No separate smoke-test owner distinct from the deployer today. |
| Dependency updates (Dependabot PRs) | `kdavtian` | Review + merge like any other PR | Nobody is currently assigned to review these on a cadence — risk R-11. |

## Incident ownership

| Phase | Responsible today | Action |
|---|---|---|
| Detection | `kdavtian` (no on-call rotation, no external monitoring/alerting service configured) | Currently reactive: a failure is noticed by a user report, an ERP-sync-staleness alert, or manual inspection. There is no uptime monitor watching the droplet from outside it. |
| Triage / severity call | `kdavtian` | Apply [severity-definitions.md](severity-definitions.md). A Critical incident (data loss, security breach, full outage) escalates to immediate action regardless of time of day. |
| Containment | `kdavtian` | For a security incident specifically: the Emergency Disconnect / lockdown feature (`server/src/routes/lockdown.js`) is the first lever — it logs out every session and blocks all data access app-wide until lifted. |
| Fix / rollback | `kdavtian` | Roll back = redeploy the previous known-good commit via `deploy.sh`; there's no one-command automated rollback today. |
| Postmortem | `kdavtian` | Not currently a formalized step. **Recommended addition**: for any Critical or High incident, write a short postmortem and add/update the relevant [risk register](risk-and-technical-debt-register.md) entry so the same class of failure is tracked, not just fixed once. |

## Security responsibilities

See [service-objectives-and-security.md](service-objectives-and-security.md)
for the full list. Summarized here since it's part of the same
accountability question:

| Responsibility | Owner today |
|---|---|
| Secret custody (`JWT_SECRET`, `ERP_SYNC_KEY`, VAPID keys, DB password) | `kdavtian` (held in the droplet's `.env`, not in this repo) |
| Dependency/vulnerability triage (`npm audit`, Dependabot) | `kdavtian` |
| Access control changes (roles, permissions in `server/src/roles.js`) | `kdavtian` |
| Branch protection / repo settings | `kdavtian` (GitHub repo admin) |
| TLS certificate renewal | Automated (certbot's systemd timer), `kdavtian` if it ever fails |

## When a second person joins

At minimum, split at least these before granting write access:

1. **Reviewer distinct from author** for anything touching a [critical
   user journey](critical-user-journeys.md), payments, or auth — update
   `.github/CODEOWNERS` and branch protection's required-approvals count
   at that point (both are one-line changes once there's a second GitHub
   account to name).
2. **A named incident responder** who isn't always the same person as
   whoever wrote the code that broke, where feasible.
3. **A backup for secret custody** — right now, if `kdavtian` is
   unavailable, there is no documented way for anyone else to access
   production secrets. That's a real single-point-of-failure worth fixing
   before it's the reason an incident runs long.
