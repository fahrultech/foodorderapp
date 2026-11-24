#!/usr/bin/env bash
# FoodOrder SCHEDULED PERF REGRESSION check — cron/systemd entrypoint
# (Phase 13 Test item, session 124).
#
# Runs the k6 WRITE LADDER (ops/load-test-write.js: anonymous cached browse ->
# signup -> order create -> payment intent -> capture -> receipt) as a smoke
# arm against a THROWAWAY instance: fresh scratch DB on the full migration
# chain + seed, production build on a dedicated port, limiter buckets relaxed
# boot-time only on this instance. The verdict comes from
# ops/perf-check.analyze.mjs (k6 exit code + summary-JSON rules) plus an
# exact DB cross-check — "baselines drift" is caught by this runner, not by
# memory (session 121's numbers are the reference in docs/PERFORMANCE.md).
#
# Exit codes mirror the alert-scan doctrine (session 86):
#   0 = green      — ladder completed, p95 inside the ceiling, DB truth exact
#   1 = REGRESSION — latency/counter/threshold rule violated OR the rows the
#                    run wrote disagree with the k6 counters (cron MAILTO /
#                    OnFailure= notifies)
#   2 = rig broken — prereqs missing, build/seed/boot failure, k6 aborted or
#                    crashed, unreadable summary, psql unreachable (a dead
#                    smoke detector must never page like a fire — and must
#                    never report green either)
#
# What is deliberately NOT asserted here: statements-per-request (needs the
# query-logger ALTER-before-boot windowing of session 79/104 — a manual
# follow-up, not a nightly gate) and the TTL=0 control arm (session 121
# established it as a one-off A/B; the scheduled check guards ONE arm: the
# shipped defaults, which is what production runs).
#
# Env knobs (all optional):
#   PERF_CHECK_PORT        throwaway API port        (default 4110)
#   PERF_CHECK_DB          scratch database name     (default foodorder_perfcheck)
#   PERF_CHECK_PROFILE     k6 profile                (default smoke; load = full ladder)
#   PERF_CHECK_P95_MS_MAX  p95 latency ceiling (ms)  (default 120, ~7x the smoke baseline)
#   PERF_CHECK_MIN_ITERS   below this the sample is unjudgeable (default 5)
#   PERF_CHECK_RATE_MAX    boot-time RATE_LIMIT_*_MAX (default 20000)
#   PERF_CHECK_K6_IMAGE    container image           (default grafana/k6:latest)
#   PERF_CHECK_BUILD       1 = nest build first (default), 0 = reuse dist/
#   PERF_CHECK_KEEP_DB     1 = leave the scratch DB for postmortems (default 0)
#   ENV_FILE               api env file (default apps/api/.env)
#   PERF_CHECK_LOCK        lock file (default /tmp/foodorder-perf-check.lock)
#
# Usage:
#   ops/perf-check.sh                     # smoke arm, ~1.5 min end to end
#   PERF_CHECK_PROFILE=load ops/perf-check.sh   # full 2.5 min ladder
# The scratch DATABASE_URL is derived from ENV_FILE at runtime; credentials
# never appear in this file, in argv, or in the report.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$REPO_ROOT/apps/api"
ENV_FILE="${ENV_FILE:-$API_DIR/.env}"

PORT="${PERF_CHECK_PORT:-4110}"
SCRATCH_DB="${PERF_CHECK_DB:-foodorder_perfcheck}"
PROFILE="${PERF_CHECK_PROFILE:-smoke}"
P95_MAX="${PERF_CHECK_P95_MS_MAX:-120}"
MIN_ITERS="${PERF_CHECK_MIN_ITERS:-5}"
RATE_MAX="${PERF_CHECK_RATE_MAX:-20000}"
K6_IMAGE="${PERF_CHECK_K6_IMAGE:-grafana/k6:latest}"
DO_BUILD="${PERF_CHECK_BUILD:-1}"
KEEP_DB="${PERF_CHECK_KEEP_DB:-0}"
LOCK_FILE="${PERF_CHECK_LOCK:-/tmp/foodorder-perf-check.lock}"

RUN_ID="perf124-$$-$(date +%s)"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/foodorder-perfcheck-XXXXXX")"
LOG="$RUN_DIR/api.log"
K6LOG="$RUN_DIR/k6.log"
SUMMARY="$RUN_DIR/k6-summary.json"
API_PID=""
DB_CREATED=0
CROSSCHECK="skipped"
EXTRA_REASONS=""

log()  { echo "perf-check: $*" >&2; }
RIG=2  # current failure classification until proven otherwise

# One-line JSON verdict to stdout, then exit with the doctrine code.
finish() { # $1=code $2=verdict $3..=extra reasons (appended)
  local code="$1" verdict="$2"; shift 2
  local reasons="$*"
  ANALYZE_JSON="${ANALYZE_JSON:-}"
  jq -n \
    --arg verdict "$verdict" --argjson code "$code" \
    --arg runId "$RUN_ID" --arg db "$SCRATCH_DB" --arg port "$PORT" \
    --arg profile "$PROFILE" --arg image "$K6_IMAGE" \
    --arg started "$RUN_START" --arg finished "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg logDir "$RUN_DIR" --arg crosscheck "$CROSSCHECK" \
    --arg seedOrders "${SEED_ORDERS:-}" --arg anchor "${SEED_ANCHOR:-}" \
    --arg analyze "${ANALYZE_JSON:-{\}}" --arg reasons "$reasons" \
    '{verdict: $verdict, exitCode: $code, runId: $runId, rig:
        {db: $db, port: ($port|tonumber), profile: $profile, k6Image: $image,
         startedAt: $started, finishedAt: $finished, logDir: $logDir,
         seededOrders: (if ($seedOrders|length) > 0 then $seedOrders else null end),
         windowAnchor: (if ($anchor|length) > 0 then $anchor else null end)},
      analyze: ($analyze|fromjson? // {}), dbCrosscheck: $crosscheck,
      reasons: ($reasons | split("; ") | map(select(length > 0)))}'
  case "$code" in
    0) log "GREEN — write ladder within baseline ceiling" ;;
    1) log "REGRESSION — see reasons above" ;;
    *) log "RIG BROKEN — no verdict is trustworthy" ;;
  esac
  exit "$code"
}

fail2() { # rig-broken with a named reason
  local reason="$*"
  log "rig-broken: $reason"
  finish 2 rig-broken "$reason"
}

cleanup() {
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$API_PID" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$API_PID" 2>/dev/null
    log "stopped scratch API (pid $API_PID)"
  fi
  if [[ "$DB_CREATED" == 1 && "$KEEP_DB" != 1 ]] && pgadmin -c "SELECT 1" >/dev/null 2>&1; then
    pgadmin -c "DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)" >/dev/null 2>&1 \
      && log "dropped scratch DB $SCRATCH_DB" \
      || log "WARNING: could not drop scratch DB $SCRATCH_DB (kept for manual cleanup)"
  fi
}
trap cleanup EXIT

# psql as the postgres superuser: the foodorder role lacks CREATEDB, and a
# timer running as root has no sudo need (runuser); a human gets sudo -n.
pgadmin() {
  if [[ "$(id -u)" == "0" ]]; then
    runuser -u postgres -- psql -X -q "$@"
  else
    sudo -n -u postgres psql -X -q "$@"
  fi
}
# psql against the scratch DB via the derived connection URL (creds never
# echoed: the value is only ever an expansion of the sourced one).
pscratch() { psql -X -tA "$PERF_DB_URL" "$@"; }

# ---------------------------------------------------------------------------
# Preflight (everything before this point is side-effect free)
# ---------------------------------------------------------------------------
RUN_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

command -v node  >/dev/null || fail2 "node not found in PATH"
command -v jq    >/dev/null || fail2 "jq not found in PATH"
command -v curl  >/dev/null || fail2 "curl not found in PATH"
command -v psql  >/dev/null || fail2 "psql not found in PATH"
command -v npm   >/dev/null || fail2 "npm not found in PATH"
[[ -d "$API_DIR" ]]        || fail2 "$API_DIR not found"
[[ -f "$ENV_FILE" ]]       || fail2 "$ENV_FILE not found (scratch DB URL is derived from it)"
[[ -f "$REPO_ROOT/ops/load-test-write.js" ]] || fail2 "ops/load-test-write.js missing"

# docker: plain if the caller can talk to the socket, else sudo -n.
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  DOCKER="sudo -n docker"
  $DOCKER info >/dev/null 2>&1 || fail2 "docker daemon unreachable (plain and via sudo -n)"
fi

# no overlapping runs (a second instance would fight over DB + port)
exec 200>"$LOCK_FILE" || fail2 "cannot open lock file $LOCK_FILE"
flock -n 200 || fail2 "another perf-check holds $LOCK_FILE — refusing to overlap"

# fail FAST on a busy port: a stale API silently serves an OLD dist and
# every assertion below becomes junk (live-smoke doctrine).
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}\$"; then
  fail2 "port $PORT already listening — free it or set PERF_CHECK_PORT"
fi

# scratch DB identity: derive from the sourced URL, never inline the creds
set -a; . "$ENV_FILE" 2>/dev/null || fail2 "ENV_FILE is not sourceable bash"; set +a
[[ -n "${DATABASE_URL:-}" ]] || fail2 "no database connection string in ENV_FILE"
PERF_DB_URL="${DATABASE_URL%/*}/${SCRATCH_DB}"
export DATABASE_URL="$PERF_DB_URL"
[[ "$SCRATCH_DB" =~ ^[a-z][a-z0-9_]{0,30}$ ]] || fail2 "PERF_CHECK_DB '$SCRATCH_DB' is not a safe db name"

pgadmin -c "SELECT 1" >/dev/null 2>&1 || fail2 "cannot reach postgres as the postgres superuser (sudo -n or root required)"
DB_CREATED=1
pgadmin -c "DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)" >/dev/null 2>&1 || fail2 "could not drop a leftover scratch DB"
pgadmin -c "CREATE DATABASE ${SCRATCH_DB} OWNER foodorder"      >/dev/null 2>&1 || fail2 "could not create scratch DB ${SCRATCH_DB}"
log "scratch DB ${SCRATCH_DB} created (fresh chain)"

# ---------------------------------------------------------------------------
# Build + seed + boot the throwaway instance
# ---------------------------------------------------------------------------
if [[ "$DO_BUILD" == 1 ]]; then
  log "nest build (PERF_CHECK_BUILD=0 to reuse dist/)"
  ( cd "$API_DIR" && npm run --silent build ) >"$RUN_DIR/build.log" 2>&1 \
    || fail2 "nest build failed (tail: $(tail -3 "$RUN_DIR/build.log" | tr '\n' ' ' ))"
fi
[[ -f "$API_DIR/dist/main.js" ]] || fail2 "dist/main.js missing — run a build or drop PERF_CHECK_BUILD=0"

log "seeding (full migration chain from empty + canonical seed)"
( cd "$API_DIR" && npm run --silent seed ) >"$RUN_DIR/seed.log" 2>&1 \
  || fail2 "seed failed (tail: $(tail -3 "$RUN_DIR/seed.log" | tr '\n' ' ' ))"
SEED_ORDERS="$(pscratch -c 'SELECT count(*) FROM orders' | tr -d '[:space:]')"
[[ "$SEED_ORDERS" =~ ^[0-9]+$ ]] || fail2 "cannot read the seeded orders baseline"
# Run-window anchor: the LATEST seeded timestamp, so the ladder's rows are
# strictly newer. A wall-clock RUN_START would swallow the fixture orders —
# the seed writes createdAt=now within the same second (session 124 first
# live run: orders=39/29, orphans=10 = exactly the seeded ten).
SEED_ANCHOR="$(pscratch -c "SELECT greatest((SELECT coalesce(max(\"createdAt\"),to_timestamp(0)) FROM orders),(SELECT coalesce(max(\"createdAt\"),to_timestamp(0)) FROM payments))::text")"  # NOT tr -d space: the ISO timestamp carries a significant space; $() strips the newline
[[ -n "$SEED_ANCHOR" ]] || fail2 "cannot read the seed timestamp anchor"

log "booting scratch API on :$PORT (limiter buckets relaxed, boot-time only)"
BOOT_ARGS=(env "PORT=$PORT")
for bucket in AUTH ORDERS PAYMENTS; do
  BOOT_ARGS+=("RATE_LIMIT_${bucket}_MAX=$RATE_MAX")
done
( cd "$API_DIR" && exec "${BOOT_ARGS[@]}" node dist/main.js ) >"$LOG" 2>&1 &
API_PID=$!

HEALTHY=0
for _ in $(seq 1 60); do
  kill -0 "$API_PID" 2>/dev/null || { tail -5 "$LOG" >&2; fail2 "scratch API process died during boot"; }
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 1
done
[[ "$HEALTHY" == 1 ]] || fail2 "scratch API never answered /api/health within 60s"
log "scratch API healthy (pid $API_PID)"

# ---------------------------------------------------------------------------
# The ladder
# ---------------------------------------------------------------------------
chmod 777 "$RUN_DIR"   # k6's container user must write the summary (session 82)
log "k6 write ladder: PROFILE=$PROFILE image=$K6_IMAGE"
$DOCKER run --rm --network host \
  -e BASE_URL="http://127.0.0.1:${PORT}/api" \
  -e PROFILE="$PROFILE" \
  -e CACHE_ARM=on \
  -v "$REPO_ROOT/ops:/scripts:ro" \
  -v "$RUN_DIR:/out:rw" \
  "$K6_IMAGE" run --summary-export=/out/k6-summary.json /scripts/load-test-write.js \
  >"$K6LOG" 2>&1
K6_RC=$?
log "k6 exited $K6_RC (log: $K6LOG)"

# ---------------------------------------------------------------------------
# Verdict: analyzer (run class + result rules), then exact DB cross-check
# ---------------------------------------------------------------------------
ANALYZE_RC=0
ANALYZE_JSON="$(node "$REPO_ROOT/ops/perf-check.analyze.mjs" \
  --summary "$SUMMARY" --k6-rc "$K6_RC" \
  --p95-max "$P95_MAX" --min-iterations "$MIN_ITERS" 2>/dev/null)" || ANALYZE_RC=$?
case "$ANALYZE_RC:$ANALYZE_JSON" in
  0:*) VERDICT=green;      CODE=0 ;;
  1:*) VERDICT=regression; CODE=1 ;;
  2:*) VERDICT=rig-broken; CODE=2 ;;
  *)   ANALYZE_JSON="{\"reasons\":[\"analyzer process failed (rc $ANALYZE_RC)\"]}"
       VERDICT=rig-broken; CODE=2 ;;
esac

if [[ "$VERDICT" != rig-broken ]]; then
  # The rows the run wrote must agree EXACTLY with the counters — session
  # 121's post-run cross-check as a scheduled assertion. Deltas vs the
  # seeded baseline (never absolutes — the seed ships fixture orders).
  OP="$(jq -r '.facts.ordersPlaced // 0'      <<<"$ANALYZE_JSON" 2>/dev/null)"
  PC="$(jq -r '.facts.paymentsCaptured // 0'  <<<"$ANALYZE_JSON" 2>/dev/null)"
  DBX="$(pscratch -c "
    SELECT (SELECT count(*) FROM orders   WHERE \"createdAt\" > '${SEED_ANCHOR}'::timestamptz)::text
        || '/' || (SELECT count(*) FROM payments  WHERE status = 'succeeded' AND \"createdAt\" > '${SEED_ANCHOR}'::timestamptz)::text
        || '/' || (SELECT count(*) FROM (
             SELECT o.id FROM orders o
             LEFT JOIN payments p ON p.\"orderId\" = o.id AND p.status = 'succeeded'
             WHERE o.\"createdAt\" > '${SEED_ANCHOR}'::timestamptz
             GROUP BY o.id HAVING count(p.id) <> 1) bad)::text
  " 2>/dev/null | tr -d '[:space:]')"
  if [[ ! "$DBX" =~ ^([0-9]+)/([0-9]+)/([0-9]+)$ ]]; then
    VERDICT=rig-broken; CODE=2; CROSSCHECK="unreadable"
    EXTRA_REASONS="DB cross-check returned garbage ('$DBX') — the rig itself failed"
  else
    DB_ORDERS="${BASH_REMATCH[1]}"; DB_PAYMENTS="${BASH_REMATCH[2]}"; DB_BAD="${BASH_REMATCH[3]}"
    CROSSCHECK="orders=$DB_ORDERS/$OP payments=$DB_PAYMENTS/$PC orphan_orders=$DB_BAD"
    if [[ "$DB_ORDERS" != "$OP" ]]; then
      VERDICT=regression; CODE=1
      EXTRA_REASONS="orders written ($DB_ORDERS) disagree with orders_placed counter ($OP)"
    fi
    if [[ "$DB_PAYMENTS" != "$PC" ]]; then
      VERDICT=regression; CODE=1
      EXTRA_REASONS="${EXTRA_REASONS}; succeeded payments ($DB_PAYMENTS) disagree with payments_captured counter ($PC)"
    fi
    if [[ "$DB_BAD" != "0" ]]; then
      VERDICT=regression; CODE=1
      EXTRA_REASONS="${EXTRA_REASONS}; $DB_BAD run-window orders lack exactly one succeeded payment"
    fi
  fi
  # Any 5xx line in the scratch API log is by definition this run's fault —
  # the rig DB is fresh and nothing else talks to it (session 121 pinned
  # zero 5xx lines as part of the baseline contract).
  ERR5XX="$(grep -c '"level":50' "$LOG" 2>/dev/null || true)"
  if [[ "${ERR5XX:-0}" -gt 0 && "$VERDICT" != rig-broken ]]; then
    VERDICT=regression; CODE=1
    EXTRA_REASONS="${EXTRA_REASONS}; scratch API log carries $ERR5XX error(50) lines during the run"
  fi
fi

[[ "$CODE" == 0 ]] || { jq -r '.reasons[]? // empty' <<<"$ANALYZE_JSON" >&2 || true; }
[[ -n "$EXTRA_REASONS" ]] && finish "$CODE" "$VERDICT" "$EXTRA_REASONS"
finish "$CODE" "$VERDICT" "$(jq -r '.reasons | join("; ")' <<<"$ANALYZE_JSON" 2>/dev/null || true)"
