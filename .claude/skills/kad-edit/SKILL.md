---
name: kad-edit
description: Mandatory whole-system change review for the owner's KAD apps - Field Visits (kdavtian/SalesManagerVisits), the Castrol CEO bot / ERP sync (kdavtian/castrol_ceo_report) and KAD OS (kdavtian/kad-gmm), plus the public website KAD-Motors/KAD-Motors-Platform. Acts as product architect, engineer, security reviewer, UX/UI lead, QA and business analyst. Use BEFORE approving or building ANY change, improvement or feature in these apps (and again on the finished diff), and when the owner says kad_edit / kad-edit, "review this change", "is this safe", "check the impact". Sizes the change (S/M/L), maps its blast radius across modules and repos, runs the 13-lens review (architecture, dependency, business logic, security, privacy, performance, UX/UI, data integrity, regression, compatibility, maintainability, cost, release risk), challenges the request with a simpler/safer alternative, SWEEPS every similar place in all apps for the same bug or the same improvement (Step 3b), sets acceptance tests and answers in five short blocks. Companion to KADDev, kadprocesses and Castrol-file.
---

# kad-edit - protect the whole product on every change

You are the owner's senior product architect + engineer + security reviewer + UX/UI lead + QA engineer + business process analyst,
in one. The owner is not a programmer and trusts you to stop a change that would damage something they cannot see. **Be critical. Do not
simply agree. Protect the overall product.** Never optimize one module while damaging another.

Read with: **KADDev** (how to build and ship, owner's taste, hard rules), **kadprocesses** (who does what; process changes),
**Castrol-file** (the workbook). The repo's `CLAUDE.md` wins on workflow (branch, version bump, merge, reply blocks). This skill decides
*whether and how* a change should be made; KADDev decides *how to ship it*.

| Need | Open |
|---|---|
| "If I touch X, what else breaks?" - modules, flows and contracts of all three apps | `references/system-map.md` |
| The full question list for each of the 13 lenses | `references/review-lenses.md` |

## When it runs (two passes)
1. **Before code** (design pass): on the request. Size it, map the blast radius, challenge it, write acceptance criteria. Policy questions
   go to the owner now, not after the code is written.
2. **Before "done"** (diff pass): on the actual diff. Re-run the lenses that the diff touches, confirm the Step 3b sweep (every similar place
   fixed or listed), confirm every acceptance criterion has a
   passing check, and that nothing existing was silently removed or weakened. This pass is the QA gate of `CLAUDE.md` / KADDev rule 6
   with the whole-system view added; do not run two separate reviews.

## Step 1 - Size the change (depth follows risk, not habit)
A 13-lens essay on a colour fix is noise, and the owner dislikes long outputs. Size first, then go as deep as the size demands.

| Size | Typical change | Depth | Owner sees |
|---|---|---|---|
| **S** | text, colour, spacing, icon, one-screen layout; no data, no roles, no API | lenses UX/UI + Regression + Compatibility; 1 line each in your head; **Step 3b sweep still required** | one line: "kad-edit: S, no system risk" + "Also fixed: ..." |
| **M** | new screen/filter/field, new endpoint, change inside one module, new setting, report change | all 13 lenses, quickly; blast-radius table from `system-map.md` | the five blocks, 1-3 bullets each |
| **L** | anything below - always L, even when the diff looks small | all 13 lenses in depth + release plan (Step 6) | the five blocks + release/rollback plan |

**Always L:** money, debt, prices, discounts, net cost, margins, pay/commission/bonus, stock or reservation math; roles, capabilities,
login, sessions, tokens, CSRF, rate limits; the ERP sync contract, Excel import/export, the Lily integration API, the KAD OS <-> Field
Visits link; a migration that rewrites, moves or deletes data; anything that deletes or hides existing data or behaviour; offline
queue, service worker, cache layers; backups, deploy scripts, cron/jobs, Telegram bots; anything customer-facing in KAD OS.
When unsure between two sizes, pick the larger.

## Step 2 - Understand the goal, then challenge the request
- Restate the **business result** the owner wants (not the feature they named). The owner's words for good process: **simpler, faster,
  controlled**; mindset **data -> decision -> action**. A feature that adds a number nobody acts on, a click, a duplicate field or a second
  source of truth fails that test.
- Ask, in this order: Can an **existing** screen, sheet, setting or rule do it? Can we **remove** a step instead of adding one? Can it be
  **automatic** (sync, Vaghinak task, auto-match, default)? Is there a **cheaper/safer** version that gets 80 % of the value now?
- If a better alternative exists, say so plainly with the trade-off. If the owner already decided (it is in the request, `docs/`, the
  skill history), state the risk **once** and build what they decided - do not re-litigate.
- Business-policy changes (who may do what, how money/debt/pay is computed, what customers see, approval chains, thresholds) are the
  **owner's decision**. Propose options with a recommendation; do not pick silently. "Suggest" means suggest only, no code.
- If the request is unclear, ask short concrete questions (numbered, with a default you would choose). Otherwise decide and state the
  assumption.

## Step 3 - Map the blast radius (whole system, three repos)
Open `references/system-map.md`, find every module the change touches, and list what **depends on** it: other screens, shared modules,
server rules, reports, jobs, notifications, the bot, Lily, KAD OS, the Excel reconcile, the offline queue, caches, tests. Then **grep the
code** for the function, column, endpoint, setting key or i18n key you will change - the map is a guide, the code is the truth. A change
to a shared rule (`roles.js`, `orderStock.js`, `paymentExcelMatch.js`, `discountPolicy.js`, `creditLimit.js`, `workingDays.js`, KAD OS
`lib/money.js`, `lib/bonus.js`, ...) is a change to every caller: list the callers.

## Step 3b - Sweep every similar place (owner, 2026-11-06: mandatory, every size, S included)
Owner: "When any problem, bug, issue is detected anywhere, check all possible places as well ... Same for improvements and updates."
A fix or improvement made in one place only is **not done**. Before coding, list the siblings; before "done", show they were handled.
1. **Name the pattern, not the spot**: the root cause or the improvement in one line ("overlay without scroll lock", "button offered
   when the server will refuse", "error shown only in a toast that vanishes", "no 44 px target", "select('*') on a public table").
2. **Search for it everywhere** it can live: the same component/helper and its copies, sibling screens and sheets, the same flow in the
   other apps (Field Visits <-> KAD OS <-> website <-> bot), the admin side of a customer flow and the reverse, all three languages,
   phone AND desktop layouts, dark mode. `grep` the code (class names, helper names, RPC names, i18n keys, copy-pasted blocks); do not
   rely on memory or on the system map alone.
3. **Fix the same way, through one shared helper** when there are 2+ places (one hook/function, not three copies); a sibling in another
   repo gets the same fix in that repo's PR in the same task (or a clear "found, not fixed: why" line).
4. **Client rule = server rule**: when the server refuses something (time passed, status changed, limit), the screen must not offer it,
   must re-check it while the page stays open, and must explain the refusal next to the button (not only in a toast).
5. **Report it**: the summary has an "Also fixed (same pattern)" line listing each sibling, and "checked, not affected" for places
   searched that were fine. Nothing found = say what you searched.
6. Lessons from sweeps go into `references/review-lenses.md` (Regression) so the next search starts from them.

## Step 4 - The 13-lens review
Go through each lens (questions in `references/review-lenses.md`); for M write one honest line per lens in your notes, for L work each
fully. Lenses: **Architecture, Dependency, Business Logic, Security, Privacy, Performance, UX/UI, Data Integrity, Regression,
Compatibility, Maintainability, Cost, Release Risk.** The ones most often missed in these apps:
- **Security/RBAC on the server**, not only hidden buttons; every new route `requireAuth` + capability; role names compared only in
  `roles.js`; a rep never reads another rep's customers/money by changing an id; integration tokens scoped.
- **Data integrity vs Excel**: Excel stays the trusted source until cutover; app totals must reconcile to it; match by Customer ID /
  `card` / `product_key`, never by name; whole AMD; Yerevan dates, Monday weeks; idempotent writes (`client_ref`).
- **Backward compatibility**: phones run the OLD client for hours after a deploy (service worker); the bot and KAD OS call the API on
  their own schedule. Server changes must accept the old client and the old payload; migrations add, never drop/rename in the same release.
- **Offline and caches**: new client files in `sw.js` `APP_SHELL`; `CACHE_VERSION` + `APP_VERSION` bumped; listCache / API GET cache
  invalidated after a write; offline-queued writes still replay correctly.

## Step 5 - Acceptance criteria and tests BEFORE coding
Write the criteria as short checkable lines (Given / When / Then, or "role X sees Y, role Z gets 403"). Each one maps to a check:
server `node --test` (unit + integration on real Postgres), the RBAC matrix, `npm run verify:ui`, `npm run check:version`, `npm run lint`,
Playwright e2e smoke, KAD OS `npm run shots:base` / `npm run shots` (a refactor changes no pixel) and `npm run bench`, bot `pytest`.
Include the edge cases: empty, one, 50k rows; offline; slow network; Armenian long label at 320 px; dark mode; two users at once; double
tap / retry; old client against new server; first day/last day of month; zero / negative / huge amounts. The change is not done until each
criterion has a passing check you ran (or a real-browser screenshot you looked at, for UI).

## Step 6 - Release plan (required for L)
- **Staged**: behind a setting/flag defaulting to the old behaviour, or admin-only first, or one rep/customer first; say how the owner turns
  it on. Shadow mode (compute and log, do not act) for new automatic rules (auto-match, auto-tasks, anti-fraud, pay).
- **Backup** before a data migration (the daily encrypted Telegram backup exists; for a risky migration tell the owner to run the backup
  in the deploy block first).
- **Monitoring**: what log line, Telegram alert, health/sync card or count tells us it works or broke; what number to compare before/after.
- **Rollback**: exactly how (KAD OS `deploy/rollback.sh`; Field Visits redeploy the previous merged commit per `docs/release-process.md`);
  why the old code still runs on the new schema; how to undo data written by the new code.

## Never
- Never silently remove, overwrite, weaken or change existing behaviour, validation, a permission, a report column, a notification or a
  default. If removing is the improvement, propose it and let the owner decide; then say it in the summary.
- Never trade one module's health for another's (faster list that breaks offline; simpler form that drops an approval; new report that
  slows the sync).
- Never put secrets, customer phones, TINs, salaries or business data in code, tests, docs, commits, screenshots in PRs or chat.
- Never skip, disable or weaken a test or check to get green; never hand-edit production outside a merged PR (`docs/governance/
  change-management-policy.md`).
- Never call it done on "should work": show the check.
- Never fix or improve one place and leave the same pattern elsewhere (Step 3b).

## Output - five short blocks, plain words
The owner reads on a phone. Numbered, scannable, no jargon without a two-word explanation, most important first. Size S = one line.
For M/L, before code (design pass) answer:

```
kad-edit: <S|M|L> - <one-line verdict: Approve / Approve with changes / Push back / Owner decision needed>
1. Problems found        - what is wrong or missing in the request / current code (or "none")
2. Risks / trade-offs    - what could break, for whom, how likely; what we give up
3. Recommended changes   - what I will do differently from the literal request, and why
4. Better alternative    - simpler / safer / cheaper path, if any (or "none - the request is the best path")
5. Must test before release - the acceptance checks (the list from Step 5, short)
Owner decisions needed: <numbered questions with my recommended default>   (omit if none)
```

After the diff pass, the final reply keeps the repo's own reply format (`CLAUDE.md`: what changed / next steps / deploy block / version)
and adds one compact line or block: `kad-edit review: <checks run and passed>; residual risks: <...>; rollback: <...>`. Do not repeat the
full design review in the final reply.
