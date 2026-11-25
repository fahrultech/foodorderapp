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
 * The 6th rule needs the SAME caller-supplied treatment (Phase 14): its
 * observation is a DB count of orphaned cancelled orders, so the ADMIN pull
 * route and the persisted-verdict tick pass `RestockBacklogInput` and the
 * synchronous fold line reports an honest "not evaluated".
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
 *   - restock_repair_backlog (Phase 14): the session-73 repair pass returns
 *     stock units for cancelled orders whose restock transaction never
 *     committed (crash between the status commit and the restock commit),
 *     but only when a scheduler actually RUNS it. Between runs the backlog
 *     is invisible. The caller supplies a DB count of orphans past the
 *     repair grace; the rule fires when it STRICTLY exceeds
 *     ALERT_RESTOCK_BACKLOG_MAX (default 0 — a healthy repair chain drains
 *     every orphan it can see, so any backlog at all means the scheduler is
 *     not running, is slower than the grace window, or is capped, and
 *     reserved stock stays locked). WARNING severity: nothing user-facing
 *     has failed yet — a human action (or cron) is late.
 *   - email_delivery_failure (session 134): MailService.send failures used
 *     to vanish into a log line — a dead SMTP relay stayed invisible between
 *     a support ticket and the log tail. The registry now tallies email
 *     attempts + failures per channel (totals.mail), so the rule is fully
 *     SNAPSHOT-DERIVED: the ADMIN pull, the periodic fold line and
 *     alert-scan all evaluate it with ZERO extra observations. Fires when
 *     the failure share STRICTLY exceeds ALERT_EMAIL_FAILURE_PCT_MAX
 *     (default 50 — a majority of mail not landing means the relay is
 *     dead/broken, scattered single failures are relays breathing) over at
 *     least ALERT_EMAIL_MIN_ATTEMPTS sends (default 5; order notifications
 *     are sparse, the same small-sample veto as the budget rule's floor).
 *     ERROR severity: unlike the warning class (telemetry/config degrade,
 *     users don't), a lit rule here means receipts and status notices are
 *     NOT reaching customers — a real feature outage, just off the request
 *     path.
 *
 * Cumulative-since-boot caveat inherited from the registry (session 85):
 * an early 5xx burst keeps the budget rule lit until traffic dilutes it.
 * That is deliberate v1 behaviour (same data source as /admin/metrics);
 * snapshot persistence for true windows is the next Phase 8 Ops item.
 */

import {
  MAIL_CHANNELS,
  MAX_ROUTE_KEYS,
  MetricsSnapshot,
  OVERFLOW_KEY,
} from '../common/metrics/request-metrics';

export type AlertRuleId =
  | 'error_budget'
  | 'p95_latency'
  | 'route_key_overflow'
  | 'snapshot_stale'
  | 'rate_limit_pressure'
  | 'restock_repair_backlog'
  | 'email_delivery_failure';
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

/**
 * The repair-backlog observation the restock_repair_backlog rule needs
 * (Phase 14). Supplied by the ADMIN pull route and the persisted-verdict
 * tick; the synchronous fold line has no DB handle and omits it.
 *
 * `backlog` reuses the session-73 orphan predicate EXACTLY (cancelled +
 * NULL marker + non-empty snapshot + past the grace window), counted over
 * the WHOLE table rather than capped at one batch — a backlog larger than
 * RESTOCK_REPAIR_BATCH must still alert, that is the point.
 */
export interface RestockBacklogInput {
  /** Orphan count over the whole table (no batch cap); null when unreadable. */
  backlog: number | null;
  /** Grace window applied to the count, minutes (mirrors the repair config). */
  graceMinutes: number;
  /** The count read FAILED — reported as "unreadable", never as a zero. */
  storeError?: boolean;
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
  /**
   * Maximum orphaned-cancelled orders past the repair grace the
   * restock_repair_backlog rule tolerates before firing (Phase 14).
   * Default 0 = "any backlog alerts": the repair chain drains every orphan
   * it can see, so a non-empty backlog means the scheduler is dead, slow or
   * capped. Fires STRICTLY above; integer semantics (rows, not percent).
   */
  restockBacklogMax: number;
  /**
   * Minimum total email attempts before the email_delivery_failure rule is
   * evaluated at all (session 134). Order notifications are sparse — one
   * failed send out of two is a flaky relay hiccup, not an outage signal.
   */
  emailMinAttempts: number;
  /**
   * Percent (0-100) of email send failures allowed within the sample before
   * the email_delivery_failure rule fires (session 134). Fires STRICTLY
   * above it; 0 is legal — "any failed mail alerts" — for operators
   * proving the chain (the same tightened-ceiling policy as the pct knobs
   * above).
   */
  emailFailurePctMax: number;
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
  // Any backlog alerts (see AlertThresholds.restockBacklogMax). The alert
  // fires only for rows OLDER than the repair grace window, so a healthy
  // chain that simply has not run its next tick yet stays quiet; 0 is a
  // legal tightened ceiling and 5 legal noise tolerance for fleets whose
  // repair cron runs slower than the grace window. Tune with
  // ALERT_RESTOCK_BACKLOG_MAX.
  restockBacklogMax: 0,
  // Mail telemetry (session 134): evaluate only once 5 sends were attempted
  // (order mail is sparse; a lone bounce is noise — the small-sample veto
  // mirrors ALERT_MIN_REQUESTS), and fire above a 50% failure share (a dead
  // relay fails ~100%; scattered single failures under half stay quiet).
  // Tighten to 0/1 to prove the chain. Tune with ALERT_EMAIL_MIN_ATTEMPTS /
  // ALERT_EMAIL_FAILURE_PCT_MAX.
  emailMinAttempts: 5,
  emailFailurePctMax: 50,
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
    // Whole-rows ceiling: thresholdNumber keeps the floor-0 policy (garbage/
    // negative/blank fall back, 0 is legal and IS the default), floor() folds
    // a fractional 2.9 into 2 like ALERT_MIN_REQUESTS does.
    restockBacklogMax: Math.floor(
      thresholdNumber(env.ALERT_RESTOCK_BACKLOG_MAX, DEFAULT_ALERT_THRESHOLDS.restockBacklogMax, 0),
    ),
    // Mail telemetry (session 134): attempts floor uses the positive-int
    // policy (0/fractional/garbage collapse to the default — a zero floor
    // would judge the very first send, same call as ALERT_MIN_REQUESTS);
    // the pct ceiling keeps the tightened-0 policy (0 = "any failed mail
    // alerts", legal for proving the chain).
    emailMinAttempts: positiveIntThreshold(env.ALERT_EMAIL_MIN_ATTEMPTS, DEFAULT_ALERT_THRESHOLDS.emailMinAttempts),
    emailFailurePctMax: thresholdNumber(
      env.ALERT_EMAIL_FAILURE_PCT_MAX,
      DEFAULT_ALERT_THRESHOLDS.emailFailurePctMax,
      0,
    ),
  };
}

/** THE evaluation — one implementation, every consumer shares it. */
export function evaluateAlerts(
  snapshot: MetricsSnapshot,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
  freshness?: SnapshotFreshnessInput | null,
  restock?: RestockBacklogInput | null,
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

  // ── rule 6: restock-repair backlog (Phase 14) ──────────────────────────
  // Orphaned cancelled orders = stock units still reserved although the
  // order is cancelled. The repair pass (cron + ADMIN route) drains them
  // through the session-73 predicate; between runs nothing else sees them.
  // Same caller-supplied-observation doctrine as snapshot_stale: no
  // observation (the synchronous fold line) or an unreadable count is an
  // honest NOT-evaluated — never a false fire, never a fabricated zero.
  let rbFiring = false;
  let rbObserved: number | null = null;
  let rbDetail: string;
  if (!restock) {
    rbDetail = 'no repair-backlog observation supplied — rule not evaluated';
  } else if (restock.storeError || restock.backlog === null) {
    rbDetail =
      `orders repair backlog UNREADABLE (count failed) — rule not evaluated ` +
      `(grace ${restock.graceMinutes}min)`;
  } else {
    rbObserved = restock.backlog;
    rbFiring = restock.backlog > thresholds.restockBacklogMax;
    rbDetail = rbFiring
      ? `${restock.backlog} cancelled order(s) past the ${restock.graceMinutes}min repair ` +
        `grace still await restock, above the ${thresholds.restockBacklogMax} ceiling — the ` +
        `restock-repair scheduler is not draining the backlog and their stock stays reserved`
      : `${restock.backlog} past-grace orphans within the ${thresholds.restockBacklogMax} ` +
        `ceiling (grace ${restock.graceMinutes}min)`;
  }

  // ── rule 7: mail delivery failures (registry totals, session 134) ──────
  // Fully SNAPSHOT-DERIVED (unlike rules 4/6 there is no DB observation):
  // MailService.recordMail folds every real attempt/failure into the same
  // registry the other rules read, so the ADMIN pull, the synchronous fold
  // line and alert-scan all evaluate it identically. An absent totals.mail
  // (a hand-built or pre-134 snapshot) is an honest NOT-evaluated, never a
  // fabricated zero.
  let mdFiring = false;
  let mdObserved: number | null = null;
  let mdDetail: string;
  const mail = totals.mail;
  const mailAttempts = mail ? MAIL_CHANNELS.reduce((s, c) => s + mail[c].attempts, 0) : 0;
  const mailFailures = mail ? MAIL_CHANNELS.reduce((s, c) => s + mail[c].failures, 0) : 0;
  if (!mail) {
    mdDetail = 'no mail tallies in this snapshot — rule not evaluated';
  } else if (mailAttempts === 0) {
    mdDetail = 'no email sends attempted yet — rule not evaluable';
  } else if (mailAttempts < thresholds.emailMinAttempts) {
    mdDetail =
      `mail failure ${round2((mailFailures / mailAttempts) * 100)}% over only ${mailAttempts} ` +
      `sends (< ${thresholds.emailMinAttempts} min attempts) — not evaluated`;
  } else {
    mdObserved = round2((mailFailures / mailAttempts) * 100);
    mdFiring = mdObserved > thresholds.emailFailurePctMax;
    mdDetail = mdFiring
      ? `${mailFailures} of ${mailAttempts} email sends failed (${mdObserved}%), above the ` +
        `${thresholds.emailFailurePctMax}% ceiling — order notifications are NOT reaching ` +
        `customers (check the SMTP relay)`
      : `${mailFailures}/${mailAttempts} email sends failed (${mdObserved}%) within the ` +
        `${thresholds.emailFailurePctMax}% ceiling`;
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
    {
      id: 'restock_repair_backlog',
      firing: rbFiring,
      severity: 'warning',
      observed: rbObserved,
      threshold: thresholds.restockBacklogMax,
      detail: rbDetail,
    },
    {
      id: 'email_delivery_failure',
      firing: mdFiring,
      severity: 'error',
      observed: mdObserved,
      threshold: thresholds.emailFailurePctMax,
      detail: mdDetail,
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
