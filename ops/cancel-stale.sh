#!/usr/bin/env bash
# FoodOrder stale-pending-order sweep — cron/systemd entrypoint.
#
# Cancels abandoned `pending` orders (guest checkouts no human acted on) using
# the SAME shared sweep logic as the admin HTTP route. Thin wrapper: it hands
# off to `npm run cancel-stale` in apps/api, whose script loads DATABASE_URL via
# dotenv (from the untracked apps/api/.env) — credentials are never on a command
# line or stored in this file.
#
# Env knobs (all optional):
#   STALE_ORDER_MINUTES  pending-abandonment window, minutes (default 45)
#   STALE_ORDER_BATCH    max cancels per run              (default 500)
#   DRY_RUN=1            report candidates, change nothing
#   ENV_FILE            path to the api .env (default apps/api/.env)
#
# Usage:
#   ops/cancel-stale.sh                 # real sweep with defaults
#   DRY_RUN=1 ops/cancel-stale.sh       # see what would be cancelled first
#   STALE_ORDER_MINUTES=20 ops/cancel-stale.sh
#
# Exit codes mirror the node script: 0 ok · 1 failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$REPO_ROOT/apps/api"

command -v npm >/dev/null || { echo "cancel-stale: npm not found in PATH" >&2; exit 1; }
[[ -d "$API_DIR" ]] || { echo "cancel-stale: $API_DIR not found" >&2; exit 1; }

echo "cancel-stale: sweeping pending orders older than ${STALE_ORDER_MINUTES:-45}min (batch ${STALE_ORDER_BATCH:-500})${DRY_RUN:+ DRY_RUN=$DRY_RUN}" >&2
cd "$API_DIR"
exec npm run --silent cancel-stale
