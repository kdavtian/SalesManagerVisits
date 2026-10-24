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
