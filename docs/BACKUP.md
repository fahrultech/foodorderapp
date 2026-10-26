# Backups & Restore

FoodOrder's only stateful service is PostgreSQL 16. Everything else (API, web)
is disposable — rebuilding from images/migrations/seed gets you back, but the
database is the one thing you cannot regenerate. This doc covers the backup
tooling in `ops/` and the restore runbook.

## Tools

| File | Purpose |
|---|---|
| `ops/backup-db.sh` | `pg_dump --format=custom` of the whole DB → timestamped `.dump` + `.sha256`, verify-by-listing, rotation |
| `ops/restore-db.sh` | `pg_restore --clean --if-exists --single-transaction` of a dump into an explicit target DB |
| `ops/systemd/foodorder-backup.{service,timer}` | scheduling example (daily 03:15 + jitter) |

Backups land in `ops/backups/` (git-ignored). Both scripts take the connection
string from `$DATABASE_URL`, falling back to the untracked `apps/api/.env`;
credentials are never passed on a command line or stored in the repo.

## Backing up

```bash
ops/backup-db.sh                                  # default: ops/backups, keep 14
BACKUP_DIR=/mnt/nas/fo-backups BACKUP_KEEP=30 ops/backup-db.sh
```

What it does:

1. `pg_dump --format=custom --compress=9 --no-owner --no-privileges` →
   `foodorder-YYYYMMDD-HHMMSS.dump`.
2. **Verifies the archive** with `pg_restore --list`. An archive that cannot be
   listed is deleted and the script exits 3 — we never keep a dump we cannot
   prove is readable.
3. Writes a `sha256` sidecar next to the dump.
4. Rotates: keeps the newest `$BACKUP_KEEP` dumps (+ their sidecars).

Run it manually before every schema migration as well — `migration:revert`
covers most cases, but a dump is the real safety net.

## Scheduling

Preferred (systemd, units are ready-made examples under `ops/systemd/`):

```bash
sudo cp ops/systemd/foodorder-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now foodorder-backup.timer
systemctl list-timers foodorder-backup.timer    # next fire
```

Alternative (cron):

```cron
15 3 * * * cd /home/ubuntu/foodorderapp && ./ops/backup-db.sh >> ops/backups/backup.log 2>&1
```

A backup that nobody verifies is folklore: **test a restore of the latest dump
into a throwaway DB at least monthly** (see Drill below).

## Restoring

`restore-db.sh` refuses to guess a target — you must pass the URI explicitly,
and it wipes/recreates the public-schema objects inside it.

```bash
# 1. (optional but recommended) restore into a NEW throwaway DB to inspect first
sudo -u postgres createdb -O foodorder foodorder_restore
ops/restore-db.sh ops/backups/foodorder-20261026-031500.dump \
  --target-url "postgresql://<user>@localhost:5432/foodorder_restore" --yes

# 2. Verify, then promote: point apps/api/.env DATABASE_URL at the restored DB
```

Safety properties:

- If a `.sha256` sidecar exists it is checked first; a mismatch aborts.
- `--single-transaction`: a failure mid-restore rolls the whole thing back —
  the target keeps its previous content.
- `--clean --if-exists` drops only objects the archive recreates.
- Dumps are `--no-owner --no-privileges`, so restoring under any single role
  works; no ACLs are shipped with the data.

### Manual restore (no script)

```bash
pg_restore --clean --if-exists --no-owner --no-privileges \
  --exit-on-error --dbname="postgresql://<user>@localhost:5432/<db>" \
  ops/backups/foodorder-<stamp>.dump
```

### Compose-hosted Postgres

If you run the stack via `docker compose`, the same scripts work by pointing
`DATABASE_URL` at `localhost:5432` with the compose credentials, or run the
dump inside the container:

```bash
docker compose exec -T postgres pg_dump -U foodorder -Fc foodorder > backup.dump
docker compose exec -T postgres pg_restore -U foodorder --clean --if-exists -d foodorder < backup.dump
```

### Point-in-time beyond the dump

A custom-format dump is a snapshot at one instant. Anything written after the
dump is lost. If stricter recovery is needed later, the next step up is WAL
archiving (`archive_mode=on` + `pg_basebackup`); deliberately out of scope for
the current cadence.

## Drill (verified 2026-10-26, session 33)

Against the local dev cluster (Postgres 16 system service):

1. `ops/backup-db.sh` → `foodorder-20261026-174519.dump` (37 KB, 76 archive
   entries, sha256 sidecar written, `pg_restore --list` passed).
2. Created throwaway `foodorder_restore`; restored the dump with
   `restore-db.sh --yes`; row-by-row `count(*)` comparison across all 11
   tables matched the source exactly (users 2, restaurants 6, menu_items 27,
   orders 12, order_items 19, migrations 9, …), and index (29),
   constraint (140) and enum-type (3) counts were identical.
3. Serve proof: booted `node dist/main.js` against the restored DB —
   `/health` db up, customer + owner login (201), `/orders/my` (4 orders),
   restaurant list (6). The restored DB behaves like the source.
4. Rotation proven: `BACKUP_KEEP=1` with two dumps in the directory left only
   the newest (plus its sidecar).
5. Corruption paths proven on a truncated dump copy: with a stale `.sha256`
   sidecar → aborts before touching the target (exit 2); without a sidecar →
   aborts at the `pg_restore --list` sanity check (exit 2).

## Retention & off-host copies

Local rotation keeps 14 daily dumps by default — enough to recover any day of
the last two weeks. For real durability copy the dumps off the database host
(`rsync ops/backups/ backup@nas:/mnt/nas/fo-backups/` in a post-backup hook);
the sha256 sidecars make transfer corruption detectable.
