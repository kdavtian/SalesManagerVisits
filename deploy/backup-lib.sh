#!/usr/bin/env bash
# Shared helpers for the backup / monitoring scripts in deploy/ (backup.sh, backup-restore-test.sh, server-check.sh,
# send-backup-telegram.sh). Sourced, never run. The caller has already done `cd` to the repo checkout (where .env lives).
#
# Two ways to reach the database:
#   default            the Docker Compose `db` service (production: docker compose exec -T db psql/pg_dump)
#   BACKUP_DB_URL=...  a plain postgres:// URL (local test runs, a non-Docker server): psql/pg_dump on this machine

# Value of KEY from the environment, else from ./.env. No `source`: a stray character in .env must not run anything.
env_value() {
  local key="$1" current="${!1:-}"
  if [ -n "$current" ]; then printf '%s' "$current"; return; fi
  [ -f .env ] && grep -E "^${key}=" .env | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" || true
}

PG_USER="$(env_value POSTGRES_USER)"; PG_USER="${PG_USER:-fieldvisits}"
PG_DB="$(env_value POSTGRES_DB)"; PG_DB="${PG_DB:-fieldvisits}"
if [ -n "${BACKUP_DB_URL:-}" ]; then PG_DB="${BACKUP_DB_URL##*/}"; PG_DB="${PG_DB%%\?*}"; fi

# psql against database $1 (the rest are psql arguments); stdin is passed through.
psql_on() {
  local db="$1"; shift
  if [ -n "${BACKUP_DB_URL:-}" ]; then
    psql "${BACKUP_DB_URL%/*}/$db" "$@"
  else
    docker compose exec -T db psql -U "$PG_USER" -d "$db" "$@"
  fi
}

# pg_dump of the app database to stdout (plain SQL, restorable with psql).
dump_db() {
  if [ -n "${BACKUP_DB_URL:-}" ]; then
    pg_dump --no-owner "$BACKUP_DB_URL"
  else
    docker compose exec -T db pg_dump -U "$PG_USER" --no-owner "$PG_DB"
  fi
}

# Telegram: the backup bot / group of send-backup-telegram.sh. TELEGRAM_ALERT_CHAT_ID sends alerts to another chat.
tg_token() {
  local t; t="$(env_value TELEGRAM_BACKUP_BOT_TOKEN)"
  [ -n "$t" ] || t="$(env_value TELEGRAM_BOT_TOKEN)"
  printf '%s' "$t"
}
tg_chat() {
  local c; c="$(env_value TELEGRAM_ALERT_CHAT_ID)"
  [ -n "$c" ] || c="$(env_value TELEGRAM_BACKUP_CHAT_ID)"
  [ -n "$c" ] || c="$(env_value TELEGRAM_NOTIFY_CHAT_IDS | cut -d, -f1 | tr -d ' ')"
  printf '%s' "$c"
}

# Sends a plain-text message. Returns 1 (and says so on stderr) when it could not; never prints the token.
tg_text() {
  local token chat api status
  token="$(tg_token)"; chat="$(tg_chat)"
  if [ -z "$token" ] || [ -z "$chat" ]; then
    echo "ALERT NOT SENT: no Telegram bot/chat in .env (TELEGRAM_BACKUP_BOT_TOKEN + TELEGRAM_BACKUP_CHAT_ID). Message was: $1" >&2
    return 1
  fi
  api="${TELEGRAM_API_BASE:-https://api.telegram.org}"
  status=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' --data-urlencode "chat_id=$chat" --data-urlencode "text=$1" \
    "$api/bot$token/sendMessage" 2>/dev/null || true) # curl itself prints 000 when it cannot connect
  if [ "$status" != "200" ]; then
    echo "ALERT NOT SENT: Telegram answered HTTP $status. Message was: $1" >&2
    return 1
  fi
}

# Host name shown in alerts, so the owner knows which server speaks.
host_label() { hostname 2>/dev/null || echo server; }
