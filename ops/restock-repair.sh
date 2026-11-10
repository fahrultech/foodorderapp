#!/usr/bin/env bash
# FoodOrder restock REPAIR pass — cron/systemd entrypoint.
#
# Returns reserved stock units for cancelled orders the restock pass MISSED
# (the crash window between the status commit and the restock transaction)
# using the SAME shared repair logic as the admin HTTP route. Thin wrapper:
# it hands off to `npm run restock-repair` in apps/api, whose script loads
# DATABASE_URL via dotenv (from the untracked apps/api/.env) — credentials are
# never on a command line or stored in this file.
#
# The marker CAS inside makes every run exactly-once and idempotent: safe to
# fire on top of a live API, safe to re-run, safe to run concurrently.
#
# Env knobs (all optional):
#   RESTOCK_REPAIR_GRACE_MINUTES  crash grace window, minutes (default 10)
#   RESTOCK_REPAIR_BATCH          max repairs per run          (default 500)
#   DRY_RUN=1                     report what WOULD be repaired, change nothing
#   ENV_FILE                      unused here; dotenv reads apps/api/.env itself
#
# Usage:
#   ops/restock-repair.sh                    # real repair with defaults
#   DRY_RUN=1 ops/restock-repair.sh          # see the orphan backlog first
#   RESTOCK_REPAIR_BATCH=50 ops/restock-repair.sh
#
# Exit codes mirror the node script: 0 ok · 1 failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$REPO_ROOT/apps/api"

command -v npm >/dev/null || { echo "restock-repair: npm not found in PATH" >&2; exit 1; }
[[ -d "$API_DIR" ]] || { echo "restock-repair: $API_DIR not found" >&2; exit 1; }

echo "restock-repair: repairing restock orphans older than ${RESTOCK_REPAIR_GRACE_MINUTES:-10}min (batch ${RESTOCK_REPAIR_BATCH:-500})${DRY_RUN:+ DRY_RUN=$DRY_RUN}" >&2
cd "$API_DIR"
exec npm run --silent restock-repair
