# Ops runbook - deploy, droplet, CI, PRs

## Environment facts
- One DigitalOcean droplet (Ubuntu 24.04), hostname `castrol-ceo-bot`, IP 164.92.171.41. App in `/opt/field-visits` (docker compose: `app`, `db`, optional `osrm`), bot in `/opt/castrol-ceo-bot`. HTTPS host `fieldvisits.164.92.171.41.sslip.io`.
- DB: user AND db are `fieldvisits` (there is NO `postgres` role): `docker compose exec db psql -U fieldvisits -d fieldvisits -c "..."`. Run compose commands from `/opt/field-visits` (else "no configuration file provided").
- The owner often deploys from an iPhone / Windows PowerShell terminal over SSH, and they paste outputs back. Give ONE ready-to-copy block, no placeholders, no secrets, no `<angle brackets>` (bash chokes on them), short expected output.
- There is no auto-deploy: merging to GitHub changes nothing in production until commands run on the droplet.

## App deploy (preferred, fast)
```
cd /opt/field-visits && ./deploy/deploy.sh
```
Pulls main, builds the app image, runs migrations, restarts, runs `verify:deployment`. Fast by default (~30-60 s, the owner insists on speed); auto-escalates to the full test/UI checks when the deploy adds migration files; flags `--full` / `--fast`. Manual equivalent when compose's `osrm` service breaks things:
```
cd /opt/field-visits && git pull origin main && docker compose build app && docker compose run --rm app npm run migrate && docker compose up -d --no-deps app
```
Migrations are never applied implicitly - ALWAYS tell the owner when a PR adds `server/migrations/*`.
Check what is live: `docker compose exec app cat /app/client/public/js/version.js` and `... sw.js | head -1` (CACHE_VERSION).
If phones do not update: nearly always CACHE_VERSION in sw.js was not bumped (hard rule) or the droplet was not rebuilt; then "Check for updates" in Settings.

## Bot deploy
```
cd /opt/castrol-ceo-bot && sudo -u castrolbot git pull origin main && sudo systemctl restart castrol-ceo-bot && sudo systemctl status castrol-ceo-bot --no-pager | head -5
```
(`git pull` as root fails with ".git/objects insufficient permission" - use `sudo -u castrolbot`; GitHub asks for a username/token: password auth is not supported, use a PAT; the owner got confused about this - the repo is private.) Then re-send the workbook to the bot in Telegram to trigger a sync. Check logs: `sudo journalctl -u castrol-ceo-bot -n 100 --no-pager | grep -i "field visits"` (expect "Field Visits sync: pushed N customer records, ... products").

## Handy prod SQL (always read-only first)
- Version/flag: `select bonuses_enabled from app_settings where id=1;`
- HC codes live: `select count(*) filter (where hc_code is not null), count(*) from products;`
- Clean test users: `delete from users where email like 'itest-%@%' or email like '%@kadmotors.local';` (owner had 6 left over; admin can also delete a user after seeing and deleting linked records via the Admin UI).
- Lily tokens: `docker compose exec app node scripts/integration-token.mjs create "<name>" [--test]` (token shown once; never paste it back in chat; revoke via the admin UI/script).

## CI and PR flow
- GitHub Actions: `test` (npm ci, check:version, migrate, npm test, verify:ui, audit) and `e2e-smoke` (Playwright). Typical wait 5+ min; owner asked why CI is slow - answer honestly (full integration suite + migrations + browser).
- Actions minutes (2026-10-27, after the private repos ran out of the monthly allowance): CI runs only on READY pull requests (a draft runs nothing) and not again on `main` after a squash merge; Field Visits' full browser suite runs Mon + Thu, KAD OS runs its browser tests on 2 runners (desktop, phone). Field Visits is public (minutes free); KAD-GMM and castrol_ceo_report are private and share the personal account's allowance; the website moved to the KAD-Motors organization (own allowance).
- The session prompt designates the branch; open the PR as DRAFT with the repo template headings; end the PR body with the attribution lines from the session; subscribe with `subscribe_pr_activity`. Standing instruction: merge (squash) when CI is green, then unsubscribe. A merged PR is finished - new work restarts the branch from `origin/main`.
- CI red: reproduce, root-cause, fix in code the PR touches; known cross-file test-parallelism flakes (orderLifecycle notification FK, bonusReconciliation, erp-sync daily-report) may be re-run once; never skip tests, never push empty commits.
- Stop-hook messages ("uncommitted changes / unpushed commits") mean: commit and push on the designated branch.
- GitHub access is via MCP tools (`mcp__github__*`); the `gh` CLI is not available. The bot repo (`kdavtian/castrol_ceo_report`) may need `add_repo` and is pushed from `/home/user/castrol_ceo_report` (pushes can hit transient "connection reset" - retry).
- Bot PR #28 (workbook 2.0.7 support + silver fallback) was open at last check; remember it must be merged and the droplet bot updated for the new price columns/tier to take effect.

- **CI is parallel now (2026-10-24).** Every workflow starts with `changes (docs only?)`: it diffs the PR (merge commit vs its base) or the push (before..HEAD); only `docs/`, `.claude/skills/` and `*.md` -> `code=false` -> the slow jobs are SKIPPED and the summary jobs accept "skipped"; no usable base, a manual run (`workflow_dispatch`) or any other file -> everything runs. `.github/**` is never "docs", so a CI change always runs the full CI on itself.
  - Field Visits: `static (version, ui, audit)` (always, about 15 s), `tests (shard 1..4/4)` (`node --test --test-shard=i/4` over every test file NOT listed in `server/test/isolated-tests.txt`, each shard its own Postgres service), `tests (isolated, one database per file)` (`scripts/run-isolated.sh`: every listed file in its own fresh database, five at a time, about 1 min), summary `test`; `e2e (smoke shard 1..2/2)` (Playwright `--shard`, browser cache) -> summary `e2e-smoke`. About 2-3 min.
  - KAD OS: `static (version, ui, audit)` (always; the audit step is `npm audit --audit-level=high`), `tests (unit + integration)` (sequential, shared database, about 1.8 min), summary `test`; `e2e (desktop|phone n/2)` = 2 layouts x 2 shards (`--shard --fully-parallel --workers=1`, each its own database; the tests were checked to be independent), summary `e2e-smoke`. About 3 min cold.
  - The weekly `audit-fix.yml` (both repos): Mondays 05:17 UTC, only when `npm audit --audit-level=high` is red it runs `npm audit fix` (no --force), pushes `chore/audit-fix-YYYYMMDD`, opens a PR and starts CI on it with `gh workflow run ci.yml` (a push by GITHUB_TOKEN does not start CI). Needs the repository setting Settings -> Actions -> General -> "Allow GitHub Actions to create and approve pull requests"; without it the workflow turns red at the last step ("GitHub Actions is not permitted to create or approve pull requests") AFTER it has already pushed the fix branch: then open the PR by hand from `chore/audit-fix-YYYYMMDD` and start CI with `gh workflow run ci.yml --ref <branch>` (the tools: `create_pull_request`, then `actions_run_trigger run_workflow`). First run 2026-10-24: Field Visits green (nothing to fix), KAD OS found the same body-parser advisory, fixed it and hit exactly this missing setting (fix merged as KAD OS #70).
  - A superseded push cancels the older run; every job has a timeout.
- **Reading a red job**: `get_job_logs` with `return_content` and a big `tail_lines` is saved to a file when it is too long; slice it with python (`json.loads(...)['logs_content']`, replace `\n`, find the first check mark failure `✖` or `failing tests`). The postgres service log at the top is noise.
- **Reproduce locally exactly as CI does it: `bash scripts/local-ci.sh`** (fresh database per shard, parallel, one summary line). A failure that only appears in ONE shard (foreign-key error, a count nobody else sees) is a hidden cross-file race on global state: found so far = erpSync TRUNCATEs erp_customer_data, the single `app_settings.bonuses_enabled` switch (10 bonus files), the one active route plan (activateSet rewrites every rep's rules), Vaghinak's engine tick (scans the whole database). Put the culprit file in `server/test/isolated-tests.txt` (read `server/test/ISOLATED.md`), never skip the test.
- After a squash-merge: `git fetch origin main && git checkout -B <branch> origin/main`, then `git push --force-with-lease -u origin <branch>` so the stop hook stops reporting "unpushed commits" (the remote branch still holds the pre-squash commits).

## Local environment (for verification)
- `pg_ctlcluster 16 main start`; `DATABASE_URL=postgres://postgres:postgres@localhost:5432/fieldvisits_test`; `JWT_SECRET` >= 16 chars (e.g. 24 x's) or every login 500s ("JWT_SECRET is missing or too short").
- Browser driving: Playwright with `/opt/pw-browsers/chromium`; start the server on port 3001 with `E2E_RATE_LIMIT_BYPASS_TOKEN=qa`; do not `pkill -f` on command text (kills the harness).
- Slow commands (`npm test`) run in background; read output file after the completion notification.

## Lessons added 2026-10-05
- **"dubious ownership" on the bot**: `git pull` as `castrolbot` fails after any root-run git touched the repo. Fix: `chown -R castrolbot:castrolbot /opt/castrol-ceo-bot` then `sudo -u castrolbot git pull origin main && systemctl restart castrol-ceo-bot`. The repo is private, so git asks for GitHub username + token (password auth is gone); caching a token (`git config credential.helper store`) avoids retyping - never ask the owner to paste it in chat.
- **A bot code change only matters after BOTH steps**: pull + restart, then re-send the workbook in Telegram (the old process may have handled the previous file). Verify with `products.synced_at` / `net_cost_amd` and the journal line `Field Visits sync: pushed ...`.
- **Deploy speed**: `./deploy/deploy.sh` auto-escalates to the full 5-minute test run when a PR adds `server/migrations/*`; CI already ran them, so tell the owner to use `./deploy/deploy.sh --fast`.
- **Desktop map "The map couldn't load"** (1.246.0): helmet's default `Referrer-Policy: no-referrer` removed the Referer that OpenStreetMap/Wikimedia tile servers require. Header is now `strict-origin-when-cross-origin`; tile cache bumped to `field-visits-tiles-v5`. If tiles fail again, ask for the status of a `tile.openstreetmap.org` request in the Network tab.
- **Excel structure change broke `Debits[Assigned To]`** (returned Tier): see skill `Castrol-file`. When the owner inserts columns, re-check every VLOOKUP column index.

## Lessons added 2026-10-08
- **Deploy command to give the owner**: no migration in the release -> `cd /opt/field-visits && ./deploy/deploy.sh --fast`; a migration (e.g. 093 tasks, 094 checkins index) -> `cd /opt/field-visits && ./deploy/deploy.sh` (full). State which one in every summary.
- **Branch recipe after a merge** (force-push is blocked): `git fetch origin && git checkout -B <branch> origin/main`, work, commit, then `git fetch origin <branch> && git merge -s ours origin/<branch> -m "Merge already-merged branch history (keep new work)" && git push -u origin <branch>` (plain push, fast-forward). Create the draft PR, `subscribe_pr_activity`, `update_pull_request draft:false` when the work is complete (CI runs only on ready PRs), wait for `check_suite.completed`, read `get_check_runs`, `merge_pull_request squash`; the session auto-unsubscribes on merge.
- **Stop hook** ("uncommitted changes / unpushed commits") fires while background tests run: commit + push immediately, open the PR, keep waiting for tests/CI.
- **After an environment reset** the repo may lack `server/node_modules`, `server/.env`, a running Postgres and the test DB: `cd server && npm ci`, write `.env` (DATABASE_URL, JWT_SECRET >= 16 chars, PORT, NODE_ENV), `pg_ctlcluster 16 main start`, `su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres'\""`, `createdb fieldvisits_test`, `npm run migrate`. Always restart Postgres at the start of a turn.
- **Demo server for browser checks**: `fuser -k 3201/tcp; (PORT=3201 NODE_ENV=test E2E_RATE_LIMIT_BYPASS_TOKEN=guide node src/index.js &)`; Playwright Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (`import { chromium } from ".../server/node_modules/playwright/index.mjs"`); seed users/customers with `test/integration/helpers.js` (`createUser`, `createCustomer`; password `TestPass123!`). Ignore `ERR_TUNNEL_CONNECTION_FAILED` (sandbox blocks map tiles); only `pageerror` matters. Never `pkill -f` (kills the harness).
- **Flaky locally, known**: "POST /api/erp-sync/daily-report and /reports: two calls in quick succession land as ONE combined notification" - 468/469 is the normal local result; CI is the judge.
- **GitHub MCP tools can disconnect and reconnect mid-session**: if `mcp__github__*` vanishes, `ToolSearch` for them (it waits for reconnect) instead of reporting them unavailable.
- **CI failure forensics**: `get_check_runs` -> `get_job_logs(job_id, return_content, tail_lines=400)`; the Playwright smoke log shows `[WebServer] error:` stack traces from the app with file:line.
- **Re-running a red CI job (known flake)**: confirm the same single failure locally (`npm test`: 473-474/475 with only the erp-sync notification test failing), post ONE PR comment saying so (end it with the `---` / `_Generated by [Claude Code](https://claude.ai/code)_` footer), then `mcp__github__actions_run_trigger` (load with ToolSearch `select:mcp__github__actions_run_trigger`) with `method: rerun_failed_jobs` and the `run_id` from the check's `details_url` (`/actions/runs/<run_id>/job/...`). Only once per PR; a second red is real.
- Job logs are huge: `get_job_logs` with `tail_lines` 250 only shows the end (counts + Postgres noise); the `# fail N` line tells you how many failed but not which. Prefer reproducing locally; use a large `tail_lines` only when you must name the failing test.
- Postgres log lines like "violates check constraint orders_accounting_doc_matches_payment" / "duplicate key" / FK errors in CI output are usually EXPECTED errors from tests that probe those rules - not the failure.


## Lessons added 2026-10-09
- **Deploy commands**: no migration -> `cd /opt/field-visits && ./deploy/deploy.sh --fast`; migration present (e.g. 098-100) -> full `./deploy/deploy.sh`. Always state which.
- **Local tests**: set `NODE_ENV=test`; Postgres may stop -> `pg_ctlcluster 16 main start`; kill the dev server with `ps -eo pid,args | awk '$2=="node" && $3=="src/index.js"{print $1}' | xargs -r kill` (never `pkill -f`).
- **Screenshot recipe**: seed demo data with `test/integration/helpers.js`, run server with `NODE_ENV=test`, drive Playwright Chromium; if the headless-shell path is missing, symlink `chromium_headless_shell-1243` to the installed 1194 dir; LOOK at screenshots.
- **CI flake vs real**: a red `test` that passes on re-run still deserves a reproduction attempt; dates in tests must use the Yerevan date (UTC `CURRENT_DATE` fails near midnight).
- **PR flow every time**: draft PR -> subscribe -> ready (starts CI; drafts run nothing) -> CI (`test`, `e2e-smoke`) green -> squash merge -> unsubscribe; then `git fetch origin && git checkout -B <branch> origin/main`; push later work with `git merge -s ours origin/<branch>` first (force-push blocked).
- **GitHub MCP disconnects**: reload with ToolSearch `select:mcp__github__...`.
- **Skill/docs-only changes** (`.claude/`) need no version bump.


## Lessons added 2026-10-10
- **`deploy.sh --fast` still runs migrations** (`npm run migrate` on every deploy) and `verify:deployment`; "fast" only skips the integration tests and UI check. Without a flag it auto-escalates to the full path when the new commits add migration files. So "the column does not exist" after a fast deploy is not the usual cause of a failed save.
- **Prove a data-layer doubt in one command**: `cd /opt/field-visits && docker compose exec db psql -U fieldvisits -d fieldvisits -c "SELECT count(*) FROM customers WHERE credit_limit_amd IS NOT NULL;" -c "SELECT max(name) FROM schema_migrations;"` (latest migration should be the newest file in `server/migrations/`).
- **Server tests cannot see client request bugs** (headers, wrong body shape, missing fields): for "it does not save" reports, drive the real UI in Playwright with `page.on("response")` logging method, URL, status and body, then compare with the DB row.
- **Playwright seed/screenshot recipe (works)**: `pg_ctlcluster 16 main start` first (Postgres is stopped between turns), `set -a && . server/.env && set +a && export NODE_ENV=test`, import helpers (`startTestServer, createUser, createCustomer, loginAs, apiFormRequest`) and `chromium` from `server/node_modules/playwright/index.mjs`, executablePath `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, context `isMobile/hasTouch`, add ALL cookies from `loginAs`, `page.route` only the real tile hosts (`openstreetmap|cartocdn|arcgisonline`), `localStorage fieldvisits_map_cluster=off` via `addInitScript` to count individual map pins (pin class `pin-tier-*` tells tier), `process.exit(0)` at the end and delete the seeded rows. Leftover rows from other tests share the DB: search for your own names before counting.
- **Reading screenshots**: after a layout fix ALWAYS re-open the new screenshot; Armenian labels are the widest (check tabs/chips for truncation, `scrollWidth` vs `clientWidth`).
- **Wiring audit script (reusable idea)**: parse `server/src/reports/reports.js` keys vs `views/reports.js` + i18n `report_<key>_name/description` in both languages; every `t("key")` used in client JS must exist in en AND hy; every `api.js` path's last segment must exist server-side; every `NOTIFICATION_TYPES` entry needs `notification_type_*`; migrations apply from scratch; full `npm test`; `verify:ui`; bot `python -m unittest discover -s tests`.
- **GitHub MCP**: after a disconnect the tools come back by themselves; try the call again (or ToolSearch) before reporting a problem.


## Lessons added 2026-10-24 (the optimization round)
- Tests that passed for months only because everything ran in one slow pass share global state; splitting CI exposed five such families (see `ISOLATED.md`). When a split makes a test fail in one place only, isolate it; do not retry until green.
- `deploy.sh` (both apps) now prints `version: old -> new` and ends with `OK: <app> <new> is live and healthy (was <old>)`; same deploy steps as before.
- The session-start hook (`.claude/hooks/session-start.sh`, registered in `.claude/settings.json`, remote sessions only) runs synchronously: npm install, start Postgres, create/prepare the test database, export the test connection variables. If it ever slows session start too much it can be made async (`{"async": true}`), at the price of a race with the first test run.
- Opening a PR by hand (as the owner's user) DOES start CI by itself, so starting CI again with `workflow_dispatch` on the same branch runs it twice: only dispatch when the PR was opened by the workflow's own token.
- The docs-only skip was proven on its first real use (Field Visits #423): `changes`, `static` and the `test` summary ran, the four shards, both isolated groups and `e2e-smoke` were skipped, and the PR was green in about 20 seconds.

## Lessons added 2026-10-24 (features round)
- Bot deploy is separate from the app deploy: `cd /opt/castrol-ceo-bot && sudo -u castrolbot git pull origin main && sudo systemctl restart castrol-ceo-bot`; its log: `sudo journalctl -u castrol-ceo-bot -n 100 --no-pager | grep -i "field visits"`. Failed syncs also show in `GET /api/erp-sync/attempts` (admin / CEO / ops director).
- A migration means the FULL deploy command, not `--fast` (last migration on main: 146). Say which one in the summary.
- Local verification: `pg_ctlcluster 16 main start`, `cd server && set -a && . ./.env && set +a && export NODE_ENV=test` (without it the sync notification debounce is 45 s and tests look broken), `npm run migrate`, then `npx playwright test <files> --reporter=line`. `scripts/local-ci.sh` can stall under load: run the shard alone to confirm.
- CI shared-database flakes seen: `opsHome`, `opsControlB` (foreign key race). Protocol: one PR comment + one re-run, never skip a test.
- Merge flow that worked every time: draft PR -> `subscribe_pr_activity` -> `update_pull_request draft:false` (starts CI) -> `get_check_runs` all green (incl. `test`, `e2e-smoke`) -> squash merge -> unsubscribe -> `git checkout -B <branch> origin/main` + `push --force-with-lease=<branch>:<sha from git ls-remote>`.

