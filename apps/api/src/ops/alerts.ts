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

export type AlertRuleId = 'error_budget' | 'p95_latency' | 'route_key_overflow';
export type AlertSeverity = 'error' | 'warning';
export type AlertStatus = 'ok' | 'alerting';

export interface AlertThresholds {
  /** Percent (0-100). Rule fires when the 5xx rate STRICTLY exceeds it. */
  fiveXxRatePctMax: number;
  /** Milliseconds. Fires when the global p95 estimate STRICTLY exceeds it. */
  p95MsMax: number;
  /** Minimum total requests before the budget rule is evaluated at all. */
  minRequests: number;
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
};

export interface AlertRuleResult {
  id: AlertRuleId;
  firing: boolean;
  severity: AlertSeverity;
  /**
   * The number the verdict rests on: 5xx rate in percent / p95 ms estimate /
   * distinct route keys. Null when not evaluable (no samples yet, or the
   * sample is below `minRequests`).
   */
  observed: number | null;
  /** The threshold `observed` is compared against (SLO pct / ms / key cap). */
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
    minRequests: positiveIntThreshold(env.ALERT_MIN_REQUESTS, DEFAULT_ALERT_THRESHOLDS.minRequests),
  };
}

/** THE evaluation — one implementation, every consumer shares it. */
export function evaluateAlerts(
  snapshot: MetricsSnapshot,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
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
