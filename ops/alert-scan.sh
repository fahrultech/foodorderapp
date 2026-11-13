#!/usr/bin/env bash
# FoodOrder alert SCAN — cron/systemd entrypoint (Phase 8 Ops, session 86).
#
# Polls the RUNNING API's `GET /api/admin/alerts` (the SAME ops/alerts rule
# engine the periodic `request_metrics` pino fold line carries) and turns the
# verdict into scheduler exit codes:
#
#   0 = healthy      — cron stays silent
#   1 = ALERTING     — error_budget / p95_latency / route_key_overflow fired;
#                      cron MAILTO (or systemd's OnFailure= unit) notifies
#   2 = scan broken  — API unreachable, bad credentials, unexpected shape
#
# Why HTTP and not direct DB access like the other ops scripts: the metrics
# registry lives IN the API process (cumulative-since-boot, session 80) —
# there is no DB mirror to query from outside. Snapshot persistence for true
# time windows is the next Phase 8 Ops item.
#
# Requires a dedicated ADMIN service account (never a personal login — the
# scan rotates through it every run and its email shows up in alert mails).
# Credentials come from the environment / the untracked apps/api/.env that
# dotenv loads inside `npm run alert-scan`; they are NEVER stored here.
#
# Env knobs:
#   ALERT_SCAN_BASE_URL    API base incl. /api (default http://localhost:4000/api)
#   ALERT_SCAN_EMAIL       ADMIN account email        (required)
#   ALERT_SCAN_PASSWORD    ADMIN account password     (required)
#   ALERT_SCAN_TIMEOUT_MS  per-request timeout        (default 10000)
#
# Usage:
#   ops/alert-scan.sh                       # scan the local API
#   ALERT_SCAN_BASE_URL=https://app.example/api ops/alert-scan.sh
#
# Exit codes mirror the node script (0 · 1 · 2).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$REPO_ROOT/apps/api"

command -v npm >/dev/null || { echo "alert-scan: npm not found in PATH" >&2; exit 2; }
[[ -d "$API_DIR" ]] || { echo "alert-scan: $API_DIR not found" >&2; exit 2; }

cd "$API_DIR"
exec npm run --silent alert-scan
