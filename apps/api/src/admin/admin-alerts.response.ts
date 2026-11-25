import { ApiProperty } from '@nestjs/swagger';

/**
 * Response contract for GET /admin/alerts. The shapes mirror AlertReport in
 * src/ops/alerts.ts EXACTLY — the admin.controller HTTP spec pins a fixture
 * round-trip so a field renamed on one side without the other fails a test
 * (same contract style as admin-metrics.response.ts, session 80).
 */

export class AlertThresholdsResponse {
  @ApiProperty({
    type: 'number',
    description:
      'Percent of requests allowed to be 5xx before the error_budget rule fires ' +
      '(99.5% availability SLO default: 0.5). Fires STRICTLY above this value.',
  })
  fiveXxRatePctMax: number;

  @ApiProperty({
    type: 'number',
    description: 'Global p95 latency ceiling in ms for the p95_latency rule (histogram estimate).',
  })
  p95MsMax: number;

  @ApiProperty({
    type: 'integer',
    description: 'Minimum total requests before the error_budget rule is evaluated at all.',
  })
  minRequests: number;
  @ApiProperty({
    type: 'number',
    description:
      'Percent of served requests allowed to be guard-throttled 429s before the ' +
      'rate_limit_pressure rule fires (session 123, ALERT_RATE_LIMIT_PCT_MAX, default 5). ' +
      'Fires STRICTLY above this value, over the same minRequests sample floor.',
  })
  rateLimitPctMax: number;
  @ApiProperty({
    type: 'number',
    nullable: true,
    description:
      'snapshot_stale ceiling in seconds; null (default) means "2x the configured ' +
      'METRICS_SNAPSHOT_INTERVAL_SEC, derived at evaluation time". An explicit override ' +
      'comes from ALERT_SNAPSHOT_STALE_AFTER_SEC (positive seconds; 0/garbage fall back to null).',
  })
  snapshotStaleAfterSec: number | null;
  @ApiProperty({
    type: 'number',
    description:
      'restock_repair_backlog ceiling in rows (session Phase 14, ALERT_RESTOCK_BACKLOG_MAX, ' +
      'default 0 = any backlog alerts). Cancelled orders past RESTOCK_REPAIR_GRACE_MINUTES ' +
      'still awaiting stock return fire the rule when the count STRICTLY exceeds this value.',
  })
  restockBacklogMax: number;
  @ApiProperty({
    type: 'integer',
    description:
      'Minimum total email send attempts before the email_delivery_failure rule is evaluated ' +
      '(session 134, ALERT_EMAIL_MIN_ATTEMPTS, default 5 — order mail is sparse, a lone ' +
      'bounce is noise; same small-sample veto as minRequests).',
  })
  emailMinAttempts: number;
  @ApiProperty({
    type: 'number',
    description:
      'Percent of email send attempts allowed to fail before the email_delivery_failure rule ' +
      'fires (session 134, ALERT_EMAIL_FAILURE_PCT_MAX, default 50). Fires STRICTLY above; ' +
      '0 is a legal tightened ceiling meaning "any failed mail alerts".',
  })
  emailFailurePctMax: number;
}

export class AlertRuleResultResponse {
  @ApiProperty({
    type: 'string',
    enum: [
      'error_budget',
      'p95_latency',
      'route_key_overflow',
      'snapshot_stale',
      'rate_limit_pressure',
      'restock_repair_backlog',
      'email_delivery_failure',
    ],
  })
  id: string;

  @ApiProperty({ type: 'boolean' })
  firing: boolean;

  @ApiProperty({
    type: 'string',
    enum: ['error', 'warning'],
    description: 'warning = telemetry degradation (route-key cap); error = user-facing breach.',
  })
  severity: string;

  @ApiProperty({
    type: 'number',
    nullable: true,
    description:
      'The number the verdict rests on (5xx rate % / p95 ms estimate / distinct route keys / ' +
      'snapshot age s / 429 share %); ' +
      'null when the rule is not evaluable (no samples or sample below minRequests).',
  })
  observed: number | null;

  @ApiProperty({
    type: 'number',
    description: 'The threshold observed is compared against (SLO pct / ms ceiling / route-key cap).',
  })
  threshold: number;

  @ApiProperty({ type: 'string', description: 'Human-readable verdict, numbers included.' })
  detail: string;
}

export class AdminAlertsReportResponse {
  @ApiProperty({ type: 'string', description: 'ISO timestamp of the evaluated metrics snapshot.' })
  generatedAt: string;

  @ApiProperty({ type: 'integer', description: 'API uptime in seconds at snapshot time.' })
  uptimeSec: number;

  @ApiProperty({
    type: 'string',
    enum: ['ok', 'alerting'],
    description: 'alerting when ANY rule fires — warnings included (a route-key flood deserves a look).',
  })
  status: string;

  @ApiProperty({
    type: 'string',
    isArray: true,
    enum: ['error_budget', 'p95_latency', 'route_key_overflow', 'snapshot_stale'],
    description: 'Ids of the firing rules; empty when status is ok.',
  })
  firingRules: string[];

  @ApiProperty({ type: AlertThresholdsResponse })
  thresholds: AlertThresholdsResponse;

  @ApiProperty({ type: AlertRuleResultResponse, isArray: true })
  rules: AlertRuleResultResponse[];
}

/**
 * Phase 11 (Ops): GET /admin/alerts/history — the persisted verdict series +
 * the consecutive-alerting streak. Shapes mirror AlertHistoryView /
 * AlertVerdictRecord / AlertStreak in src/common/metrics/alert-verdicts.service.ts
 * EXACTLY (same round-trip pin style as the report above).
 */
export class AlertHistoryWindowResponse {
  @ApiProperty({ type: 'integer', description: 'Requested window in seconds (clamped 60..2592000).' })
  windowSec: number;

  @ApiProperty({ type: 'string', description: 'ISO lower bound of the window.' })
  from: string;

  @ApiProperty({ type: 'string', description: 'ISO upper bound of the window (read time).' })
  to: string;
}

export class AlertVerdictRecordResponse {
  @ApiProperty({ type: 'string', description: 'ISO timestamp of the persisted evaluation (oldest-first in items).' })
  capturedAt: string;

  @ApiProperty({ type: 'string', enum: ['ok', 'alerting'] })
  status: string;

  @ApiProperty({ type: 'string', isArray: true, description: 'Firing rule ids at that evaluation.' })
  firingRules: string[];

  @ApiProperty({
    type: AdminAlertsReportResponse,
    description: 'The FULL report stored for that tick — forensic detail strings included.',
  })
  report: AdminAlertsReportResponse;
}

export class AlertStreakResponse {
  @ApiProperty({
    type: 'integer',
    description: 'Run of consecutive persisted alerting rows counting back from the newest.',
  })
  persistedTrailingAlerting: number;

  @ApiProperty({
    type: 'boolean',
    description:
      'True when the run reached the returned-row cap — the persisted count is then a LOWER BOUND.',
  })
  trailingCapped: boolean;

  @ApiProperty({
    type: 'string',
    enum: ['ok', 'alerting'],
    description: 'The LIVE engine verdict at read time (same evaluation as GET /admin/alerts).',
  })
  currentStatus: string;

  @ApiProperty({
    type: 'integer',
    description:
      'Consecutive alerting evaluations INCLUDING this read: persisted trailing run + 1 while the ' +
      'live verdict is alerting, 0 once it is ok. The alert-scan escalation gate consumes this.',
  })
  alerting: number;
}

export class AdminAlertsHistoryResponse {
  @ApiProperty({ type: 'string', description: 'ISO timestamp of the read.' })
  generatedAt: string;

  @ApiProperty({
    type: 'boolean',
    description: 'Durability writer enabled (shared METRICS_SNAPSHOT_INTERVAL_SEC knob).',
  })
  enabled: boolean;

  @ApiProperty({ type: 'integer', description: 'Configured snapshot tick in seconds.' })
  snapshotIntervalSec: number;

  @ApiProperty({ type: 'integer', description: 'Configured retention in seconds.' })
  retentionSec: number;

  @ApiProperty({ type: AlertHistoryWindowResponse })
  window: AlertHistoryWindowResponse;

  @ApiProperty({ type: 'integer', description: 'Rows returned (<= limit).' })
  returned: number;

  @ApiProperty({
    type: 'boolean',
    description: 'True when the limit capped the window — more rows exist inside it.',
  })
  truncated: boolean;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Newest persisted verdict timestamp; null when off / empty / unreadable.',
  })
  lastCapturedAt: string | null;

  @ApiProperty({
    type: 'boolean',
    description: 'The series read itself FAILED — items are empty, the live streak is still honest.',
  })
  error: boolean;

  @ApiProperty({ type: AlertVerdictRecordResponse, isArray: true, description: 'Oldest-first.' })
  items: AlertVerdictRecordResponse[];

  @ApiProperty({ type: AlertStreakResponse })
  streak: AlertStreakResponse;
}
