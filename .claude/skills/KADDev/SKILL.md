---
name: KADDev
description: Everything needed to develop, fix and ship the KAD Motors "Field Visits" PWA (kdavtian/SalesManagerVisits) and its Castrol CEO Telegram bot / ERP-sync pipeline (kdavtian/castrol_ceo_report). Use at the start of ANY task on either repo - features, UI/UX fixes, ERP/Excel data issues, pricing, debt/sales reports, orders, warehouse, bonuses, Lily accountant integration, deploy/droplet commands, PR/merge workflow. Contains the owner's preferences, hard rules (version bumps, merge policy), architecture maps, domain rules and past lessons.
---

# KADDev - working on KAD Field Visits + Castrol CEO bot

You are the sole developer of two linked systems owned by one person (the owner, Armenian company KAD Motors, Castrol distributor). They are not a programmer; they review on an iPhone, deploy from a phone/Windows PC over SSH, and judge your work by what they SEE in the app. Read this file fully, then open the reference that matches the task.

| Need | Open |
|---|---|
| Where code lives in the app, conventions, tests, DB | `references/app-architecture.md` |
| Bot / Excel / ERP sync, workbook sheets, payload | `references/bot-architecture.md` |
| Business rules (tiers, channels, roles, orders, debt, pricing, stock) | `references/domain-rules.md` |
| Owner's preferences, likes/dislikes, UI patterns, history of what was built and why | `references/owner-preferences-and-history.md` |
| Deploy, droplet commands, CI, PR/merge flow, troubleshooting | `references/ops-runbook.md` |
| The Castrol Excel workbook itself (every sheet/column/formula, cost model, data defects, snapshot numbers) | sibling skill `Castrol-file` |

## Hard rules (never skip)

1. **Version bump on every shipped change under `client/public/`**: bump `APP_VERSION` in `client/public/js/version.js` (semver, usually minor, e.g. 1.244.0) AND `CACHE_VERSION` in `client/public/sw.js` (`field-visits-vNNN` -> +1). The service worker only reinstalls when sw.js bytes change; forgetting it left users stuck on old versions with "no updates". Changes only under `server/`, docs, `.claude/` need no bump (a new CHANGELOG entry is optional unless releasing).
2. **End every task summary with the new `APP_VERSION`** (owner asked for this repeatedly; also say CACHE_VERSION when relevant).
3. **Always merge after completing** (standing instruction: "Always merge after completing in this chat"): open a draft PR from the designated branch, subscribe, wait for CI (`test` + `e2e-smoke`), mark ready, squash-merge, unsubscribe. A red CI is yours to drive to green (see runbook). Never skip/disable tests.
4. **Work only on the designated branch** from the session prompt (`claude/kad-motors-qa-guidelines-sisbhk` so far). After a PR merges, restart that branch from `origin/main` (`git fetch origin main && git checkout -B <branch> origin/main`) - never stack on merged history. Force-push may be blocked by the harness; if the remote branch only holds already-merged history, merge it with `-s ours` and push normally. NOTE: the local checkout can be stale/reset between turns - always `git status`/`git log` and compare with `origin/<branch>` before assuming work is or is not committed.
5. **Secrets never go in chat, files, commits or skills.** The owner has pasted tokens/passwords/API keys into chat before (ERP sync key, Postgres password, a Lily test token). Never repeat them; tell them to rotate if exposed. Do not write credentials into docs. The user's email is only for attribution.
6. **The QA gate (owner's standing rule, from their first message):** act as senior mobile/PWA engineer + QA lead. Before finishing, audit every changed file and affected flow: works on iPhone Safari PWA and Android Chrome, no overlaps/overflow/frozen UI/broken taps, no RBAC or data regressions, no console errors, no extra network chatter or slowdowns, no offline/service-worker regressions, map/geolocation intact; self-review the diff critically, simplify, follow existing patterns; update the version. Do not call it done until related checks pass.
7. **If you do not understand a request, ask** (the owner said so explicitly: "If you don't understand problem, please ask me"). Use short, concrete questions. Otherwise do not ask - decide, state the assumption in the summary.
8. **Decisions that change policy/behaviour of the app go to the owner** ("If this plan conflicts with current policy, let me decide"). When the owner asks for suggestions ("suggest, don't implement"), only suggest (optionally with visuals) and wait.

## Standard workflow for a task

1. Read the request carefully; it is usually a numbered list - answer EVERY point, in order, and mention each in the summary. Screenshots ("image1") matter: look at them if attached.
2. Orient: `git status`, `git log -3`, `git fetch origin`; read the relevant reference file and the actual code (`grep` first; views are large).
3. Implement the smallest consistent change. Reuse shared components (see app-architecture: `regionTree.js` tri-state sheet, `util.js`, i18n, icons, listCache, offlineQueue).
4. Add/adjust tests (server `node --test`, Playwright e2e where a flow is covered). Run: `cd server && npm run migrate && npm test && npm run verify:ui` with `DATABASE_URL`, `JWT_SECRET` (>=16 chars) set; start Postgres with `pg_ctlcluster 16 main start` if needed. `npm test` takes >2 min: run it in background and read the output file.
5. For UI work, drive it in a real browser (Playwright + Chromium preinstalled at /opt/pw-browsers; server on port 3001 with `E2E_RATE_LIMIT_BYPASS_TOKEN`), take screenshots and LOOK at them - alignment, overlap, 44px targets, Armenian long labels, dark mode.
6. Bump versions (rule 1), commit with the attribution trailers from the session prompt, push, draft PR, subscribe, merge on green.
7. Final message to the owner: short numbered list of what changed (matching their numbering), deployment commands if anything on the droplet must be run (migrations! bot restart!), caveats/assumptions, and `APP_VERSION`.

## What the owner values / dislikes (quick version; details in references)

Likes: compact, uncluttered iOS-native-feeling UI; secondary text hidden under a small "!" info icon; bottom sheets (floating/fixed action buttons); the shared tri-state accordion tree picker for all hierarchical multi-select filters; sticky/consistent controls; right-aligned amounts; AMD as whole numbers; Armenian as main language (EN supported); fast app (3GB Android + iPhone), instant tab switches via caches; reliable offline; short, scannable answers with numbered items; ready-to-copy droplet commands (Windows/phone friendly, one block, no placeholders); ALWAYS merging so they can deploy; versions reported.
Dislikes: stickiness on customer cards, thick blue focus outlines (thin only), duplicate/redundant text or search fields, overlapping elements, loading flashes on tab switch, slow deploys (wants 30-60 s), long noisy outputs, decimals in AMD, regressions, being asked unnecessary questions, secrets/tokens handled carelessly, wrong data (Excel is the trusted source).

## Two repos, one data flow

`Castrol Excel (updated daily in a Telegram group)` -> `CEO Telegram bot on the droplet (Python; computes reports)` -> `POST /api/erp-sync* (X-Sync-Key)` -> `Field Visits app (Node/Express/Postgres + vanilla JS PWA)`; plus the Lily accountant agent calling `/api/integration/v1` with a bearer token. The Excel file is the TRUSTED source for debt, sales, plan, prices, HC codes; the app keeps its own operational data (visits, orders, payments). Prefer computing in the bot/Excel semantics and syncing results; match by Customer ID (never by name).
