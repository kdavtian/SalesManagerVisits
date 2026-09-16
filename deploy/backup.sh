#!/usr/bin/env bash
# Automated database + uploads backup — run this ON THE DROPLET from inside
# the repo checkout (e.g. /opt/field-visits), same as deploy.sh. Produces
# the same two artifacts docs/backup-restore.md documents as manual
# commands (pg_dump + a tar of the uploads_data volume), timestamped, into
# BACKUP_DIR, then prunes anything older than BACKUP_RETENTION_DAYS.
#
# This alone only gets you LOCAL backups -- still living on the same disk
# as the thing they back up, so a droplet-level failure takes both out
# together. For a real off-server copy, set BACKUP_REMOTE (an rsync/scp
# destination, e.g. "user@backup-host:/backups/field-visits/") and this
# script pushes each new backup there right after creating it. Without
# BACKUP_REMOTE set, it still runs and warns loudly that the result is
# local-only -- better than nothing, but don't mistake it for done.
#
# One-time setup on the droplet (not done by this script):
#   crontab -e
#   0 3 * * * cd /opt/field-visits && ./deploy/backup.sh >> /var/log/field-visits-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p "${BACKUP_DIR:-./backups}"
BACKUP_DIR="$(cd "${BACKUP_DIR:-./backups}" && pwd)"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DB_FILE="$BACKUP_DIR/db-$STAMP.sql"
UPLOADS_FILE="$BACKUP_DIR/uploads-$STAMP.tar.gz"

echo "[$STAMP] Backing up database..."
docker compose exec -T db pg_dump -U fieldvisits fieldvisits > "$DB_FILE"

echo "[$STAMP] Backing up uploads volume..."
docker run --rm \
  -v field-visits_uploads_data:/data \
  -v "$BACKUP_DIR:/backup" \
  alpine tar czf "/backup/$(basename "$UPLOADS_FILE")" -C /data .

echo "[$STAMP] Local backups written: $DB_FILE, $UPLOADS_FILE"

if [ -n "${BACKUP_REMOTE:-}" ]; then
  echo "[$STAMP] Pushing to off-server destination: $BACKUP_REMOTE"
  scp "$DB_FILE" "$UPLOADS_FILE" "$BACKUP_REMOTE"
  echo "[$STAMP] Off-server copy done."
else
  echo "[$STAMP] WARNING: BACKUP_REMOTE is not set -- this backup is LOCAL ONLY," \
       "on the same disk as what it's backing up. Set BACKUP_REMOTE to an" \
       "rsync/scp destination to actually get an off-server copy." >&2
fi

echo "[$STAMP] Pruning local backups older than $BACKUP_RETENTION_DAYS days..."
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db-*.sql' -o -name 'uploads-*.tar.gz' \) -mtime "+$BACKUP_RETENTION_DAYS" -delete

echo "[$STAMP] Done."
