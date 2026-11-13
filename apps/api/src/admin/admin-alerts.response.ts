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
}

export class AlertRuleResultResponse {
  @ApiProperty({
    type: 'string',
    enum: ['error_budget', 'p95_latency', 'route_key_overflow'],
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
      'The number the verdict rests on (5xx rate % / p95 ms estimate / distinct route keys); ' +
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
    enum: ['error_budget', 'p95_latency', 'route_key_overflow'],
    description: 'Ids of the firing rules; empty when status is ok.',
  })
  firingRules: string[];

  @ApiProperty({ type: AlertThresholdsResponse })
  thresholds: AlertThresholdsResponse;

  @ApiProperty({ type: AlertRuleResultResponse, isArray: true })
  rules: AlertRuleResultResponse[];
}
