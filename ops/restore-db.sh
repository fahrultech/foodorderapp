#!/usr/bin/env bash
# FoodOrder PostgreSQL restore — pg_restore a custom-format dump produced by
# ops/backup-db.sh into a target database.
#
# Usage:
#   ops/restore-db.sh <dump-file> --target-url <postgresql://...>
#   ops/restore-db.sh ops/backups/foodorder-20261026-120000.dump \
#       --target-url "$RESTORE_URL"
#
# SAFETY: restores into the database named by --target-url and requires
# explicit --yes confirmation. The target's existing public-schema objects are
# dropped and recreated from the archive (pg_restore --clean --if-exists).
# To restore onto the dev database you deliberately pass its URL.
#
# Exit codes: 0 ok · 1 usage/config · 2 verify/restore failed
set -euo pipefail

TARGET_URL=""
DUMP=""
ASSUME_YES=0

die() { echo "restore-db: $*" >&2; exit "${2:-1}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-url) TARGET_URL="${2:-}"; shift 2 ;;
    --yes|-y)     ASSUME_YES=1; shift ;;
    -*)           die "unknown option: $1" ;;
    *)            DUMP="$1"; shift ;;
  esac
done

[[ -n "$DUMP" ]] || die "usage: restore-db.sh <dump-file> --target-url <postgresql-uri> [--yes]"
[[ -f "$DUMP" ]] || die "dump not found: $DUMP"
[[ -n "$TARGET_URL" ]] || die "--target-url is required (refusing to guess a target)"
command -v pg_restore >/dev/null || die "pg_restore not found in PATH"

# --- checksum, if a sidecar exists -------------------------------------------
if [[ -f "$DUMP.sha256" ]]; then
  ( cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256" ) \
    || die "checksum mismatch for $DUMP — refusing to restore" 2
fi

# --- archive sanity -----------------------------------------------------------
pg_restore --list "$DUMP" >/dev/null 2>&1 || die "archive unreadable: $DUMP" 2
DB_LABEL="$(echo "$TARGET_URL" | sed -E 's#.*[:/]([^/?]+)(\?.*)?$#\1#; s#.*@##; s#/+$##')"
SAFE_DB="${DB_LABEL##*/}"
echo "restore-db: target database '$SAFE_DB'"
if [[ $ASSUME_YES -ne 1 ]]; then
  read -r -p "restore-db: this REPLACES all objects in '$SAFE_DB'. Type yes to continue: " ans
  [[ "$ans" == "yes" ]] || die "aborted by operator"
fi

echo "restore-db: restoring $(basename "$DUMP") -> $SAFE_DB"
# --clean --if-exists: drop what the archive recreates, ignore "does not exist".
# Single-transaction so a mid-restore failure leaves the target untouched.
if ! pg_restore --clean --if-exists --no-owner --no-privileges \
     --exit-on-error --single-transaction --dbname="$TARGET_URL" "$DUMP"; then
  die "pg_restore failed (target left untouched — single-transaction)" 2
fi
echo "restore-db: OK — run 'npm run migration:run' only if the dump predates newer migrations."
