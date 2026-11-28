#!/usr/bin/env bash
# Restore drill: proves the newest backup can really be restored -- run ON THE DROPLET from /opt/field-visits once a month
# (crontab line in docs/backup-restore.md). Touches NOTHING the app uses: it restores into a scratch database
# (fieldvisits_restore_drill) next to the real one, compares row counts of the key tables, reads the photos archive to the
# end, then drops the scratch database. Result (good or bad) goes to the Telegram backup group.
#   ./deploy/backup-restore-test.sh                # newest local backup in ./backups
#   ./deploy/backup-restore-test.sh --from-remote  # newest backup in the Spaces bucket (proves the off-server copy too)
# Same settings as backup.sh (BACKUP_DIR, BACKUP_S3_*, BACKUP_RCLONE_TARGET, BACKUP_DB_URL, ...).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=deploy/backup-lib.sh
. ./deploy/backup-lib.sh
export RCLONE_LOG_LEVEL="${RCLONE_LOG_LEVEL:-ERROR}" # errors only, no "config file not found" chatter

FROM_REMOTE=false
case "${1:-}" in
  --from-remote) FROM_REMOTE=true ;;
  "") ;;
  *) echo "Usage: $0 [--from-remote]" >&2; exit 1 ;;
esac

BACKUP_DIR="${BACKUP_DIR:-./backups}"
SCRATCH="${RESTORE_DRILL_DB:-fieldvisits_restore_drill}"
# The tables whose loss would hurt most; each must come back with rows when the live one has rows.
KEY_TABLES="users customers products orders order_items checkins payments schema_migrations"
WORK="$(mktemp -d)"
STEP="start"
log() { echo "[$(date +%H:%M:%S)] $*"; }

cleanup() {
  local rc=$?
  psql_on "$PG_DB" -q -c "DROP DATABASE IF EXISTS \"$SCRATCH\"" > /dev/null 2>&1 || true
  rm -rf "$WORK"
  if [ "$rc" -ne 0 ]; then
    log "RESTORE DRILL FAILED at step: $STEP" >&2
    tg_text "🔴 Field Visits RESTORE DRILL FAILED on $(host_label) at step \"$STEP\". The backups may not be restorable -- check now." || true
  fi
}
trap cleanup EXIT

# --- pick the backup --------------------------------------------------------------------------------------------------
STEP="find backup"
if [ "$FROM_REMOTE" = true ]; then
  TARGET="${BACKUP_RCLONE_TARGET:-}"
  if [ -z "$TARGET" ]; then
    BUCKET="$(env_value BACKUP_S3_BUCKET)"
    [ -n "$BUCKET" ] || { log "BACKUP_S3_BUCKET is not set" >&2; exit 1; }
    PREFIX="$(env_value BACKUP_S3_PREFIX)"
    TARGET="fvspaces:$BUCKET/${PREFIX:-field-visits}"
    export RCLONE_CONFIG_FVSPACES_TYPE=s3 RCLONE_CONFIG_FVSPACES_PROVIDER=DigitalOcean
    RCLONE_CONFIG_FVSPACES_ENDPOINT="$(env_value BACKUP_S3_ENDPOINT)"
    RCLONE_CONFIG_FVSPACES_ACCESS_KEY_ID="$(env_value BACKUP_S3_ACCESS_KEY)"
    RCLONE_CONFIG_FVSPACES_SECRET_ACCESS_KEY="$(env_value BACKUP_S3_SECRET_KEY)"
    export RCLONE_CONFIG_FVSPACES_ENDPOINT RCLONE_CONFIG_FVSPACES_ACCESS_KEY_ID RCLONE_CONFIG_FVSPACES_SECRET_ACCESS_KEY
  fi
  rclone lsf --files-only "$TARGET/daily/" > "$WORK/remote.list"
  DB_NAME="$(grep '^db-.*\.sql\.gz$' "$WORK/remote.list" | sort | tail -1 || true)"
  UP_NAME="$(grep '^uploads-.*\.tar\.gz$' "$WORK/remote.list" | sort | tail -1 || true)"
  [ -n "$DB_NAME" ] || { log "no db-*.sql.gz in $TARGET/daily/" >&2; exit 1; }
  STEP="download backup"
  rclone copy "$TARGET/daily/$DB_NAME" "$WORK/"
  [ -n "$UP_NAME" ] && rclone copy "$TARGET/daily/$UP_NAME" "$WORK/"
  DB_FILE="$WORK/$DB_NAME"
  UP_FILE="${UP_NAME:+$WORK/$UP_NAME}"
else
  DB_FILE="$(find "$BACKUP_DIR" -maxdepth 1 -name 'db-*.sql.gz' | sort | tail -1)"
  UP_FILE="$(find "$BACKUP_DIR" -maxdepth 1 -name 'uploads-*.tar.gz' | sort | tail -1)"
  [ -n "$DB_FILE" ] || { log "no db-*.sql.gz in $BACKUP_DIR" >&2; exit 1; }
fi
log "Backup: $(basename "$DB_FILE")${UP_FILE:+ + $(basename "$UP_FILE")}"

# --- room for it? The scratch copy lands on the same disk as the live database: never fill that disk. ------------------
STEP="free disk space"
NEED_KB=$(( $(gunzip -c "$DB_FILE" | wc -c) / 1024 * 3 )) # plain SQL x3: tables + indexes + slack
FREE_KB="$(df -Pk "${DRILL_DISK_PATH:-$( [ -d /var/lib/docker ] && echo /var/lib/docker || echo / )}" | awk 'NR==2 {print $4}')"
if [ "$FREE_KB" -lt "$NEED_KB" ]; then
  log "not enough free disk for a scratch copy: need ~$((NEED_KB / 1024)) MB, free $((FREE_KB / 1024)) MB" >&2
  exit 1
fi

# --- restore into the scratch database --------------------------------------------------------------------------------
STEP="restore database"
START=$SECONDS
psql_on "$PG_DB" -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$SCRATCH\"" -c "CREATE DATABASE \"$SCRATCH\"" > /dev/null
gunzip -c "$DB_FILE" | psql_on "$SCRATCH" -q -v ON_ERROR_STOP=1 > /dev/null
log "Restored in $((SECONDS - START)) s"

# --- compare row counts -----------------------------------------------------------------------------------------------
STEP="compare row counts"
count() { psql_on "$1" -tA -c "SELECT count(*) FROM $2" 2> /dev/null | tr -d '[:space:]'; }
REPORT=""
BAD=""
for t in $KEY_TABLES; do
  live="$(count "$PG_DB" "$t")"; restored="$(count "$SCRATCH" "$t")"
  REPORT="$REPORT
  $t: live ${live:-?}, restored ${restored:-MISSING}"
  if [ -z "$restored" ] || { [ "${live:-0}" -gt 0 ] && [ "$restored" -eq 0 ]; }; then BAD="$BAD $t"; fi
done
echo "Row counts (the live numbers can be a little higher: they moved on since the backup):$REPORT"
[ -z "$BAD" ] || { log "missing or empty after restore:$BAD" >&2; STEP="row counts ($BAD )"; exit 1; }

# --- photos archive ---------------------------------------------------------------------------------------------------
FILES="no photos archive"
if [ -n "${UP_FILE:-}" ]; then
  STEP="read photos archive"
  tar tzf "$UP_FILE" > "$WORK/photos.list" # its own command: a cut-off or corrupt archive fails the drill here
  FILES="$(grep -vc '/$' "$WORK/photos.list" || true) files in the photos archive"
fi
log "$FILES"

STEP="report"
AGE_H=$(( ($(date +%s) - $(stat -c %Y "$DB_FILE")) / 3600 )) # rclone keeps the file time, so this works for --from-remote too
log "RESTORE DRILL OK."
tg_text "✅ Field Visits restore drill OK on $(host_label): $(basename "$DB_FILE") restored into a scratch database in $((SECONDS - START)) s, key tables present.$REPORT
$FILES. Backup age: ${AGE_H} h. Source: $([ "$FROM_REMOTE" = true ] && echo off-server || echo local)." || true
