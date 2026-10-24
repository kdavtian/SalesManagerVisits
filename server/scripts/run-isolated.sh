#!/usr/bin/env bash
# Runs every test file listed in the given list file(s) in its OWN fresh database, several at a time (default 5).
#   bash scripts/run-isolated.sh test/isolated-tests.txt
# Why: these files change or read state every other test can see (the one bonuses switch, lockdown, the ERP sync's TRUNCATE, the one active
# route plan, Vaghinak's whole-database tick). In a database of their own they cannot disturb anybody, and nobody disturbs them, so they no
# longer have to wait for each other either: the time is that of the slowest file, not the sum. The test code itself is unchanged.
# Env: PGBASE = admin connection WITHOUT a database name, e.g. postgres://postgres:postgres@localhost:5432 (required);
#      JOBS (default 5); ISOLATED_LOG (default /tmp/isolated). A database is dropped after its file passed and kept after a failure.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${PGBASE:?set PGBASE, e.g. postgres://postgres:postgres@localhost:5432}"
export PGBASE JOBS="${JOBS:-5}" LOG="${ISOLATED_LOG:-/tmp/isolated}"
export JWT_SECRET="${JWT_SECRET:-ci-test-secret-not-used-anywhere-real}" NODE_ENV=test
mkdir -p "$LOG"; rm -f "$LOG"/*

run_one() {
  local f="$1" name db
  name="$(basename "$f" .test.js)"
  db="fieldvisits_iso_$(echo "$name" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9\n' '_' | cut -c1-40)"
  psql "$PGBASE/postgres" -qc "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db" > /dev/null 2>&1 || { echo "FAIL $f (could not create $db)"; return 1; }
  DATABASE_URL="$PGBASE/$db" npm run migrate > "$LOG/$name.migrate.log" 2>&1 || { echo "FAIL $f (migrations, see $LOG/$name.migrate.log)"; return 1; }
  local t0=$SECONDS
  if DATABASE_URL="$PGBASE/$db" node --test --test-reporter=tap "$f" > "$LOG/$name.log" 2>&1; then
    echo "ok   $f ($((SECONDS - t0))s)"
    psql "$PGBASE/postgres" -qc "DROP DATABASE IF EXISTS $db" > /dev/null 2>&1
  else
    echo "FAIL $f ($((SECONDS - t0))s, database $db kept, log $LOG/$name.log)"
    grep -E "^not ok|^# (pass|fail)" "$LOG/$name.log" | head -5 | sed 's/^/       /'
    return 1
  fi
}
export -f run_one

files="$(cat "$@" | sed '/^[[:space:]]*#/d;/^[[:space:]]*$/d')"
[ -n "$files" ] || { echo "no test files listed"; exit 1; }
t0=$SECONDS
printf '%s\n' $files | xargs -P "$JOBS" -I{} bash -c 'run_one "$1"' _ {}
rc=$?
echo "isolated tests: $(printf '%s\n' $files | wc -l | tr -d ' ') files, $((SECONDS - t0))s, $([ $rc -eq 0 ] && echo PASS || echo FAIL)"
[ $rc -eq 0 ]
