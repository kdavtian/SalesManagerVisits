# Backup and restore

**Status (2026-11-28)**: the scripts are ready and tested (dry runs against a real Postgres, a local folder standing in for
the bucket, and a fake Telegram; `server/test/integration/backupScripts.test.js` repeats that on every CI run). They protect
production only after the one-time [Owner steps](#owner-steps-one-time-on-the-droplet) below: a Spaces bucket + key in
`.env`, rclone, and three crontab lines. Until then the old situation stands (no schedule, no off-server copy of photos).
Risk **R-02** in [`governance/risk-and-technical-debt-register.md`](governance/risk-and-technical-debt-register.md).

What is protected, and where:

| What | Where | Kept |
|---|---|---|
| Database (`db-*.sql.gz`) + uploads: visit photos, delivery signatures (`uploads-*.tar.gz`) | droplet, `./backups/` | 7 days (`BACKUP_LOCAL_DAYS`) |
| the same two files, every night | DigitalOcean Spaces bucket, `<prefix>/daily/` | 14 days (`BACKUP_DAILY_KEEP_DAYS`) |
| Sunday's two files | Spaces, `<prefix>/weekly/` | 8 weeks (`BACKUP_WEEKLY_KEEP_DAYS=56`) |
| Database only, encrypted, while under 50 MB | owner's Telegram backup group | Telegram history |
| Database just before a deploy applies new migrations (`pre-deploy-*.sql.gz`) | droplet, `./backups/` | newest 5, at most 14 days |

The database also stores the order and report PDFs (migrations 063, 095), so the dump grows faster than the row counts
suggest; the Spaces copy has no size limit, the Telegram copy stops at 50 MB (then set `BACKUP_TELEGRAM_COPY=0`).

## Owner steps (one time, on the droplet)

**1. Spaces bucket + key** (DigitalOcean website, 5 minutes, about $5 a month for 250 GB):
- *Spaces Object Storage* -> *Create Bucket*: same region as the droplet (e.g. Frankfurt `fra1`), name e.g.
  `kad-fieldvisits-backups`, **File listing: Restricted** (private). No CDN.
- *API* -> *Spaces Keys* -> *Generate New Key*: name `field-visits-backup`; if offered, give it access to **this bucket only**,
  read/write/delete. Copy the Access Key and the Secret (the secret is shown once) into your password manager.

**2. Program + settings** (SSH to the droplet as root):

```bash
apt-get update && apt-get install -y rclone 7zip
cd /opt/field-visits
nano .env
```

Add these four lines at the end of `.env` (your bucket, region and key), save with Ctrl+O, Enter, Ctrl+X:

```
BACKUP_S3_BUCKET=kad-fieldvisits-backups
BACKUP_S3_ENDPOINT=fra1.digitaloceanspaces.com
BACKUP_S3_ACCESS_KEY=paste-the-access-key-here
BACKUP_S3_SECRET_KEY=paste-the-secret-here
```

Alerts go to the Telegram backup group (`TELEGRAM_BACKUP_BOT_TOKEN` + `TELEGRAM_BACKUP_CHAT_ID`, already used for the
database copy; see "Second copy in the owner's Telegram group" below). To send alerts to another chat, add
`TELEGRAM_ALERT_CHAT_ID=<chat id>`. Check what is set, without printing secrets:

```bash
grep -E '^(BACKUP_S3_[A-Z_]+|TELEGRAM_(BACKUP_BOT_TOKEN|BOT_TOKEN|BACKUP_CHAT_ID|ALERT_CHAT_ID|NOTIFY_CHAT_IDS))=.+' .env | sed 's/=.*/=(set)/'
```

**3. One run by hand, then the restore drill** (both must end with `Done.` / `RESTORE DRILL OK.`):

```bash
cd /opt/field-visits && ./deploy/backup.sh && ./deploy/backup-restore-test.sh --from-remote
```

Settings > System health > *Backups* now shows *Last good backup: ... · DigitalOcean Spaces, Telegram* in green, and the
Telegram group gets "✅ restore drill OK" with the row counts.

**4. The schedule** (`crontab -e` as root; DigitalOcean servers run on UTC, check with `date`; 23:30 UTC = 03:30 Yerevan).
If an older `0 3 * * 0 ... backup.sh` line is there, delete it.

```
30 23 * * * cd /opt/field-visits && ./deploy/backup.sh >> /var/log/field-visits-backup.log 2>&1
15 1 2 * * cd /opt/field-visits && ./deploy/backup-restore-test.sh --from-remote >> /var/log/field-visits-backup.log 2>&1
*/15 * * * * cd /opt/field-visits && ./deploy/server-check.sh >> /var/log/field-visits-check.log 2>&1
```

Line 1: nightly backup. Line 2: the restore drill on the 2nd of every month (restores the newest off-server backup into
a scratch database, compares row counts, reads the photos archive, reports to Telegram; the real database is not touched).
Line 3: the server self-check (disk, app, backup age) from [`monitoring.md`](monitoring.md).

**5. The outside checks** (uptime monitor, DigitalOcean disk/memory/CPU alerts): [`monitoring.md`](monitoring.md#owner-steps-outside-checks).

## Backup

**Nightly, automatic** -- `deploy/backup.sh` (run by cron, or by hand from `/opt/field-visits`):

1. `pg_dump` -> `backups/db-<time>.sql.gz` and a tar of the `field-visits_uploads_data` volume -> `backups/uploads-<time>.tar.gz`.
   Both are written as `*.partial` and renamed only after a check (the dump must end with pg_dump's completion line, the
   archive must read to the end), so a failed run never leaves a file that looks like a backup.
2. Copies both to the Spaces bucket with `rclone` (`daily/`, plus `weekly/` on Sundays), checks the sizes arrived, deletes
   off-server copies older than the retention above.
3. Sends the database to the Telegram group as before (encrypted; `BACKUP_TELEGRAM_COPY=0` turns it off).
4. Deletes local copies older than 7 days.
5. Writes one `backup_runs` row; Settings > System health > *Backups* shows the last good one, **red after 36 hours**.

**Never silent**: any failed step sends "🔴 Field Visits BACKUP FAILED ... at step <step>" to the Telegram group, writes a
failed `backup_runs` row (shown under *Last failure* in System health) and ends with a non-zero exit code. A run with no
off-server copy at all (no bucket set and no Telegram copy) is a failure too, unless `BACKUP_REQUIRE_OFFSITE=0`. If cron
itself stops, `server-check.sh` alerts when there has been no good backup for 36 hours.

**Before a deploy's migrations** -- `deploy/deploy.sh` compares the migration files with what the database has applied;
when something is pending it first saves `backups/pre-deploy-<time>.sql.gz`, and **stops the deploy** (old app keeps
running, nothing changed) if that dump fails. `./deploy/deploy.sh --skip-backup` skips it (not recommended).

Settings, all optional except the bucket ones: `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY`,
`BACKUP_S3_SECRET_KEY`, `BACKUP_S3_PREFIX` (default `field-visits`), `BACKUP_DIR`, `BACKUP_LOCAL_DAYS`, `BACKUP_DAILY_KEEP_DAYS`,
`BACKUP_WEEKLY_KEEP_DAYS`, `BACKUP_UPLOADS_VOLUME`, `BACKUP_TELEGRAM_COPY`, `BACKUP_REQUIRE_OFFSITE`, `TELEGRAM_ALERT_CHAT_ID`.
The older `BACKUP_REMOTE` (an scp destination) still works alongside.

**Security note**: the Spaces copies are not encrypted by the script; they are protected by the bucket being private and
the key living only in `.env` on the droplet and in your password manager. The Telegram copy stays encrypted.

**Getting a file from Spaces to your computer**: DigitalOcean website -> Spaces -> the bucket -> `field-visits/daily/` ->
the file -> Download. On the droplet: `rclone copy` needs the same settings, so use the drill script or this one-liner:

```bash
cd /opt/field-visits && set -a && . ./.env && set +a && RCLONE_CONFIG_S_TYPE=s3 RCLONE_CONFIG_S_PROVIDER=DigitalOcean \
  RCLONE_CONFIG_S_ENDPOINT=$BACKUP_S3_ENDPOINT RCLONE_CONFIG_S_ACCESS_KEY_ID=$BACKUP_S3_ACCESS_KEY \
  RCLONE_CONFIG_S_SECRET_ACCESS_KEY=$BACKUP_S3_SECRET_KEY rclone lsl s:$BACKUP_S3_BUCKET/field-visits/daily/
```

(`lsl` lists; `rclone copy s:$BACKUP_S3_BUCKET/field-visits/daily/<file> ./` downloads.)

**Second copy in the owner's Telegram group (automatic, database only):** after the dump, `backup.sh` calls
`deploy/send-backup-telegram.sh`, which posts the database file to the group as a **password-protected `.7z` archive**
(AES-256, file names hidden). The password is the passphrase kept only on the droplet and in the owner's password manager.
One-time setup on the droplet, from `/opt/field-visits` (the `7zip` package gives the server the `7z` program):

```bash
apt-get install -y 7zip
```

```bash
# 1. the passphrase (never paste it into chat; copy it into your password manager from this screen)
head -c 32 /dev/urandom | base64 > .backup-passphrase && chmod 600 .backup-passphrase && cat .backup-passphrase
# 2. .env must contain TELEGRAM_BACKUP_BOT_TOKEN (a dedicated bot from @BotFather; falls back to TELEGRAM_BOT_TOKEN) and the
#    group id TELEGRAM_BACKUP_CHAT_ID (falls back to the first id of TELEGRAM_NOTIFY_CHAT_IDS); the bot must be a member
#    of the group. Check without printing secrets:
grep -E '^TELEGRAM_(BACKUP_BOT_TOKEN|BOT_TOKEN|BACKUP_CHAT_ID|NOTIFY_CHAT_IDS)=.+' .env | sed 's/=.*/=(set)/'
```

Without the passphrase file nothing is sent (an unencrypted customer/debt database must not sit in a chat); to send
unencrypted anyway set `BACKUP_TELEGRAM_UNENCRYPTED=1` (not recommended). Telegram bots accept files up to 50 MB; the photos
backup (about 60 MB and growing) goes to the Spaces bucket instead (see above). **If the passphrase is lost the Telegram copies are unreadable** --
keep it somewhere other than the droplet. To read a Telegram copy on your PC: download the `.7z`, open it with **7-Zip** (Windows, free) or **Keka** (Mac, free) and type the
passphrase; inside is `db-….sql.gz` (gunzip it, restore as below). If the server had no `7z` program the copy arrives as a raw
`.enc` file instead (needs a command):

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -in db-YYYYMMDD-HHMMSS.sql.gz.enc -out db.sql.gz   # asks for the passphrase
gunzip db.sql.gz                                                                         # -> db.sql, restore as below
```

**Manual (what the script above does, if you need to run one step by hand):**

```bash
docker compose exec db pg_dump -U fieldvisits fieldvisits > backup-$(date +%Y%m%d).sql
docker run --rm \
  -v field-visits_uploads_data:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/uploads-backup-$(date +%Y%m%d).tar.gz -C /data .
```

## Restore

**Stop the app first** so nothing writes to the database mid-restore:

```bash
docker compose stop app
```

**Restore the database** (this assumes an empty/fresh `db` — restoring
into a database with existing conflicting data needs `--clean` or a drop-
and-recreate first, which is destructive; think carefully before doing
that against a live system):

```bash
docker compose exec -T db psql -U fieldvisits fieldvisits < backup-YYYYMMDD.sql   # an automated backup is db-*.sql.gz: gunzip -c db-*.sql.gz | docker compose exec -T db psql -U fieldvisits fieldvisits
```

**Restore the uploads volume:**

```bash
docker run --rm \
  -v field-visits_uploads_data:/data \
  -v $(pwd):/backup \
  alpine sh -c "cd /data && tar xzf /backup/uploads-YYYYMMDD-HHMMSS.tar.gz"   # the automated name; a manual one is uploads-backup-YYYYMMDD.tar.gz
```

**Bring the app back up and verify:**

```bash
docker compose up -d app
docker compose exec -T app npm run verify:deployment
```

Then manually check: can you log in, does a known customer/order look
right, do check-in photos load.

## Restore drill (monthly)

`deploy/backup-restore-test.sh` proves a backup can really be restored, without touching the live database:

```bash
./deploy/backup-restore-test.sh                # newest local backup
./deploy/backup-restore-test.sh --from-remote  # newest backup in Spaces (also proves the off-server copy)
```

It takes the newest **complete** backup -- the database dump and the photos archive of the same night (same time
stamp); a night whose photos step failed is skipped, never paired with another night's photos, and no complete pair at
all is a failure. It first checks there is room (about three times the plain dump) on the database's disk, then restores into a scratch
database `fieldvisits_restore_drill` next to the real one, compares row counts of `users`,
`customers`, `products`, `orders`, `order_items`, `checkins`, `payments` and `schema_migrations` with the live database
(each must be present, and not empty when the live one has rows), reads the photos archive to the end and counts its files,
drops the scratch database, and posts the result (OK or FAILED, with the counts and the time it took) to the Telegram group.
Cron runs it on the 2nd of every month (Owner steps, line 2). If it fails, treat it as urgent: the backups may not be
restorable.

## What's not covered here

- **Point-in-time recovery.** `pg_dump` is a snapshot -- anything written after the last nightly backup and before an
  incident is gone (at most about a day). No WAL archiving.
- **A full disaster rehearsal** on a second droplet (restore DB + uploads through Docker Compose, start the app, log in). The
  monthly drill covers the database and the archive's readability, not a whole new server. Worth doing once a year.

## Photos arranged by customer (for browsing on a computer)

Files in `uploads/` have random names, so a plain copy of the folder tells you nothing about who a photo belongs to. To get
one folder per customer (visit photos and delivery signatures, readable file names), run on the droplet from `/opt/field-visits`:

```
docker compose exec -T app node scripts/export-photos-by-customer.mjs /tmp/photos-by-customer
docker compose cp app:/tmp/photos-by-customer ./photos-by-customer
docker compose exec -T app rm -rf /tmp/photos-by-customer
```

Result: `photos-by-customer/<Customer name> [ERP id]/2026-10-17 14.45 visit - <rep> - 1.jpg` and
`.../2026-10-17 delivery signature - order <code>.png`, plus `_report.txt` (counts and any file the database lists but that is
missing on disk). The script only copies; nothing in `uploads/` or the database is changed. Download to a Mac with
`rsync -avz root@<droplet>:/opt/field-visits/photos-by-customer/ ~/Documents/KAD-photos/` and delete the server copy afterwards
(`rm -rf /opt/field-visits/photos-by-customer`), since it duplicates the uploads volume.
