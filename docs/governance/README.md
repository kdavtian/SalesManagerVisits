# Quality baseline — governance docs

This directory establishes `main` as the quality baseline for
SalesManagerVisits: a snapshot of the real architecture, a plain accounting
of known risk and technical debt, and the process that governs every
change from here forward.

## Documents

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | Current-state architecture diagram, layers, integrations, roles, deployment topology. |
| [severity-definitions.md](severity-definitions.md) | Critical/High/Medium/Low, used consistently across the risk register, incidents, and review. |
| [risk-and-technical-debt-register.md](risk-and-technical-debt-register.md) | Every known gap found during this baseline's audit, with severity, impact, and status. |
| [critical-user-journeys.md](critical-user-journeys.md) | The workflows where a break is a High/Critical incident by definition. |
| [definition-of-done.md](definition-of-done.md) | What every PR must satisfy before merging, plus feature-level and migration-specific checklists. |
| [release-and-incident-ownership-matrix.md](release-and-incident-ownership-matrix.md) | Who does what, honestly reflecting the current one-person team. |
| [service-objectives-and-security.md](service-objectives-and-security.md) | Proposed SLOs (availability, RPO/RTO, incident response times) and the security-control inventory. |
| [change-management-policy.md](change-management-policy.md) | The freeze on undocumented production changes, the manual branch-protection steps needed to enforce it, and the staging-environment plan. |

## Completion gate

This baseline is considered established when:

- [x] Every subsequent change requires review (PR) and CI — **structurally
      true in practice since this baseline's own work** (every change
      went through branch → PR → CI → squash-merge); **not yet
      GitHub-enforced** until the manual branch-protection step in
      [change-management-policy.md](change-management-policy.md) is
      applied (tracked as risk R-04).
- [x] Critical workflows and responsible owners are documented — see
      [critical-user-journeys.md](critical-user-journeys.md) and
      [release-and-incident-ownership-matrix.md](release-and-incident-ownership-matrix.md).

## What this baseline does *not* claim

In the interest of these docs staying trustworthy rather than aspirational:

- **Staging and production environments are not both live yet.** Only
  production exists. The plan and required manual steps are in
  [change-management-policy.md](change-management-policy.md); this is
  tracked as risk R-01, not silently marked done.
- **Branch protection is documented but not yet GitHub-enforced** (risk
  R-04) — no tool available to this session could set it via API. Applying
  it is a five-minute manual step, specified exactly in
  [change-management-policy.md](change-management-policy.md).
- **Backups are manual, not automated** (risk R-02) — the SLOs in
  [service-objectives-and-security.md](service-objectives-and-security.md)
  say so explicitly rather than claiming an RPO/RTO that isn't actually
  met yet.

Treat the two unchecked items above as the immediate next actions for
whoever has droplet/repo-admin access — everything else in this baseline
is either already true today or is tracked, with an owner and a next step,
in the risk register.
