#!/usr/bin/env bash
# SessionStart hook for Claude Code cloud sessions: make the tests runnable from the first minute.
# The sandbox stops Postgres between turns and nothing is prepared in a fresh session; every task used to lose minutes (and chase
# false "everything fails" alarms) on that. Synchronous on purpose: the session starts only when this has finished.
# Remote sessions only; idempotent; never prints secrets (the values below are CI's throw-away test constants).
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}/server"

# 1. dependencies (npm install, not ci: the container state is cached after this hook)
npm install --no-audit --no-fund --prefer-offline >/dev/null 2>&1 || npm install --no-audit --no-fund

# 2. Postgres up
if command -v pg_isready >/dev/null 2>&1 && ! pg_isready -q 2>/dev/null; then
  ver="$(pg_lsclusters -h 2>/dev/null | awk 'NR==1{print $1}')"
  [ -n "$ver" ] && pg_ctlcluster "$ver" main start 2>/dev/null || true
  for _ in $(seq 1 20); do pg_isready -q 2>/dev/null && break; sleep 1; done
fi

# 3. the disposable test database, migrated (skipped quietly when there is no local Postgres)
PGBASE=""
for c in "postgres://gmm:gmm@127.0.0.1:5432" "postgres://postgres:postgres@localhost:5432"; do
  psql "$c/postgres" -tAc 'select 1' >/dev/null 2>&1 && { PGBASE="$c"; break; }
done
if [ -n "$PGBASE" ]; then
  psql "$PGBASE/postgres" -tAc "select 1 from pg_database where datname='fieldvisits_test'" | grep -q 1 \
    || psql "$PGBASE/postgres" -qc "CREATE DATABASE fieldvisits_test" >/dev/null
  DATABASE_URL="$PGBASE/fieldvisits_test" JWT_SECRET=ci-test-secret-not-used-anywhere-real NODE_ENV=test npm run migrate >/dev/null 2>&1 || true
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    {
      echo "export DATABASE_URL=\"$PGBASE/fieldvisits_test\""
      echo 'export JWT_SECRET="ci-test-secret-not-used-anywhere-real"'
    } >> "$CLAUDE_ENV_FILE"
  fi
fi
echo "session-start: dependencies ready, Postgres $(pg_isready 2>/dev/null | sed 's/.*- //'), test database ${PGBASE:+ready}"
