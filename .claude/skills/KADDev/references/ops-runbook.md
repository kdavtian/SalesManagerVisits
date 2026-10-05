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
