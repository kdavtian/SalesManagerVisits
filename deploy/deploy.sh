#!/usr/bin/env bash
# Simple deploy script — run this ON THE DROPLET from inside the repo
# checkout (e.g. /opt/field-visits). Pulls the latest code, rebuilds the
# app image, runs migrations, and restarts the stack.
#
# Fast by default (owner, 2026-10-21: "deploy takes forever"): never re-runs the integration test suite or the UI regression check,
# because GitHub Actions CI already ran both on this exact commit before it could be merged -- and a run on the droplet adds nothing
# CI cannot see (it uses an empty throw-away database, not your real data, and the same Postgres 16). It used to switch itself to the
# full run whenever a deploy added a migration; that cost 8-15 minutes on this small server and printed hundreds of log lines.
# What stays every time, and is the real protection: migrations (must succeed, run BEFORE the new app starts) and verify:deployment
# (health + served assets: catches "the deploy itself broke", which CI structurally can't see). Each step prints how long it took.
#   ./deploy/deploy.sh          # fast (default)
#   ./deploy/deploy.sh --full   # also run the whole test suite + UI checks here (slow; only when you want a second opinion)
set -euo pipefail
cd "$(dirname "$0")/.."
LAST_DEPLOY_SHA_FILE=".last-deploy-sha"

MODE="auto"
case "${1:-}" in
  --full) MODE="full" ;;
  --fast) MODE="fast" ;; # same as the default; kept so older habits and notes still work
  "") ;;
  *)
    echo "Usage: $0 [--full|--fast]" >&2
    exit 1
    ;;
esac

if [ ! -f .env ]; then
  echo "Missing .env — copy .env.example to .env and fill it in first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if [ -z "${JWT_SECRET:-}" ] || [ "${#JWT_SECRET}" -lt 16 ]; then
  echo "JWT_SECRET is missing or shorter than 16 characters in .env — refusing to deploy." >&2
  echo "Generate one with: openssl rand -base64 32" >&2
  exit 1
fi

if [ -z "${POSTGRES_PASSWORD:-}" ] || [ "${POSTGRES_PASSWORD}" = "fieldvisits" ]; then
  echo "POSTGRES_PASSWORD is unset or still the default 'fieldvisits' in .env — refusing to deploy." >&2
  echo "Set a strong POSTGRES_PASSWORD before deploying to production." >&2
  exit 1
fi

# Prints "    <step> took Ns" so it is visible where the time goes.
STEP_START=$SECONDS
step_done() { echo "    ($1: $((SECONDS - STEP_START))s)"; STEP_START=$SECONDS; }

PREV_SHA=""
if [ -f "$LAST_DEPLOY_SHA_FILE" ]; then
  PREV_SHA="$(cat "$LAST_DEPLOY_SHA_FILE")"
fi

echo "==> Pulling latest code"
git pull --ff-only
NEW_SHA="$(git rev-parse HEAD)"

RUN_FULL=false
[ "$MODE" = "full" ] && RUN_FULL=true
if [ -n "$PREV_SHA" ] && git cat-file -e "$PREV_SHA" 2>/dev/null; then
  NEW_MIGRATIONS="$(git diff --diff-filter=A --name-only "$PREV_SHA" "$NEW_SHA" -- server/migrations/ | wc -l | tr -d ' ')"
  echo "==> $NEW_MIGRATIONS new migration file(s) since the last deploy (applied below, before the new app starts)"
fi
step_done "pull"

# One-off containers (`docker compose run`: migrations, the full test run) normally remove themselves. If the SSH session
# drops mid-run (a phone deploy), the container is orphaned and keeps running, unhealthy, for days and eats memory on this
# small server (two of them were found after 3 days). Remove any left over from earlier deploys, only this project's.
echo "==> Removing leftover one-off containers from earlier runs"
LEFTOVER="$(docker ps -aq --filter "label=com.docker.compose.oneoff=True" --filter "label=com.docker.compose.project.working_dir=$PWD")"
if [ -n "$LEFTOVER" ]; then
  # shellcheck disable=SC2086
  docker rm -f $LEFTOVER > /dev/null
  echo "    removed $(echo "$LEFTOVER" | wc -l | tr -d ' ') leftover container(s)"
fi

echo "==> Building app image"
docker compose build app
step_done "build"

echo "==> Starting database"
docker compose up -d db

echo "==> Waiting for database to accept connections"
until docker compose exec -T db pg_isready -U "${POSTGRES_USER:-fieldvisits}" >/dev/null 2>&1; do
  sleep 1
done

echo "==> Running database migrations"
# Via a one-off container (docker compose run, not exec) so this runs
# against the *new* image's migrations before the app service itself is
# ever started -- migrating after starting it (the previous order) left a
# window where already-running requests could hit new code expecting a
# column/table the database didn't have yet, since nothing here waits for
# that gap to close before traffic can reach the app.
docker compose run --rm app npm run migrate
step_done "migrations"

if [ "$RUN_FULL" = true ]; then
  echo "==> Running unit tests"
  # Against a disposable `db-test` service (docker-compose.yml's own
  # "test" profile), NEVER the persistent `db` service above -- running the
  # integration suite directly against production once sent real push
  # notifications to real subscribed devices from fixture orders/checkins/
  # payments the tests created (see docs/incident-response.md's log for
  # 2026-09-17). `db-test` gets its own fresh migration run below,
  # independent of and after the real migration against `db` a few lines
  # up -- so this deploy's schema changes (e.g. new columns/tables) are
  # what the tests actually run against, without ever touching real data.
  # Torn down via a trap so a mid-run failure (set -e, e.g. a real test
  # failure) still removes the disposable container instead of leaking it.
  cleanup_db_test() {
    docker compose --profile test rm -sf db-test >/dev/null 2>&1 || true
  }
  trap cleanup_db_test EXIT

  docker compose --profile test up -d db-test
  until docker compose --profile test exec -T db-test pg_isready -U postgres >/dev/null 2>&1; do
    sleep 1
  done
  TEST_DATABASE_URL="postgres://postgres:postgres@db-test:5432/fieldvisits_test"
  docker compose run --rm -e DATABASE_URL="$TEST_DATABASE_URL" -e NODE_ENV=test app npm run migrate
  docker compose run --rm -e DATABASE_URL="$TEST_DATABASE_URL" -e NODE_ENV=test app npm test

  cleanup_db_test
  trap - EXIT
fi

echo "==> Starting app"
docker compose up -d app
step_done "start"

if [ "$RUN_FULL" = true ]; then
  echo "==> Running UI regression checks"
  docker compose exec -T app npm run verify:ui
fi

echo "==> Waiting for app health and checking served assets"
docker compose exec -T app npm run verify:deployment
step_done "health check"

# Only recorded once everything above has actually succeeded (set -e would
# have already exited on any failure) -- a failed deploy never gets to
# claim this commit as a known-good baseline for the next run's fast path.
echo "$NEW_SHA" > "$LAST_DEPLOY_SHA_FILE"

# Housekeeping: every deploy leaves build files behind (the droplet once had 10 GB of them on a 24 GB disk). Keep the
# newest 2 GB (so the next deploy stays fast), drop the rest. Cannot touch containers, images in use or volumes, and a
# failure here must never fail a deploy that already succeeded.
echo "==> Cleaning old build cache"
docker builder prune --keep-storage 2gb -f > /dev/null 2>&1 || true

echo "==> Current status"
docker compose ps

echo
echo "Done. On the very first deploy, also run:"
echo "  docker compose exec app npm run seed"
echo "to create the initial admin account."
