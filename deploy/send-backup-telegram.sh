#!/usr/bin/env bash
# Sends ONE backup file to the owner's Telegram group (second copy, off the server). Called by backup.sh; can also be run
# by hand: ./deploy/send-backup-telegram.sh path/to/db-....sql.gz
#
# Settings are read from the environment, then from the .env next to docker-compose.yml (the same file the app uses):
#   TELEGRAM_BACKUP_BOT_TOKEN the bot that posts (must be a member of the group); a dedicated backup bot is best.
#                             Falls back to TELEGRAM_BOT_TOKEN (the app's notification bot) when not set.
#   TELEGRAM_BACKUP_CHAT_ID   the group to post to; falls back to the FIRST id in TELEGRAM_NOTIFY_CHAT_IDS
#   BACKUP_PASSPHRASE_FILE    file holding the encryption passphrase (default: ./.backup-passphrase). The file is sent
#                             ENCRYPTED (AES-256, openssl) -- a customer + debt database must not sit readable in a chat.
#   BACKUP_TELEGRAM_UNENCRYPTED=1   explicit opt-out: send without encryption (not recommended)
#   TELEGRAM_API_BASE         test hook (default https://api.telegram.org)
# Telegram bots can upload at most 50 MB; bigger files are skipped with a warning (never silently).
# Exit codes: 0 sent, 0 also when Telegram is simply not configured (it prints why), 1 on a real failure.
set -euo pipefail
cd "$(dirname "$0")/.."

FILE="${1:-}"
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "usage: $0 <backup-file>" >&2; exit 1; }

env_value() {
  # value of KEY from the environment, else from ./.env (no `source`: a stray character in .env must not run anything)
  local key="$1" current="${!1:-}"
  if [ -n "$current" ]; then printf '%s' "$current"; return; fi
  [ -f .env ] && grep -E "^${key}=" .env | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" || true
}

TOKEN="$(env_value TELEGRAM_BACKUP_BOT_TOKEN)"
if [ -z "$TOKEN" ]; then TOKEN="$(env_value TELEGRAM_BOT_TOKEN)"; fi
CHAT="$(env_value TELEGRAM_BACKUP_CHAT_ID)"
if [ -z "$CHAT" ]; then CHAT="$(env_value TELEGRAM_NOTIFY_CHAT_IDS | cut -d, -f1 | tr -d ' ')"; fi
if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
  echo "Telegram copy skipped: TELEGRAM_BACKUP_BOT_TOKEN and TELEGRAM_BACKUP_CHAT_ID are not set in .env." >&2
  exit 0
fi

SEND="$FILE"
CLEANUP=""
PASS_FILE="${BACKUP_PASSPHRASE_FILE:-./.backup-passphrase}"
if [ -s "$PASS_FILE" ]; then
  SEND="$FILE.enc"
  openssl enc -aes-256-cbc -pbkdf2 -salt -in "$FILE" -out "$SEND" -pass "file:$PASS_FILE"
  CLEANUP="$SEND"
elif [ "${BACKUP_TELEGRAM_UNENCRYPTED:-0}" != "1" ]; then
  echo "Telegram copy NOT sent: no encryption passphrase at $PASS_FILE (create it, or set BACKUP_TELEGRAM_UNENCRYPTED=1)." >&2
  exit 1
fi

SIZE=$(wc -c < "$SEND")
if [ "$SIZE" -gt 49000000 ]; then
  echo "Telegram copy NOT sent: $(basename "$SEND") is $((SIZE / 1048576)) MB and Telegram bots accept at most 50 MB." >&2
  if [ -n "$CLEANUP" ]; then rm -f "$CLEANUP"; fi
  exit 1
fi

API="${TELEGRAM_API_BASE:-https://api.telegram.org}"
NOTE=""
if [ -n "$CLEANUP" ]; then NOTE=", encrypted"; fi
CAPTION="Field Visits backup $(date +%Y-%m-%d) - $(basename "$FILE") ($((SIZE / 1024)) KB$NOTE)"
# The URL contains the bot token: never print it (curl -sS without -v, status code only).
STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -F "chat_id=$CHAT" -F "caption=$CAPTION" -F "document=@$SEND" "$API/bot$TOKEN/sendDocument" || echo "000")
if [ -n "$CLEANUP" ]; then rm -f "$CLEANUP"; fi
if [ "$STATUS" != "200" ]; then
  echo "Telegram copy FAILED (HTTP $STATUS). Check that the bot is a member of the group and the ids are right." >&2
  exit 1
fi
echo "Telegram copy sent ($((SIZE / 1024)) KB)."
