#!/usr/bin/env bash
# FoodOrder PostgreSQL backup — pg_dump custom-format archive + rotation.
#
# Reads the connection string from $DATABASE_URL; if unset, falls back to the
# untracked apps/api/.env next to the repo root. Credentials are never passed
# on the command line (pg_dump takes the URI from the environment).
#
# Usage:
#   ops/backup-db.sh                    # backup into ops/backups/
#   BACKUP_DIR=/mnt/nas/fo-backups ops/backup-db.sh
#   BACKUP_KEEP=30 ops/backup-db.sh     # keep 30 most recent dumps (default 14)
#
# Exit codes: 0 ok · 1 usage/config · 2 pg_dump failed · 3 verification failed
# (an archive that pg_restore cannot list is treated as a failed backup —
#  we never keep a dump we cannot prove is readable).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$SCRIPT_DIR/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="$BACKUP_DIR/foodorder-$STAMP.dump"

die() { echo "backup-db: $*" >&2; exit "${2:-1}"; }

# --- resolve DATABASE_URL ---------------------------------------------------
if [[ -z "${DATABASE_URL:-}" ]]; then
  ENV_FILE="${ENV_FILE:-$REPO_ROOT/apps/api/.env}"
  [[ -f "$ENV_FILE" ]] || die "DATABASE_URL not set and $ENV_FILE not found"
  DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')"
fi
[[ -n "$DATABASE_URL" ]] || die "DATABASE_URL is empty"

command -v pg_dump    >/dev/null || die "pg_dump not found in PATH"
command -v pg_restore >/dev/null || die "pg_restore not found in PATH"

# --- dump -------------------------------------------------------------------
mkdir -p "$BACKUP_DIR"
echo "backup-db: dumping $(echo "$DATABASE_URL" | sed -E 's#://[^@]*@#://***@#') -> $DUMP"
if ! pg_dump --format=custom --compress=9 --no-owner --no-privileges \
     --file="$DUMP" "$DATABASE_URL"; then
  rm -f "$DUMP"
  die "pg_dump failed" 2
fi

# --- verify the archive is a readable dump ----------------------------------
if ! pg_restore --list "$DUMP" >/dev/null 2>&1; then
  rm -f "$DUMP"
  die "archive failed pg_restore --list verification (dump deleted, NOT backed up)" 3
fi
OBJECTS="$(pg_restore --list "$DUMP" | grep -Ec '^[^;]' || true)"

# --- checksum + manifest ------------------------------------------------------
( cd "$BACKUP_DIR" && sha256sum "$(basename "$DUMP")" > "$DUMP.sha256" )
echo "backup-db: OK — $(du -h "$DUMP" | cut -f1), ~$OBJECTS archive entries"

# --- rotation: keep the $BACKUP_KEEP newest dumps ----------------------------
mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/foodorder-*.dump 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)))
for f in "${OLD[@]:-}"; do
  [[ -n "$f" ]] || continue
  echo "backup-db: rotate: removing $(basename "$f") (+ .sha256)"
  rm -f "$f" "$f.sha256"
done
