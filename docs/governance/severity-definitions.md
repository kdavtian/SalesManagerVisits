# Severity definitions

Canonical definitions used across the [risk and technical-debt
register](risk-and-technical-debt-register.md), incident response (see the
[ownership matrix](release-and-incident-ownership-matrix.md)), and PR/code
review. Any doc or process that talks about severity should point back
here rather than redefine it.

| Severity | Definition | Examples in this app | Response target |
|---|---|---|---|
| **Critical** | Data loss/corruption, a security breach or credential exposure, or the app is unusable for all users (production down). No safe workaround exists. | DB corruption with no recent backup; leaked `JWT_SECRET`/`ERP_SYNC_KEY`; auth bypass letting one role act as another; the app fails to boot in production. | Act immediately, any hour. Fix or roll back within hours, not days. |
| **High** | A core workflow is broken or a security control is missing/bypassable for a subset of users or data, but the app is otherwise usable. A workaround exists but is costly or error-prone. | Orders can't be submitted; payments can be double-recorded; CSRF/lockout protections silently not applied to a route; ERP sync silently stale past its alert threshold with no alert firing. | Fix within the current or next working day. |
| **Medium** | A real defect or gap with limited blast radius: one feature degraded, an edge case mishandled, a non-security hardening gap. Has a workaround. | A report shows a stale badge but the underlying data is fine; pagination missing on a list that's slow but not broken; a moderate-severity dependency advisory with no known exploit path here. | Fix within the current sprint/iteration; track in the register if not immediate. |
| **Low** | Cosmetic, a minor inconsistency, or a nice-to-have. No user-facing functional impact. | i18n string inconsistency; a code comment out of date; a lint-level cleanup. | Fix opportunistically; batch with related work. |

## How to apply this

- **In a PR**: if your change fixes something that would otherwise be
  Critical or High, say so explicitly in the PR description — reviewers
  should treat that as reason to look harder, not skip past it.
- **In the risk register**: every entry gets exactly one severity from this
  table. If an item doesn't cleanly fit, pick the higher one and say why in
  its notes — don't invent a new tier.
- **In an incident**: severity is set at the moment of detection using the
  information available then, and is free to change (usually downward) as
  the actual blast radius becomes clear. See the ownership matrix for who
  makes that call given this project currently has one maintainer.
