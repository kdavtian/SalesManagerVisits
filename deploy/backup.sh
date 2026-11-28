#!/usr/bin/env bash
# Nightly backup of the database AND the uploads (visit photos, delivery signatures, documents) -- run ON THE DROPLET from
# the repo checkout (/opt/field-visits), same as deploy.sh. Full guide: docs/backup-restore.md.
#
# Every run:
#   1. pg_dump -> backups/db-<stamp>.sql.gz, tar of the uploads volume -> backups/uploads-<stamp>.tar.gz (local copy)
#   2. off-server copy to S3-compatible object storage (DigitalOcean Spaces) with rclone, when BACKUP_S3_BUCKET is set:
#        <bucket>/<prefix>/daily/   every night, kept BACKUP_DAILY_KEEP_DAYS (14)
#        <bucket>/<prefix>/weekly/  Sunday's run also goes here, kept BACKUP_WEEKLY_KEEP_DAYS (56 = 8 weeks)
#   3. the database (encrypted, up to 50 MB) also to the owner's Telegram group, as before (send-backup-telegram.sh)
#   4. local copies older than BACKUP_LOCAL_DAYS (7) are deleted
#   5. one row in backup_runs -> Settings > System health shows "Last good backup" (red after 36 hours)
# Any failure: a Telegram message to the admin chat, a failed row in backup_runs, exit code 1. Never silent.
#
# Settings (.env next to docker-compose.yml, or the environment):
#   BACKUP_S3_BUCKET, BACKUP_S3_ENDPOINT (e.g. fra1.digitaloceanspaces.com), BACKUP_S3_ACCESS_KEY, BACKUP_S3_SECRET_KEY,
#   BACKUP_S3_PREFIX (default field-visits)          -- the off-server copy (needs the rclone program: apt install rclone)
#   BACKUP_TELEGRAM_COPY=0                            -- no database copy to Telegram
#   BACKUP_REQUIRE_OFFSITE=0                          -- allow a run with no off-server copy at all (default: that is a failure)
#   BACKUP_DIR, BACKUP_LOCAL_DAYS, BACKUP_DAILY_KEEP_DAYS, BACKUP_WEEKLY_KEEP_DAYS, BACKUP_UPLOADS_VOLUME
#   TELEGRAM_BACKUP_BOT_TOKEN / TELEGRAM_BACKUP_CHAT_ID (see send-backup-telegram.sh); TELEGRAM_ALERT_CHAT_ID for alerts
#   Test hooks: BACKUP_DB_URL (plain postgres URL instead of Docker), BACKUP_UPLOADS_DIR (a folder instead of the volume),
#   BACKUP_RCLONE_TARGET (any rclone target, e.g. a local folder, instead of the Spaces bucket)
#
# Crontab (one time, see docs/backup-restore.md):
#   30 23 * * * cd /opt/field-visits && ./deploy/backup.sh >> /var/log/field-visits-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=deploy/backup-lib.sh
. ./deploy/backup-lib.sh
export RCLONE_LOG_LEVEL="${RCLONE_LOG_LEVEL:-ERROR}" # errors only, no "config file not found" chatter

BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
LOCAL_DAYS="$(env_value BACKUP_LOCAL_DAYS)"; LOCAL_DAYS="${LOCAL_DAYS:-7}"
DAILY_KEEP="$(env_value BACKUP_DAILY_KEEP_DAYS)"; DAILY_KEEP="${DAILY_KEEP:-14}"
WEEKLY_KEEP="$(env_value BACKUP_WEEKLY_KEEP_DAYS)"; WEEKLY_KEEP="${WEEKLY_KEEP:-56}"
UPLOADS_VOLUME="$(env_value BACKUP_UPLOADS_VOLUME)"; UPLOADS_VOLUME="${UPLOADS_VOLUME:-field-visits_uploads_data}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DB_FILE="$BACKUP_DIR/db-$STAMP.sql.gz"
UPLOADS_FILE="$BACKUP_DIR/uploads-$STAMP.tar.gz"
log() { echo "[$(date +%H:%M:%S)] $*"; }

# --- result row + alert, whatever happens ------------------------------------------------------------------------------
STEP="start"
OFFSITE=""
WARNINGS=""
DB_BYTES=""
UPLOADS_BYTES=""
record_run() { # ok(true/false) detail
  printf '%s\n' "INSERT INTO backup_runs (ok, db_bytes, uploads_bytes, offsite, detail)
    VALUES (:'ok', NULLIF(:'db', '')::bigint, NULLIF(:'up', '')::bigint, NULLIF(:'off', ''), NULLIF(:'detail', ''));" |
    psql_on "$PG_DB" -q -v ON_ERROR_STOP=1 -v ok="$1" -v db="$DB_BYTES" -v up="$UPLOADS_BYTES" -v off="$OFFSITE" -v detail="$2" > /dev/null
}
on_exit() {
  local rc=$?
  [ "$rc" -eq 0 ] && return
  log "BACKUP FAILED at step: $STEP (exit $rc)" >&2
  rm -f "$DB_FILE.partial" "$UPLOADS_FILE.partial"
  record_run false "$STEP" 2> /dev/null || log "(could not record the failure in the database either)" >&2
  tg_text "🔴 Field Visits BACKUP FAILED on $(host_label) at step \"$STEP\" ($(date '+%Y-%m-%d %H:%M')). Log: /var/log/field-visits-backup.log. Last good backup: Settings > System health." || true
}
trap on_exit EXIT

# Two runs at once (cron + a manual one) would overwrite each other's files.
STEP="lock"
exec 9> "$BACKUP_DIR/.backup.lock"
flock -n 9 || { log "another backup is already running" >&2; exit 1; }

# --- 1. local copy ----------------------------------------------------------------------------------------------------
STEP="database dump"
log "Backing up database..."
# Written as *.partial and renamed only once checked: a failed run never leaves a file that looks like a backup.
dump_db | gzip > "$DB_FILE.partial"
# A real dump is far above 1 KB and ends with pg_dump's completion line.
if [ "$(wc -c < "$DB_FILE.partial")" -lt 1024 ] || ! gunzip -c "$DB_FILE.partial" | tail -n 5 | grep -q "PostgreSQL database dump complete"; then
  log "ERROR: the database dump is empty or cut off." >&2
  exit 1
fi
mv "$DB_FILE.partial" "$DB_FILE"
DB_BYTES="$(wc -c < "$DB_FILE" | tr -d ' ')"

STEP="uploads archive"
log "Backing up uploads..."
if [ -n "${BACKUP_UPLOADS_DIR:-}" ]; then
  tar czf "$UPLOADS_FILE.partial" -C "$BACKUP_UPLOADS_DIR" .
else
  docker volume inspect "$UPLOADS_VOLUME" > /dev/null # a renamed volume must fail here, not archive an empty new one
  docker run --rm -v "$UPLOADS_VOLUME:/data:ro" -v "$BACKUP_DIR:/backup" alpine tar czf "/backup/$(basename "$UPLOADS_FILE").partial" -C /data .
fi
tar tzf "$UPLOADS_FILE.partial" > /dev/null # readable to the end
mv "$UPLOADS_FILE.partial" "$UPLOADS_FILE"
UPLOADS_BYTES="$(wc -c < "$UPLOADS_FILE" | tr -d ' ')"
log "Local copy: $(basename "$DB_FILE") ($((DB_BYTES / 1024)) KB), $(basename "$UPLOADS_FILE") ($((UPLOADS_BYTES / 1048576)) MB)"

# --- 2. off-server copy (object storage) ------------------------------------------------------------------------------
TARGET="${BACKUP_RCLONE_TARGET:-}"
BUCKET="$(env_value BACKUP_S3_BUCKET)"
if [ -z "$TARGET" ] && [ -n "$BUCKET" ]; then
  PREFIX="$(env_value BACKUP_S3_PREFIX)"
  TARGET="fvspaces:$BUCKET/${PREFIX:-field-visits}"
  # rclone reads the remote "fvspaces" from these variables: no rclone.conf to keep in sync with .env.
  export RCLONE_CONFIG_FVSPACES_TYPE=s3 RCLONE_CONFIG_FVSPACES_PROVIDER=DigitalOcean RCLONE_CONFIG_FVSPACES_ACL=private
  RCLONE_CONFIG_FVSPACES_ENDPOINT="$(env_value BACKUP_S3_ENDPOINT)"
  RCLONE_CONFIG_FVSPACES_ACCESS_KEY_ID="$(env_value BACKUP_S3_ACCESS_KEY)"
  RCLONE_CONFIG_FVSPACES_SECRET_ACCESS_KEY="$(env_value BACKUP_S3_SECRET_KEY)"
  export RCLONE_CONFIG_FVSPACES_ENDPOINT RCLONE_CONFIG_FVSPACES_ACCESS_KEY_ID RCLONE_CONFIG_FVSPACES_SECRET_ACCESS_KEY
fi
if [ -n "$TARGET" ]; then
  STEP="off-server copy"
  command -v rclone > /dev/null || { log "ERROR: rclone is not installed (apt install rclone)." >&2; exit 1; }
  log "Off-server copy -> $TARGET/daily/"
  rclone copy --no-traverse --retries 3 "$DB_FILE" "$TARGET/daily/"
  rclone copy --no-traverse --retries 3 "$UPLOADS_FILE" "$TARGET/daily/"
  if [ "$(date +%u)" = "7" ]; then # Sunday: the weekly copy, kept longer
    rclone copy --no-traverse --retries 3 "$DB_FILE" "$TARGET/weekly/"
    rclone copy --no-traverse --retries 3 "$UPLOADS_FILE" "$TARGET/weekly/"
  fi
  # check the night's files really arrived, at the right size
  for f in "$DB_FILE" "$UPLOADS_FILE"; do
    remote_size="$(rclone size --json "$TARGET/daily/$(basename "$f")" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')"
    [ "$remote_size" = "$(wc -c < "$f" | tr -d ' ')" ] || { log "ERROR: $(basename "$f") is missing or incomplete off-server." >&2; exit 1; }
  done
  STEP="off-server cleanup"
  rclone delete --min-age "${DAILY_KEEP}d" "$TARGET/daily/"
  rclone delete --min-age "${WEEKLY_KEEP}d" "$TARGET/weekly/" 2> /dev/null || true # no weekly folder before the first Sunday
  OFFSITE="spaces"
  log "Off-server copy done."
fi

# Old style off-server copy (scp to another host), still honoured if someone set it.
if [ -n "${BACKUP_REMOTE:-}" ]; then
  STEP="scp copy"
  scp "$DB_FILE" "$UPLOADS_FILE" "$BACKUP_REMOTE"
  OFFSITE="${OFFSITE:+$OFFSITE,}scp"
fi

# --- 3. Telegram copy of the database ---------------------------------------------------------------------------------
# BACKUP_TELEGRAM_COPY=0 turns it off (e.g. once the dump outgrows Telegram's 50 MB and Spaces holds the copies).
STEP="telegram copy"
if [ "$(env_value BACKUP_TELEGRAM_COPY)" != "0" ]; then
  TG_OUT="$(./deploy/send-backup-telegram.sh "$DB_FILE" 2>&1)" && TG_RC=0 || TG_RC=$?
  echo "$TG_OUT"
  if [ "$TG_RC" -eq 0 ] && echo "$TG_OUT" | grep -q "Telegram copy sent"; then
    OFFSITE="${OFFSITE:+$OFFSITE,}telegram"
  elif [ "$TG_RC" -ne 0 ]; then
    WARNINGS="Telegram copy failed: $(echo "$TG_OUT" | tail -1)"
  fi
fi

if [ -z "$OFFSITE" ] && [ "$(env_value BACKUP_REQUIRE_OFFSITE)" != "0" ]; then
  STEP="no off-server copy"
  log "ERROR: no off-server copy was made (set BACKUP_S3_BUCKET...; see docs/backup-restore.md). The local copy is kept." >&2
  exit 1
fi

# --- 4. local cleanup -------------------------------------------------------------------------------------------------
STEP="local cleanup"
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db-*.sql' -o -name 'db-*.sql.gz' -o -name 'uploads-*.tar.gz' \) -mtime "+$LOCAL_DAYS" -delete

# --- 5. record success ------------------------------------------------------------------------------------------------
STEP="record result"
record_run true "$WARNINGS"
touch "$BACKUP_DIR/.last-good-backup" # server-check.sh alerts when this gets older than 36 hours
if [ -n "$WARNINGS" ]; then
  tg_text "🟡 Field Visits backup OK on $(host_label) (off-server: ${OFFSITE:-none}), but: $WARNINGS." || true
fi
log "Done. Off-server: ${OFFSITE:-none (local only)}."
