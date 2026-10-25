# Optimization ideas - the standing "suggest, do not implement" backlog

Owner rule (2026-10-24): "Always suggest me optimization variants, which can save time, fasten process, simplify process, while keeping same functionality, results and experience."
SKILL.md rule 42 says how to present them; this file is the memory so the same idea is not offered twice and the owner can answer by number.

## How an idea is written
`N. <short name> - saves <minutes / taps / seconds / KB>; stays identical: <functionality, results, experience>; cost/risk: <what it takes, what could go wrong>; recommend: yes/no/later because ...`
- Only ideas from the work just done or from something that visibly cost time (a slow CI run, a manual step you repeated, a screen that needs too many taps). No filler: if there is nothing real, say "no new optimization ideas this time".
- Ideas are SUGGESTIONS. Implement one only after the owner says yes (SKILL rule 8). When he does, mark it Approved -> Done here with the PR number.
- Cover all four areas over time: (a) our development process (CI, local checks, PR flow), (b) deploy / droplet, (c) app speed (first paint, queries, bundle), (d) the owner's own taps and steps in the app. Never trade away behaviour, results or the experience he is used to: if an idea changes any of them it is a feature proposal, not an optimization, and goes through rule 25 (ask first).

## Backlog (status: Suggested unless noted)
Owner answered "1, 2, 3, 4, 5, 6, 7, 8" on 2026-10-24 = all eight approved; built in the same round (Field Visits #422, KAD OS #69, both merged 2026-10-24). Status below = Done. Measured on their own first CI runs: Field Visits 6+ min -> 2.5 min (10 jobs), KAD OS 6 min -> 3 min (9 jobs); locally Field Visits 8+ min -> 2 min and KAD OS 8 min -> 47 s with `scripts/local-ci.sh`.
1. [DONE 2026-10-24] **Skip the heavy CI jobs for documentation / skill-only PRs** - saves about 4 min per such PR; stays identical: the required checks still run and still go green (the aggregator jobs decide from a changed-files list); risk: a wrong path filter could skip a needed job, so keep `.github/`, `server/`, `client/` always on.
2. [DONE 2026-10-24] **Shard the browser tests further** (Playwright `--shard`, 3-4 runners per layout) - cold KAD OS run about 4 min -> about 2 min; stays identical: same tests, same checks; cost: more runner minutes.
3. [DONE 2026-10-24] **One command for the local checks** (`scripts/local-ci.sh`: start Postgres, fresh DB, check:version, verify:ui, tests in shards, in the background with one summary line) - saves about 10-20 min per task of hand-rolled loops and the "Postgres is down / JWT too short" detours; stays identical: same checks.
4. [DONE 2026-10-24] **Session-start hook that starts Postgres and prepares the test DB** (see the `session-start-hook` skill) - saves 2-5 min per session and removes the mass-failure false alarms; same tests.
5. [DONE 2026-10-24] **Weekly scheduled `npm audit fix` PR** - removes surprise red CI from newly published advisories (2026-10-24: body-parser, multer turned every PR red); the PR is still reviewed and merged as usual.
6. [DONE 2026-10-24] **Make the routePlanSets test deterministic** (it picks up other test files' temporary users and can hit a foreign-key race: failed once in CI on 2026-10-24, passed on re-run) - saves a re-run (about 2 min) whenever it flakes; same assertions.
7. [DONE 2026-10-24] **Shorter skill loading** - SKILL.md is about 25 KB and `domain-rules.md` about 128 KB; an index of 1-line summaries per section would let a task open only the sections it needs - saves reading time at the start of every task; same knowledge.
8. [DONE 2026-10-24] **Deploy block prints the versions before and after and checks `/healthz`** - the owner sees in one glance that the deploy took (no extra step for him); same deploy.

## Ideas from the round that built these (Suggested)
9. [DONE 2026-10-24] **Make the isolated bonus tests independent of the global switch** - done without touching the tests: `scripts/run-isolated.sh` gives EACH listed file a fresh database of its own and runs five at a time, so each bonus file has its own switch and nobody waits for anybody (the two isolated groups of 2 min and 1 min became one job of about 1 min; `server/test/isolated-bonus.txt` and `isolated-other.txt` merged into `isolated-tests.txt`). Same assertions.
10. [DONE 2026-10-24] **Run the Playwright browser tests of Field Visits in the same sharded way as KAD OS's** - `e2e (smoke shard 1/2, 2/2)` + summary `e2e-smoke`; honest gain small (13 smoke tests; most of that job is `npm ci` and the browser install).
11. [DONE 2026-10-24, KAD OS #71] **Add the `npm audit` gate to the KAD OS CI `static` job** - `static (version, ui, audit)`.
12. [OWNER ACTION, open] **Switch on the repository setting "Allow GitHub Actions to create and approve pull requests"** in both repos (Settings -> Actions -> General -> Workflow permissions; the tools in a session cannot change repository settings) - then the weekly dependency PR opens by itself instead of stopping at the last step.
13. [DONE 2026-10-24, 1.401.0] **Refresh Activity, Debt balances and Tasks when the person comes back with Back** (like Orders and Customers).
14. [DONE 2026-10-24, 1.401.0] **Remember the Customers "Group by" choice** on the device.
15. [DONE 2026-10-24, 1.401.0] **Collapsible region / subregion headers** in the grouped Customers list (fold state not remembered).
16. [DONE 2026-10-24, 1.401.0] **Tap the red "not in plans" number to open only the unplanned customers** (button inside switches to all).
17. [Suggested] **"Fold all / unfold all" in the grouped Customers list**, and optionally remember folded groups.
18. [Suggested] **Inbox of pending bank statements** that arrive from Telegram (Cashflow phase 3b).
19. [DONE 2026-10-24] **One command builds the claude.ai upload zip** - `python3 .claude/skills/KADDev/build-zip.py` (index rebuilt first, output `dist/kaddev-skill.zip`, validated); no more hand-made zips going stale.
20. [Suggested] **A short "what changed since your last upload" note** at the top of the zip's SKILL.md (generated from git log of `.claude/skills/`).
21. [DONE 2026-10-24, 1.402.0] **"Sync now" button for admins + "last Excel sync: date, result, file age" on the admin Home.**
22. [Suggested] **Bot tells the Telegram group when it ignores a chat or accepts a file** (one short reply "file received, synced N customers" / "this chat is not allowed, ask the CEO"): the 4-day silence would have shown the same day.
23. [Suggested, owner to choose] **Map: "Colour by Tier | Rep" switch** (ring colour per rep, legend behind the "i") and **today's planned pins: halo + stop number, with the Planned-today button getting 3 states (Off / Highlight / Only today)**.
24. [DONE 2026-10-24, 1.406.0] **Counts on the Administration list** (e.g. "Sales & customers · 3 waiting" for plan approvals / edit requests) so the red work shows before opening a page.
25. [Suggested] **Rebuild the PDF user guide** (Armenian + English) with the new Settings screens.
26. [Suggested] **"Recently opened" row at the top of the Settings search** (the last 3 settings you used).
27. [DONE 2026-10-24, 1.406.0] **Initials of the rep under map pins** when zoomed in (zoom >= 16) in "Colour by Rep" mode (CSS only shows them while the map container has `.map-zoom-high`).
28. [DONE 2026-10-24, 1.406.0] **One-tap "share today's route" to Telegram** (planned-stops panel): phone = share sheet, computer = Telegram's t.me share page; text = stops + Google Maps link.
29. [DONE 2026-10-24, server] **Push/in-app alert when the Excel FILE is older than 48 h** (`checkWorkbookAge` in `erpSyncMonitor.js`; once per file date, daytime Yerevan only).
30. [DONE 2026-10-24, bot PR #45] **Bot answers in the Telegram group**: file accepted + Field Visits result; ONE explanation per unknown chat per 6 h for a file.
31. [DONE 2026-10-24, 1.406.0] **Potential reasons remembered per level** (per user, per device; never "Other" / "counterfeit").
32. [DONE 2026-10-24, server] **Weekend-aware Excel alert** (the accountant posts no file on Saturday/Sunday, so Monday morning alerts can be false alarms): skip Sat/Sun from the 48 h count.
33. [DONE 2026-10-24, 1.408.0] **"Last used" reasons per level shared across devices** (stored on the server per user instead of the phone).
34. [DONE 2026-10-24, 1.408.0] **Rebuild the PDF user guide** (Armenian only, by the owner's choice).
35. [Suggested] **English PDF guide** refresh (the English file is still the 1.251.0 one).
36. [Suggested] **Bank statements from Telegram -> "pending" list in the app** with Confirm / Discard (owner agreed to confirm-first; waits for sample statements).

## Ideas from the first-launch round (2026-10-25, Suggested)
16. **Load only the active language of the translations** - saves about 55 KB compressed (about 0.3 s at 1.6 Mbit/s) and half the parse time on first launch; stays identical: every text, the language switch; cost/risk: `i18n.js` becomes a loader with top-level await, the language file must be preloaded or a language switch needs a short wait; recommend: later (gain is smaller than the 1.417.0 fix).
17. **Cache the rest of the app shell after the first screen** (service worker installs about 60 core files, fetches the other 130 views and sheets in idle time) - saves about 1 MB competing with the first taps on a slow link; stays identical: offline coverage a few seconds later; cost/risk: an update installed and then immediately used offline may miss a rarely used screen once; recommend: only if reps still report slow first taps.
18. **Trim the stylesheet** (`styles.css` 438 KB raw, 51 KB compressed, render-blocking) - saves about 0.1-0.2 s of first paint; cost/risk: dead-CSS removal needs a coverage run per screen; recommend: later.

