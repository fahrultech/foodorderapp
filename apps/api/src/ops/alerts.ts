/**
 * Alert RULES on top of the request-metrics snapshot (Phase 8, Ops loop).
 *
 * DI-free and pure — takes a `MetricsSnapshot` and thresholds, returns a
 * verdict — so the SAME evaluation powers three consumers that must never
 * disagree:
 *   1. `GET /admin/alerts`  (pull: humans and the alert-scan cron poll it),
 *   2. the periodic `event: "request_metrics"` pino fold line (push: every
 *      fold carries the compact verdict, so a log-based alerter needs no
 *      second rule engine),
 *   3. `ops/alert-scan.sh` → src/scripts/alert-scan.ts (scheduler exit codes:
 *      0 healthy · 1 alerting · 2 scan itself failed).
 *
 * The 4th rule additionally needs a DB-backed observation (age of the
 * newest `metrics_snapshots` row). It is supplied by the CALLER as the
 * third argument: `GET /admin/alerts` (and every consumer of it, incl.
 * alert-scan) passes `MetricsPersistenceService.freshnessInput()`, so the
 * scan inherits the rule with zero script changes. The periodic fold line
 * is a synchronous consumer with no DB handle — there the rule reports an
 * honest "not evaluated" verdict (never a false fire, never a false ok).
 *
 * Rules (all thresholds operator-tunable via env, defaults below):
 *   - error_budget: 5xx share of requests vs the 99.5% availability SLO →
 *     a budget of 0.5% server errors. Only evaluated once the sample reaches
 *     ALERT_MIN_REQUESTS (a single 5xx out of two requests is noise on the
 *     cumulative-since-boot totals, not an outage signal).
 *   - p95_latency: global histogram-estimated p95 above ALERT_P95_MS_MAX.
 *     Nearest-bound estimates are >= the true value, so this can fire early
 *     by one bound — the honest, documented trade-off of the histogram.
 *   - route_key_overflow: the cardinality cap folded new route keys into the
 *     `other` bucket (session 80). A WARNING: telemetry degrades, users
 *     don't. It still flips the verdict to `alerting` — a flood of distinct
 *     paths is worth a look.
 *   - snapshot_stale (session 109): the metrics_snapshots durability rows
 *     (session 89) are the error budget's MEMORY — a silently dead writer
 *     zeroes the windowed history while every live number keeps looking
 *     healthy. Fires when the writer is enabled but the newest stored row is
 *     older than ALERT_SNAPSHOT_STALE_AFTER_SEC (default: 2x the snapshot
 *     interval); with zero rows the grace counts from API uptime (a fresh
 *     boot has not reached its first tick yet). A DISABLED writer
 *     (METRICS_SNAPSHOT_INTERVAL_SEC=0) is EXEMPT by design — the operator
 *     opted out of durability, so there is nothing to go stale. WARNING
 *     severity like route_key_overflow: observability degrades, users don't.
 *   - rate_limit_pressure (session 123): the registry tallies guard-verified
 *     429s per route (totals.throttled), but 429s hide inside the 4xx class,
 *     so a store silently shedding customers looked healthy between the
 *     limiter headers and the customer complaint. Fires when the throttled
 *     share of the sample STRICTLY exceeds ALERT_RATE_LIMIT_PCT_MAX (default
 *     5), over the SAME min-sample floor as the budget rule. WARNING
 *     severity on purpose: a 429 means the limiter WORKED (a clean,
 *     header-carrying refusal), but sustained pressure means customers are
 *     being turned away — capacity/config attention, not an outage. Still
 *     flips the verdict, the fold line and the alert-scan exit code.
 *
 * Cumulative-since-boot caveat inherited from the registry (session 85):
 * an early 5xx burst keeps the budget rule lit until traffic dilutes it.
 * That is deliberate v1 behaviour (same data source as /admin/metrics);
 * snapshot persistence for true windows is the next Phase 8 Ops item.
 */

import {
  MAX_ROUTE_KEYS,
  MetricsSnapshot,
  OVERFLOW_KEY,
} from '../common/metrics/request-metrics';

export type AlertRuleId =
  | 'error_budget'
  | 'p95_latency'
  | 'route_key_overflow'
  | 'snapshot_stale'
  | 'rate_limit_pressure';
export type AlertSeverity = 'error' | 'warning';
export type AlertStatus = 'ok' | 'alerting';

/**
 * The durability observation the snapshot_stale rule needs (session 109).
 * Produced by MetricsPersistenceService.freshnessInput() — the engine
 * stays DI-free and the AGE arithmetic stays testable: `nowMs` is
 * injectable, production defaults to Date.now().
 */
export interface SnapshotFreshnessInput {
  /** Writer configured on (METRICS_SNAPSHOT_INTERVAL_SEC > 0). */
  enabled: boolean;
  /** The configured interval in seconds (0 when disabled). */
  intervalSec: number;
  /** Epoch ms of the newest metrics_snapshots row; null = no row (or unreadable). */
  lastCapturedAtMs: number | null;
  /** The store read itself FAILED (table missing / DB down) — honesty flag,
   *  reported as "unreadable" rather than a fabricated "no rows" age. */
  storeError?: boolean;
  /** Clock override for tests. */
  nowMs?: number;
}

export interface AlertThresholds {
  /** Percent (0-100). Rule fires when the 5xx rate STRICTLY exceeds it. */
  fiveXxRatePctMax: number;
  /** Milliseconds. Fires when the global p95 estimate STRICTLY exceeds it. */
  p95MsMax: number;
  /** Minimum total requests before the budget rule is evaluated at all. */
  minRequests: number;
  /**
   * Percent (0-100) of guard-throttled 429s allowed within the sample
   * before the rate_limit_pressure rule fires (session 123). Fires
   * STRICTLY above it; shares the minRequests floor. 0 is legal — "any
   * throttled request alerts" — for operators proving the chain.
   */
  rateLimitPctMax: number;
  /**
   * snapshot_stale ceiling in seconds. null (default) = 2x the configured
   * METRICS_SNAPSHOT_INTERVAL_SEC, resolved at evaluation time; a positive
   * integer from ALERT_SNAPSHOT_STALE_AFTER_SEC overrides the multiplier.
   */
  snapshotStaleAfterSec: number | null;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  // 99.5% availability SLO (session 85's TrafficPanel): 0.5 pts of 5xx.
  fiveXxRatePctMax: 0.5,
  // Generous by design — the seeded app answers in single-digit ms; 1s of
  // global p95 means something is genuinely wrong, not just histogram
  // rounding (bounds jump 500 → 1000 → 2500).
  p95MsMax: 1000,
  // Below this sample the budget verdict is statistically meaningless.
  minRequests: 50,
  // 5% of ALL served responses guard-throttled = customers routinely
  // turned away. Deliberately an order of magnitude above the error-budget
  // SLO: occasional 429s are the limiter breathing (bursts, one abusive
  // client), a SUSTAINED 5% share across the sample is capacity/config
  // pressure worth a page. Tune with ALERT_RATE_LIMIT_PCT_MAX.
  rateLimitPctMax: 5,
  // null = derive 2x the snapshot interval per evaluation. The factor 2
  // means the writer must MISS TWO consecutive ticks before the alarm —
  // a single hiccup (one failed save, immediately retried next tick) is
  // noise, a silently dead writer is exactly two-tick silence.
  snapshotStaleAfterSec: null,
};

export interface AlertRuleResult {
  id: AlertRuleId;
  firing: boolean;
  severity: AlertSeverity;
  /**
   * The number the verdict rests on: 5xx rate in percent / p95 ms estimate /
   * distinct route keys / snapshot age in seconds / 429 share in percent.
   * Null when not evaluable (no samples yet, the sample is below
   * `minRequests`, or the rule is exempt/not supplied).
   */
  observed: number | null;
  /** The threshold `observed` is compared against (SLO pct / ms / key cap / stale seconds). */
  threshold: number;
  detail: string;
}

export interface AlertReport {
  generatedAt: string;
  uptimeSec: number;
  status: AlertStatus;
  /** Ids of the firing rules — empty array when `status === 'ok'`. */
  firingRules: AlertRuleId[];
  thresholds: AlertThresholds;
  rules: AlertRuleResult[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Env parsing per the observability-knob policy (METRICS_LOG_INTERVAL_SEC,
 * session 80): unset/blank/garbage/negative falls back to the default — a
 * typo must NEVER crash boot. `0` IS legal for both ceilings (0.5 → 0 means
 * "any 5xx alerts", p95 0 means "alert on the histogram floor" — operators
 * may want either when testing the chain end to end).
 */
function thresholdNumber(raw: string | undefined, fallback: number, floor: number): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < floor) return fallback;
  return n;
}

function positiveIntThreshold(raw: string | undefined, fallback: number): number {
  const n = thresholdNumber(raw, fallback, 0);
  return Math.floor(n) > 0 ? Math.floor(n) : fallback;
}

/**
 * ALERT_SNAPSHOT_STALE_AFTER_SEC: unset/blank/garbage/negative/0 → null,
 * meaning "derive 2x the snapshot interval at evaluation time". Unlike the
 * ceilings above, 0 is NOT a legal override here — a zero-second grace would
 * fire whenever a row is even one ms old, i.e. always; the doctrine is that
 * an operator who wants a tighter window passes a real number (session 89
 * made the same call about zero retention: a degenerate value on this knob
 * is indistinguishable from a typo).
 */
function positiveIntOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/** Same style as resolveRestockRepairConfig: pure env read, injectable for tests. */
export function resolveAlertThresholds(
  env: Record<string, string | undefined> = process.env,
): AlertThresholds {
  return {
    fiveXxRatePctMax: thresholdNumber(
      env.ALERT_5XX_RATE_PCT_MAX,
      DEFAULT_ALERT_THRESHOLDS.fiveXxRatePctMax,
      0,
    ),
    p95MsMax: thresholdNumber(env.ALERT_P95_MS_MAX, DEFAULT_ALERT_THRESHOLDS.p95MsMax, 0),
    rateLimitPctMax: thresholdNumber(
      env.ALERT_RATE_LIMIT_PCT_MAX,
      DEFAULT_ALERT_THRESHOLDS.rateLimitPctMax,
      0,
    ),
    minRequests: positiveIntThreshold(env.ALERT_MIN_REQUESTS, DEFAULT_ALERT_THRESHOLDS.minRequests),
    snapshotStaleAfterSec: positiveIntOrNull(env.ALERT_SNAPSHOT_STALE_AFTER_SEC),
  };
}

/** THE evaluation — one implementation, every consumer shares it. */
export function evaluateAlerts(
  snapshot: MetricsSnapshot,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
  freshness?: SnapshotFreshnessInput | null,
): AlertReport {
  const { totals } = snapshot;

  // ── rule 1: error budget (5xx vs availability SLO) ─────────────────────
  let budgetFiring = false;
  let budgetObserved: number | null = null;
  let budgetDetail: string;
  if (totals.requests <= 0) {
    budgetDetail = 'no requests sampled yet — rule not evaluable';
  } else {
    const ratePct = (totals.byStatus['5xx'] / totals.requests) * 100;
    if (totals.requests < thresholds.minRequests) {
      budgetDetail =
        `5xx rate ${round2(ratePct)}% over only ${totals.requests} requests ` +
        `(< ${thresholds.minRequests} min sample) — not evaluated`;
    } else {
      budgetObserved = round2(ratePct);
      budgetFiring = ratePct > thresholds.fiveXxRatePctMax;
      budgetDetail = budgetFiring
        ? `5xx rate ${budgetObserved}% exceeds the ${thresholds.fiveXxRatePctMax}% budget ` +
          `(${totals.byStatus['5xx']} of ${totals.requests} requests)`
        : `5xx rate ${budgetObserved}% within the ${thresholds.fiveXxRatePctMax}% budget`;
    }
  }

  // ── rule 2: p95 latency bound creep ────────────────────────────────────
  let p95Firing = false;
  const p95Observed = totals.p95Ms;
  let p95Detail: string;
  if (p95Observed === null || p95Observed === undefined) {
    p95Detail = 'no latency samples yet — rule not evaluable';
  } else {
    p95Firing = p95Observed > thresholds.p95MsMax;
    p95Detail = p95Firing
      ? `p95 estimate ${p95Observed}ms exceeds the ${thresholds.p95MsMax}ms ceiling ` +
        `(histogram nearest-bound estimate — always >= the true value)`
      : `p95 estimate ${p95Observed}ms within the ${thresholds.p95MsMax}ms ceiling`;
  }

  // ── rule 3: route-key cardinality overflow ─────────────────────────────
  const overflowFiring = totals.overflowed === true;
  const overflowRow = snapshot.routes.find((r) => r.route === OVERFLOW_KEY);
  const overflowDetail = overflowFiring
    ? `distinct route keys hit the ${MAX_ROUTE_KEYS} cap; new keys fold into ` +
      `"${OVERFLOW_KEY}" (${overflowRow ? overflowRow.requests : 0} requests there) — ` +
      `per-route telemetry degrades, user traffic does not`
    : `${totals.routeKeys} distinct route keys, cap ${MAX_ROUTE_KEYS}`;

  // ── rule 4: metrics-snapshot writer staleness (session 109) ─────────────
  // The durability rows are the error budget's MEMORY. The age facts come
  // from the caller's SnapshotFreshnessInput (DB-backed on the route/scan
  // rung; absent on the synchronous fold line, which then reports an
  // honest NOT-evaluated verdict rather than guessing).
  let staleFiring = false;
  let staleObserved: number | null = null;
  let staleThreshold = thresholds.snapshotStaleAfterSec ?? 0;
  let staleDetail: string;
  if (!freshness) {
    staleDetail = 'no durability observation supplied — rule not evaluated';
  } else if (!freshness.enabled) {
    staleThreshold = thresholds.snapshotStaleAfterSec ?? 2 * freshness.intervalSec;
    staleDetail =
      'snapshot writer disabled (METRICS_SNAPSHOT_INTERVAL_SEC=0) — rule exempt ' +
      '(durability is opted out by design, nothing can go stale)';
  } else {
    const staleAfterSec = thresholds.snapshotStaleAfterSec ?? 2 * freshness.intervalSec;
    staleThreshold = staleAfterSec;
    const nowMs = freshness.nowMs ?? Date.now();
    if (freshness.lastCapturedAtMs === null) {
      // Zero provable-fresh rows (table never written OR unreadable). Grace
      // counts from API uptime: the FIRST tick is only due intervalSec after
      // boot, so a young process must not page for rows it has not tried to
      // write yet.
      const ageSec = snapshot.uptimeSec;
      staleObserved = ageSec;
      staleFiring = ageSec > staleAfterSec;
      const storeNote = freshness.storeError
        ? 'durability store UNREADABLE (reads failing) and'
        : 'writer enabled but';
      staleDetail = staleFiring
        ? `${storeNote} no snapshot row within the ${staleAfterSec}s grace ` +
          `(interval ${freshness.intervalSec}s, API up ${ageSec}s) — the snapshot ` +
          `writer is silently dead and the error-budget history is not landing`
        : `${storeNote} no stored row yet (API up ${ageSec}s < ${staleAfterSec}s grace, ` +
          `first write due at ${freshness.intervalSec}s)`;
    } else {
      const ageSec = Math.max(0, (nowMs - freshness.lastCapturedAtMs) / 1000);
      staleObserved = round2(ageSec);
      staleFiring = ageSec > staleAfterSec;
      staleDetail = staleFiring
        ? `newest snapshot row is ${staleObserved}s old (> ${staleAfterSec}s ceiling, ` +
          `writer due every ${freshness.intervalSec}s) — the snapshot writer is ` +
          `silently dead and the error-budget history is not landing`
        : `newest snapshot row ${staleObserved}s old within the ${staleAfterSec}s ceiling ` +
          `(writer every ${freshness.intervalSec}s)`;
    }
  }

  // ── rule 5: rate-limit pressure (guard-throttled share, session 123) ────
  // Same min-sample floor as the budget rule: a lone 429 in a ten-request
  // sample is the limiter breathing, not pressure. Observed is the 429
  // share of ALL served responses (throttled is a subset of byStatus['4xx']).
  let rlFiring = false;
  let rlObserved: number | null = null;
  let rlDetail: string;
  const throttled = totals.throttled ?? 0;
  if (totals.requests <= 0) {
    rlDetail = 'no requests sampled yet — rule not evaluable';
  } else if (totals.requests < thresholds.minRequests) {
    rlDetail =
      `429 share ${round2((throttled / totals.requests) * 100)}% over only ${totals.requests} ` +
      `requests (< ${thresholds.minRequests} min sample) — not evaluated`;
  } else {
    rlObserved = round2((throttled / totals.requests) * 100);
    rlFiring = rlObserved > thresholds.rateLimitPctMax;
    rlDetail = rlFiring
      ? `guard-throttled 429s are ${rlObserved}% of served requests ` +
        `(${throttled} of ${totals.requests}), above the ${thresholds.rateLimitPctMax}% ` +
        `ceiling — customers are being turned away faster than the limiter expects`
      : `${throttled} guard-throttled 429s (${rlObserved}%) within the ` +
        `${thresholds.rateLimitPctMax}% ceiling`;
  }

  const rules: AlertRuleResult[] = [
    {
      id: 'error_budget',
      firing: budgetFiring,
      severity: 'error',
      observed: budgetObserved,
      threshold: thresholds.fiveXxRatePctMax,
      detail: budgetDetail,
    },
    {
      id: 'p95_latency',
      firing: p95Firing,
      severity: 'error',
      observed: p95Observed ?? null,
      threshold: thresholds.p95MsMax,
      detail: p95Detail,
    },
    {
      id: 'route_key_overflow',
      firing: overflowFiring,
      severity: 'warning',
      observed: totals.routeKeys,
      threshold: MAX_ROUTE_KEYS,
      detail: overflowDetail,
    },
    {
      id: 'snapshot_stale',
      firing: staleFiring,
      severity: 'warning',
      observed: staleObserved,
      threshold: staleThreshold,
      detail: staleDetail,
    },
    {
      id: 'rate_limit_pressure',
      firing: rlFiring,
      severity: 'warning',
      observed: rlObserved,
      threshold: thresholds.rateLimitPctMax,
      detail: rlDetail,
    },
  ];

  const firingRules = rules.filter((r) => r.firing).map((r) => r.id);
  return {
    generatedAt: snapshot.generatedAt,
    uptimeSec: snapshot.uptimeSec,
    status: firingRules.length > 0 ? 'alerting' : 'ok',
    firingRules,
    thresholds,
    rules,
  };
}

/** Compact verdict for the periodic fold line — no per-rule noise in logs. */
export interface AlertVerdictSummary {
  status: AlertStatus;
  firing: AlertRuleId[];
}

export function summarizeAlerts(report: AlertReport): AlertVerdictSummary {
  return { status: report.status, firing: report.firingRules };
}
