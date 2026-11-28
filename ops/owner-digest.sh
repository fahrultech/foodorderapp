#!/usr/bin/env bash
# FoodOrder owner daily digest — cron/systemd entrypoint.
#
# Emails each restaurant owner yesterday's order counts, completed revenue
# (cents) and top dishes per owned restaurant, through the api's MailService.
# Thin wrapper: it hands off to `npm run owner-digest` in apps/api, whose
# script loads DATABASE_URL + SMTP_* via dotenv (from the untracked
# apps/api/.env) — credentials are never on a command line or stored here.
#
# Env knobs (all optional):
#   DIGEST_DATE                covered day YYYY-MM-DD (default: yesterday, local)
#   DIGEST_DRY_RUN=1           compute + report only; claims nothing, sends nothing
#   DIGEST_CLAIM_STALE_MINUTES crashed-claim take-over window (default 30)
#   ENV_FILE                   path to the api .env (default apps/api/.env)
#
# Usage:
#   ops/owner-digest.sh                        # real run for yesterday
#   DIGEST_DRY_RUN=1 ops/owner-digest.sh       # see the report, send nothing
#   DIGEST_DATE=2026-11-25 ops/owner-digest.sh # backfill a specific day
#
# Exit codes mirror the node script: 0 ok (skips included) · 1 config/DB
# error OR any failed send (the ledger releases failed claims so the next
# tick retries; the non-zero exit is the cron's alerting hook).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$REPO_ROOT/apps/api"

command -v npm >/dev/null || { echo "owner-digest: npm not found in PATH" >&2; exit 1; }
[[ -d "$API_DIR" ]] || { echo "owner-digest: $API_DIR not found" >&2; exit 1; }

echo "owner-digest: reporting day ${DIGEST_DATE:-yesterday}${DIGEST_DRY_RUN:+ DRY_RUN=$DIGEST_DRY_RUN}" >&2
cd "$API_DIR"
exec npm run --silent owner-digest
