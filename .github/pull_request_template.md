## Summary

<!-- What changed and why. Link a risk-register row (docs/governance/risk-and-technical-debt-register.md) if this closes or introduces one. -->

## Testing

<!-- What you actually ran, specifically enough that someone else could repeat it. -->

## Definition of Done

See [docs/governance/definition-of-done.md](../docs/governance/definition-of-done.md) for the full checklist. At minimum:

- [ ] `npm test` passes (`server/`)
- [ ] `npm run verify:ui` passes
- [ ] CI is green on this PR
- [ ] If this touches `client/public/`: both `APP_VERSION` (`client/public/js/version.js`) and `CACHE_VERSION` (`client/public/sw.js`) are bumped
- [ ] Migrations (if any) were applied and tested against a real Postgres instance
- [ ] Security-sensitive changes (auth, payments, uploads, roles, any new mutating route) checked against `docs/governance/service-objectives-and-security.md`
- [ ] Any known gap this PR knowingly leaves open is logged in `docs/governance/risk-and-technical-debt-register.md`
