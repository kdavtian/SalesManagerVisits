#!/usr/bin/env bash
# One command for everything CI runs, on this machine:  bash scripts/local-ci.sh [--quick] [--e2e] [--no-audit]
# Starts Postgres if it is down, gives every job its own fresh test database (like CI), runs the static checks, the test shards in
# parallel and the isolated tests, and ends with ONE summary line. Full logs: /tmp/local-ci/*.log (override with LOCAL_CI_LOG).
#   --quick     static checks only (version, ui, lint, audit): about 30 s
#   --e2e       also the browser smoke tests (Chrome) and the iPhone tests (Safari's engine, WebKit, installed on first use)
#   --no-audit  skip `npm audit` (no network)
# Env: SHARDS (default 4), PGBASE (default: tries postgres://gmm:gmm@127.0.0.1:5432 then postgres://postgres:postgres@localhost:5432).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../server"
LOG="${LOCAL_CI_LOG:-/tmp/local-ci}"; mkdir -p "$LOG"; rm -f "$LOG"/*.log "$LOG"/*.status
SHARDS="${SHARDS:-4}"; QUICK=0; E2E=0; AUDIT=1
for a in "$@"; do case "$a" in --quick) QUICK=1 ;; --e2e) E2E=1 ;; --no-audit) AUDIT=0 ;; *) echo "unknown option $a"; exit 2 ;; esac; done
START=$SECONDS
export JWT_SECRET="${JWT_SECRET:-ci-test-secret-not-used-anywhere-real}" NODE_ENV=test

# ---- Postgres up, and an admin connection that works ----
if ! pg_isready -q 2>/dev/null; then
  ver="$(pg_lsclusters -h 2>/dev/null | awk 'NR==1{print $1}')"
  [ -n "$ver" ] && pg_ctlcluster "$ver" main start 2>/dev/null
  for _ in $(seq 1 20); do pg_isready -q 2>/dev/null && break; sleep 1; done
fi
PGBASE="${PGBASE:-}"
if [ -z "$PGBASE" ]; then
  for c in "postgres://gmm:gmm@127.0.0.1:5432" "postgres://postgres:postgres@localhost:5432"; do
    psql "$c/postgres" -tAc 'select 1' >/dev/null 2>&1 && { PGBASE="$c"; break; }
  done
fi
export PGBASE
if [ "$QUICK" = 0 ] && [ -z "$PGBASE" ]; then echo "LOCAL CI: FAIL - no working Postgres connection (set PGBASE=postgres://user:pass@host:5432)"; exit 1; fi
fresh_db() { psql "$PGBASE/postgres" -qc "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1 && DATABASE_URL="$PGBASE/$1" npm run migrate >/dev/null 2>&1; }
tests() { find test -name '*.test.js' | sort | grep -vxF "$(cat test/isolated-*.txt)"; }
count() { grep -E "^# $1 " "$2" 2>/dev/null | tail -1 | awk '{print $3}'; }

# run <name> <command...>  -> writes $LOG/<name>.log and $LOG/<name>.status ("ok"|"FAIL <detail>")
run() {
  local name="$1"; shift; local t0=$SECONDS
  local rc=0; "$@" > "$LOG/$name.log" 2>&1 || rc=$?
  if [ "$rc" = 0 ]; then echo "ok $((SECONDS - t0))s" > "$LOG/$name.status"
  elif [ "$rc" = 77 ]; then echo "SKIP: WebKit could not be installed on this machine (CI still runs it)" > "$LOG/$name.status"
  else echo "FAIL $((SECONDS - t0))s" > "$LOG/$name.status"; fi
}
static() { npm run check:version && npm run verify:ui && npm run lint && { [ "$AUDIT" = 0 ] || npm audit --audit-level=high; }; }
shard()  { fresh_db "fieldvisits_ci_$1" && DATABASE_URL="$PGBASE/fieldvisits_ci_$1" node --test --test-reporter=tap --test-shard="$1/$SHARDS" $(tests); }
isolated() { bash scripts/run-isolated.sh test/isolated-tests.txt; }
e2e()    { fresh_db fieldvisits_ci_e2e && DATABASE_URL="$PGBASE/fieldvisits_ci_e2e" npm run test:e2e:smoke; }
# The @iphone tests in Safari's engine (project iphone-webkit), on their own database and port next to the Chrome run. WebKit and its system
# libraries are installed once into WEBKIT_DIR (the install is a no-op when that revision is already there); exit 77 = not installable here.
WEBKIT_DIR="${WEBKIT_DIR:-$HOME/.cache/ms-playwright-webkit}"
iphone() {
  PLAYWRIGHT_BROWSERS_PATH="$WEBKIT_DIR" npx playwright install webkit || return 77
  if [ ! -f "$WEBKIT_DIR/.deps-ok" ]; then npx playwright install-deps webkit && touch "$WEBKIT_DIR/.deps-ok" || return 77; fi
  fresh_db fieldvisits_ci_iphone && DATABASE_URL="$PGBASE/fieldvisits_ci_iphone" E2E_PORT=3201 PLAYWRIGHT_BROWSERS_PATH="$WEBKIT_DIR" npm run test:e2e:iphone
}

jobs=(static); run static static &
if [ "$QUICK" = 0 ]; then
  for i in $(seq 1 "$SHARDS"); do jobs+=("shard$i"); run "shard$i" shard "$i" & done
  jobs+=(isolated); run isolated isolated &
  [ "$E2E" = 1 ] && { jobs+=(e2e iphone); run e2e e2e & run iphone iphone & }
fi
wait

fail=()
for j in "${jobs[@]}"; do
  st="$(cat "$LOG/$j.status" 2>/dev/null || echo 'FAIL missing')"
  n=""; [ -f "$LOG/$j.log" ] && n=" ($(count pass "$LOG/$j.log") passed, $(count fail "$LOG/$j.log") failed)"; case "$j" in shard*) ;; isolated) n=" ($(tail -1 "$LOG/$j.log"))" ;; *) n="" ;; esac
  echo "  $j: $st$n"
  case "$st" in FAIL*) fail+=("$j"); grep -E "^not ok|✖|Error:" "$LOG/$j.log" | head -5 | sed 's/^/      /' ;; esac
done
if [ ${#fail[@]} -eq 0 ]; then echo "LOCAL CI: PASS in $((SECONDS - START))s (logs: $LOG)"; else echo "LOCAL CI: FAIL in $((SECONDS - START))s - ${fail[*]} (logs: $LOG)"; exit 1; fi
