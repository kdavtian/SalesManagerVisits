# Backup and restore

**Honest status**: backups are a manual command someone has to remember to
run, not an automated job, and the restore procedure below has **not been
rehearsed against production** — see risk **R-02** in
[`governance/risk-and-technical-debt-register.md`](governance/risk-and-technical-debt-register.md)
and the RPO/RTO gap noted in
[`governance/service-objectives-and-security.md`](governance/service-objectives-and-security.md).
This doc describes the correct commands for the current setup, not a
tested-and-proven runbook. Do a practice restore onto a scratch instance
before you need to trust this during a real incident.

There are two things to back up on the production droplet, independently:
the Postgres database, and the `uploads_data` volume (check-in photos,
POD signatures).

## Backup

Run from `/opt/field-visits` (or wherever the repo is checked out) on the
droplet, with the stack running.

**Database:**
```bash
docker compose exec db pg_dump -U fieldvisits fieldvisits > backup-$(date +%Y%m%d).sql
```

**Uploads volume:**
```bash
docker run --rm \
  -v field-visits_uploads_data:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/uploads-backup-$(date +%Y%m%d).tar.gz -C /data .
```

Copy both off the droplet (`scp`, an object-storage bucket, wherever) —
a backup that only lives on the same disk as the thing it's backing up
doesn't survive a droplet-level failure.

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
docker compose exec -T db psql -U fieldvisits fieldvisits < backup-YYYYMMDD.sql
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
- **Automated scheduling.** Nothing runs these commands on a timer today.
  Until that's automated (R-02), treat "when did anyone last actually run
  this" as an open question worth checking periodically.
- **A tested restore time.** The RTO target in
  [`governance/service-objectives-and-security.md`](governance/service-objectives-and-security.md)
  is explicitly marked untested — don't assume the restore above is fast
  or trouble-free under real pressure until someone has actually timed it
  once.

## Doing a practice restore

The responsible next step, not yet done: spin up a scratch Postgres +
uploads volume (a second droplet, or even a local Docker Compose stack),
run the restore steps above against a real recent backup, verify the app
actually works against the restored data, and record how long it took.
That result belongs in this doc once it exists.
