#!/usr/bin/env bash
# SessionStart hook for Claude Code cloud sessions: make the tests runnable from the first minute.
# The sandbox stops Postgres between turns and nothing is prepared in a fresh session; every task used to lose minutes (and chase
# false "everything fails" alarms) on that. Synchronous on purpose: the session starts only when this has finished.
# Remote sessions only; idempotent; never prints secrets (the values below are CI's throw-away test constants).
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

# 0. A branch whose work is already merged starts again from main (2026-11 analysis: 128 "restart the branch" commits by hand).
#    Only when the working tree is clean and merging the branch into origin/main would change nothing (squash-merged work):
#    the branch then becomes origin/main plus a "keep history" merge of its remote copy, so the next push is a normal one.
(
  cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
  br="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
  [ "$br" = "HEAD" ] || [ "$br" = "main" ] && exit 0
  [ -z "$(git status --porcelain 2>/dev/null)" ] || exit 0
  git fetch -q origin main 2>/dev/null || exit 0
  git merge-base --is-ancestor origin/main HEAD 2>/dev/null && exit 0   # already up to date with main
  if git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    git merge -q --ff-only origin/main && echo "session-start: $br fast-forwarded to main"
    exit 0
  fi
  tree="$(git merge-tree --write-tree origin/main HEAD 2>/dev/null | head -1)" || exit 0
  [ "$tree" = "$(git rev-parse origin/main^{tree})" ] || exit 0       # the branch still has work main does not: leave it alone
  old="$(git rev-parse HEAD)"
  git checkout -q -B "$br" origin/main
  git -c user.name="session-start" -c user.email="session-start@users.noreply.github.com" merge -q -s ours --no-edit "$old" \
    -m "Keep the merged history of the branch" && echo "session-start: $br restarted from main (its work was already merged)"
) || true
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
# a brand-new container's Postgres has no password: give the local superuser the throw-away test password once (root only)
if [ "$(id -u)" = 0 ] && command -v psql >/dev/null 2>&1 && ! psql "postgres://postgres:postgres@localhost:5432/postgres" -tAc 'select 1' >/dev/null 2>&1; then
  su postgres -c "psql -qc \"ALTER USER postgres PASSWORD 'postgres'\"" >/dev/null 2>&1 || true
fi
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
