# Optimization ideas - the standing "suggest, do not implement" backlog

Owner rule (2026-10-24): "Always suggest me optimization variants, which can save time, fasten process, simplify process, while keeping same functionality, results and experience."
SKILL.md rule 42 says how to present them; this file is the memory so the same idea is not offered twice and the owner can answer by number.

## How an idea is written
`N. <short name> - saves <minutes / taps / seconds / KB>; stays identical: <functionality, results, experience>; cost/risk: <what it takes, what could go wrong>; recommend: yes/no/later because ...`
- Only ideas from the work just done or from something that visibly cost time (a slow CI run, a manual step you repeated, a screen that needs too many taps). No filler: if there is nothing real, say "no new optimization ideas this time".
- Ideas are SUGGESTIONS. Implement one only after the owner says yes (SKILL rule 8). When he does, mark it Approved -> Done here with the PR number.
- Cover all four areas over time: (a) our development process (CI, local checks, PR flow), (b) deploy / droplet, (c) app speed (first paint, queries, bundle), (d) the owner's own taps and steps in the app. Never trade away behaviour, results or the experience he is used to: if an idea changes any of them it is a feature proposal, not an optimization, and goes through rule 25 (ask first).

## Backlog (status: Suggested unless noted)
1. **Skip the heavy CI jobs for documentation / skill-only PRs** - saves about 4 min per such PR; stays identical: the required checks still run and still go green (the aggregator jobs decide from a changed-files list); risk: a wrong path filter could skip a needed job, so keep `.github/`, `server/`, `client/` always on.
2. **Shard the browser tests further** (Playwright `--shard`, 3-4 runners per layout) - cold KAD OS run about 4 min -> about 2 min; stays identical: same tests, same checks; cost: more runner minutes.
3. **One command for the local checks** (`scripts/local-ci.sh`: start Postgres, fresh DB, check:version, verify:ui, tests in shards, in the background with one summary line) - saves about 10-20 min per task of hand-rolled loops and the "Postgres is down / JWT too short" detours; stays identical: same checks.
4. **Session-start hook that starts Postgres and prepares the test DB** (see the `session-start-hook` skill) - saves 2-5 min per session and removes the mass-failure false alarms; same tests.
5. **Weekly scheduled `npm audit fix` PR** - removes surprise red CI from newly published advisories (2026-10-24: body-parser, multer turned every PR red); the PR is still reviewed and merged as usual.
6. **Make the routePlanSets test deterministic** (it picks up other test files' temporary users and can hit a foreign-key race: failed once in CI on 2026-10-24, passed on re-run) - saves a re-run (about 2 min) whenever it flakes; same assertions.
7. **Shorter skill loading** - SKILL.md is about 25 KB and `domain-rules.md` about 128 KB; an index of 1-line summaries per section would let a task open only the sections it needs - saves reading time at the start of every task; same knowledge.
8. **Deploy block prints the versions before and after and checks `/healthz`** - the owner sees in one glance that the deploy took (no extra step for him); same deploy.
