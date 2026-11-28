#!/usr/bin/env bash
# Cheap self-check ON THE DROPLET, every 15 minutes from cron (line in docs/monitoring.md). Sends a Telegram alert when:
#   - a disk is fuller than DISK_ALERT_PERCENT (85) -- the root disk and Docker's data (database + photos live there)
#   - the app does not answer /api/ready on this machine (process down, or it cannot reach the database)
#   - the newest backup in ./backups is older than BACKUP_ALERT_HOURS (36) -- the nightly cron stopped or keeps failing
# The same problem is re-sent at most every ALERT_REPEAT_HOURS (12); a "back to normal" message follows when it clears.
# It cannot notice the whole droplet being off -- that is what the outside uptime monitor is for (docs/monitoring.md).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=deploy/backup-lib.sh
. ./deploy/backup-lib.sh

DISK_LIMIT="$(env_value DISK_ALERT_PERCENT)"; DISK_LIMIT="${DISK_LIMIT:-85}"
BACKUP_HOURS="$(env_value BACKUP_ALERT_HOURS)"; BACKUP_HOURS="${BACKUP_HOURS:-36}"
REPEAT_HOURS="${ALERT_REPEAT_HOURS:-12}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
READY_URL="${READY_URL:-http://127.0.0.1:3000/api/ready}"
DISK_PATHS="${DISK_PATHS:-/ /var/lib/docker}"
STATE_DIR="${CHECK_STATE_DIR:-$BACKUP_DIR}"
mkdir -p "$STATE_DIR"
PROBLEMS=0

# alert <key> <message>: send unless the same key was sent less than REPEAT_HOURS ago.
alert() {
  local mark="$STATE_DIR/.alert-$1"
  PROBLEMS=$((PROBLEMS + 1))
  echo "PROBLEM: $2" >&2
  if [ -f "$mark" ] && [ -z "$(find "$mark" -mmin "+$((REPEAT_HOURS * 60))")" ]; then return 0; fi
  tg_text "🔴 Field Visits server $(host_label): $2" && touch "$mark" || true
}
# clear <key> <message>: the problem is gone -- say so once.
clear_alert() {
  local mark="$STATE_DIR/.alert-$1"
  [ -f "$mark" ] || return 0
  tg_text "✅ Field Visits server $(host_label): $2" && rm -f "$mark" || true
}

# --- disks (each filesystem once) -------------------------------------------------------------------------------------
SEEN=""
for p in $DISK_PATHS; do
  [ -e "$p" ] || continue
  line="$(df -P "$p" | awk 'NR==2 {print $1, $5, $6}')"
  dev="${line%% *}"
  case " $SEEN " in *" $dev "*) continue ;; esac
  SEEN="$SEEN $dev"
  used="$(echo "$line" | awk '{print $2}' | tr -d '%')"
  mount="$(echo "$line" | awk '{print $3}')"
  key="disk$(echo "$mount" | tr '/' '_')"
  if [ "$used" -gt "$DISK_LIMIT" ]; then
    alert "$key" "disk $mount is ${used}% full (limit ${DISK_LIMIT}%). Free space: docker builder prune -f; old files in ./backups."
  else
    clear_alert "$key" "disk $mount back to ${used}%."
  fi
done

# --- the app answers --------------------------------------------------------------------------------------------------
if curl -fsS -m 10 -o /dev/null "$READY_URL" 2> /dev/null; then
  clear_alert app "the app answers again ($READY_URL)."
else
  alert app "the app does not answer $READY_URL (down, or cannot reach the database). Check: docker compose ps; docker compose logs --tail=100 app"
fi

# --- the nightly backup ran -------------------------------------------------------------------------------------------
# backup.sh touches .last-good-backup only after a fully successful run (off-server copy included).
if [ -n "$(find "$BACKUP_DIR/.last-good-backup" -mmin "-$((BACKUP_HOURS * 60))" 2> /dev/null)" ]; then
  clear_alert backup "the nightly backup works again."
else
  alert backup "no good backup in the last ${BACKUP_HOURS} h -- the nightly backup did not run or failed. See /var/log/field-visits-backup.log"
fi

[ "$PROBLEMS" -eq 0 ] && echo "OK: disks below ${DISK_LIMIT}%, app answers, backup fresh."
exit 0
