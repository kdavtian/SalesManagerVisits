#!/usr/bin/env bash
# Simple deploy script — run this ON THE DROPLET from inside the repo
# checkout (e.g. /opt/field-visits). Pulls the latest code, rebuilds the
# app image, runs migrations, and restarts the stack.
#
# Fast by default: skips the integration test suite and UI regression
# check, since GitHub Actions CI already ran both on every commit before
# it was mergeable -- re-running them again here is pure redundancy for
# any commit that went through the normal PR flow. What stays every time:
# migrations (must succeed regardless) and verify:deployment (a fast
# health/served-assets check that catches "the deploy itself broke",
# which CI structurally can't see).
#
# Auto-escalates to the full (slow) path when this deploy adds new
# migration files -- schema changes are exactly the case where the local
# test suite catches something CI's separate database run wouldn't (see
# the ordering comment on the migrate/test steps below). Override either
# way with an explicit flag:
#   ./deploy/deploy.sh          # fast unless new migrations detected
#   ./deploy/deploy.sh --full   # always run the full test/UI checks
#   ./deploy/deploy.sh --fast   # always skip them, even with new migrations
set -euo pipefail
cd "$(dirname "$0")/.."
LAST_DEPLOY_SHA_FILE=".last-deploy-sha"

MODE="auto"
case "${1:-}" in
  --full) MODE="full" ;;
  --fast) MODE="fast" ;;
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

PREV_SHA=""
if [ -f "$LAST_DEPLOY_SHA_FILE" ]; then
  PREV_SHA="$(cat "$LAST_DEPLOY_SHA_FILE")"
fi

echo "==> Pulling latest code"
git pull --ff-only
NEW_SHA="$(git rev-parse HEAD)"

RUN_FULL=false
case "$MODE" in
  full) RUN_FULL=true ;;
  fast) RUN_FULL=false ;;
  auto)
    if [ -z "$PREV_SHA" ]; then
      # No record of the last deployed commit (first run of this script
      # version, or the marker file was lost) -- run full once rather than
      # guess, so a fast path is never taken on faith.
      echo "==> No previous-deploy marker found -- running full checks once to establish one"
      RUN_FULL=true
    elif ! git cat-file -e "$PREV_SHA" 2>/dev/null; then
      echo "==> Previous-deploy marker ($PREV_SHA) not found in history -- running full checks"
      RUN_FULL=true
    elif [ -n "$(git diff --diff-filter=A --name-only "$PREV_SHA" "$NEW_SHA" -- server/migrations/)" ]; then
      echo "==> New migration file(s) detected since last deploy -- running full checks"
      RUN_FULL=true
    else
      echo "==> No new migrations since last deploy -- fast path (skipping tests/UI checks; CI already ran them)"
    fi
    ;;
esac

echo "==> Building app image"
docker compose build app

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

if [ "$RUN_FULL" = true ]; then
  echo "==> Running UI regression checks"
  docker compose exec -T app npm run verify:ui
fi

echo "==> Waiting for app health and checking served assets"
docker compose exec -T app npm run verify:deployment

# Only recorded once everything above has actually succeeded (set -e would
# have already exited on any failure) -- a failed deploy never gets to
# claim this commit as a known-good baseline for the next run's fast path.
echo "$NEW_SHA" > "$LAST_DEPLOY_SHA_FILE"

echo "==> Current status"
docker compose ps

echo
echo "Done. On the very first deploy, also run:"
echo "  docker compose exec app npm run seed"
echo "to create the initial admin account."
