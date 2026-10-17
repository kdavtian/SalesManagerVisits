# Backup and restore

**Honest status**: `deploy/backup.sh` (below) automates *taking* a backup —
one command instead of two remembered-by-hand ones — but installing it on
a schedule (cron) is still a one-time manual step on the real droplet, and
so is pointing it at a genuine off-server destination (`BACKUP_REMOTE`);
neither has happened on production yet. The restore procedure has been
rehearsed against a real Postgres database (see
[Doing a practice restore](#doing-a-practice-restore) below) but **not
against the actual Docker Compose deployment shape** — the uploads-volume
tar step and an off-server transfer are still unverified in this
environment. See risk **R-02** in
[`governance/risk-and-technical-debt-register.md`](governance/risk-and-technical-debt-register.md)
and the RPO/RTO gap noted in
[`governance/service-objectives-and-security.md`](governance/service-objectives-and-security.md).

There are two things to back up on the production droplet, independently:
the Postgres database, and the `uploads_data` volume (check-in photos,
POD signatures).

## Backup

**Automated (recommended):** from `/opt/field-visits` on the droplet, with
the stack running:

```bash
./deploy/backup.sh
```

Writes a timestamped `db-*.sql.gz` (compressed) and `uploads-*.tar.gz` into `./backups/`
(override with `BACKUP_DIR`), prunes anything older than 35 days (five weekly backups)
(`BACKUP_RETENTION_DAYS`), and — only if you set `BACKUP_REMOTE` to an
rsync/scp destination (e.g. `BACKUP_REMOTE=user@backup-host:/backups/field-visits/`)
— pushes both files there right after. Without `BACKUP_REMOTE` set, it
still runs and prints a loud warning: the result is local-only, on the
same disk as what it's backing up, which doesn't survive a droplet-level
failure.

To actually run this on a schedule (the "automated" part), add it to the
droplet's crontab once:

```bash
crontab -e
# then add:
0 3 * * 0 cd /opt/field-visits && ./deploy/backup.sh >> /var/log/field-visits-backup.log 2>&1   # every Sunday at 03:00
```

**Second copy in the owner's Telegram group (automatic, database only):** after the dump, `backup.sh` calls
`deploy/send-backup-telegram.sh`, which posts the database file to the group, **encrypted** (AES-256) with a passphrase kept
only on the droplet and in the owner's password manager. One-time setup on the droplet, from `/opt/field-visits`:

```bash
# 1. the passphrase (never paste it into chat; copy it into your password manager from this screen)
head -c 32 /dev/urandom | base64 > .backup-passphrase && chmod 600 .backup-passphrase && cat .backup-passphrase
# 2. .env must contain TELEGRAM_BOT_TOKEN and the group id (TELEGRAM_BACKUP_CHAT_ID, or the first id of
#    TELEGRAM_NOTIFY_CHAT_IDS); the bot must be a member of the group. Check without printing secrets:
grep -E '^TELEGRAM_(BOT_TOKEN|BACKUP_CHAT_ID|NOTIFY_CHAT_IDS)=.+' .env | sed 's/=.*/=(set)/'
```

Without the passphrase file nothing is sent (an unencrypted customer/debt database must not sit in a chat); to send
unencrypted anyway set `BACKUP_TELEGRAM_UNENCRYPTED=1` (not recommended). Telegram bots accept files up to 50 MB; the photos
backup (about 60 MB and growing) stays on the droplet only. **If the passphrase is lost the Telegram copies are unreadable** --
keep it somewhere other than the droplet. To read a Telegram copy on your PC:

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
  alpine sh -c "cd /data && tar xzf /backup/uploads-backup-YYYYMMDD.tar.gz"
```

**Bring the app back up and verify:**

```bash
docker compose up -d app
docker compose exec -T app npm run verify:deployment
```

Then manually check: can you log in, does a known customer/order look
right, do check-in photos load.

## What's not covered here

- **Point-in-time recovery.** `pg_dump` is a snapshot at the moment it
  ran — anything written after the last backup and before an incident is
  gone. There's no WAL-archiving/continuous-backup setup.
- **A cron job actually installed on production.** `deploy/backup.sh`
  exists and works; nobody has added the crontab line above to the real
  droplet yet. Until that happens, treat "when did anyone last actually
  run this" as an open question worth checking periodically.
- **A genuine off-server copy.** Same gap — `BACKUP_REMOTE` needs a real
  destination (another host, object storage) configured once; without it,
  every backup produced today is local-only.
- **The Docker-Compose-shaped restore, end to end.** See below — what's
  actually been rehearsed is the database dump/restore mechanism itself,
  not the uploads-volume tar step, not a restore through Compose, and not
  an off-server transfer.

## Doing a practice restore

**Done, partially** — the database half of this, rehearsed directly
against Postgres (not through Docker, since that requires the real
droplet's Compose stack):

1. `pg_dump`'d the working database (89 users, 3,320 notifications, plus
   the rest of the schema) — took **~1s**.
2. Restored it into a freshly created, empty scratch database with
   `psql -f` — took **~0.5s**, zero errors.
3. Verified row counts in two tables matched the source exactly (89 users,
   3,320 notifications) before dropping the scratch database.

This confirms the dump/restore *mechanism* is sound and the documented
command is correct. It does **not** confirm timing at production scale
(this test database is far smaller than a real multi-year dataset would
be), and it does **not** exercise the uploads-volume tar/untar step, a
restore through `docker compose`, or pushing/pulling a backup off-server
— none of which can be driven from this environment (no Docker daemon
available here). The responsible next step, still not done: run the full
`backup.sh` → transfer → restore sequence against the actual droplet (or
a second scratch droplet), confirm the app itself works against the
restored data end to end, and record that timing here too.
