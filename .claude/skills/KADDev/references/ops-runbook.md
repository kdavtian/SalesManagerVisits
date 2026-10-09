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
- The session prompt designates the branch; open the PR as DRAFT with the repo template headings; end the PR body with the attribution lines from the session; subscribe with `subscribe_pr_activity`. Standing instruction: merge (squash) when CI is green, then unsubscribe. A merged PR is finished - new work restarts the branch from `origin/main`.
- CI red: reproduce, root-cause, fix in code the PR touches; known cross-file test-parallelism flakes (orderLifecycle notification FK, bonusReconciliation, erp-sync daily-report) may be re-run once; never skip tests, never push empty commits.
- Stop-hook messages ("uncommitted changes / unpushed commits") mean: commit and push on the designated branch.
- GitHub access is via MCP tools (`mcp__github__*`); the `gh` CLI is not available. The bot repo (`kdavtian/castrol_ceo_report`) may need `add_repo` and is pushed from `/home/user/castrol_ceo_report` (pushes can hit transient "connection reset" - retry).
- Bot PR #28 (workbook 2.0.7 support + silver fallback) was open at last check; remember it must be merged and the droplet bot updated for the new price columns/tier to take effect.

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
- **Branch recipe after a merge** (force-push is blocked): `git fetch origin && git checkout -B <branch> origin/main`, work, commit, then `git fetch origin <branch> && git merge -s ours origin/<branch> -m "Merge already-merged branch history (keep new work)" && git push -u origin <branch>` (plain push, fast-forward). Create the draft PR, `subscribe_pr_activity`, wait for `check_suite.completed`, read `get_check_runs`, `update_pull_request draft:false`, `merge_pull_request squash`; the session auto-unsubscribes on merge.
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
- **PR flow every time**: draft PR -> subscribe -> CI (`test`, `e2e-smoke`) green -> ready -> squash merge -> unsubscribe; then `git fetch origin && git checkout -B <branch> origin/main`; push later work with `git merge -s ours origin/<branch>` first (force-push blocked).
- **GitHub MCP disconnects**: reload with ToolSearch `select:mcp__github__...`.
- **Skill/docs-only changes** (`.claude/`) need no version bump.
