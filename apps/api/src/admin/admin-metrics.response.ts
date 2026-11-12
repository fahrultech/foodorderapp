import { ApiProperty } from '@nestjs/swagger';

/**
 * Response contract for GET /admin/metrics. The shapes mirror
 * MetricsSnapshot in common/metrics/request-metrics.ts EXACTLY — the
 * admin.controller HTTP spec pins a fixture round-trip so a field renamed
 * on one side without the other fails a test.
 */

export class MetricsStatusClassesResponse {
  @ApiProperty({ type: 'integer', description: 'Responses 200-299.' })
  '2xx': number;
  @ApiProperty({ type: 'integer', description: 'Responses 300-399.' })
  '3xx': number;
  @ApiProperty({ type: 'integer', description: 'Responses 400-499.' })
  '4xx': number;
  @ApiProperty({ type: 'integer', description: 'Responses >=500 — the alerting signal.' })
  '5xx': number;
}

export class MetricsHistogramBucketResponse {
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Inclusive upper bound in ms (cumulative count of requests at most this slow); null = the +Inf bucket.',
  })
  leMs: number | null;
  @ApiProperty({ type: 'integer' })
  count: number;
}

export class MetricsRouteRowResponse {
  @ApiProperty({
    type: 'string',
    description: 'METHOD + matched route template, e.g. "GET /api/orders/:id". Unmatched paths collapse dynamic segments; "other" is the cardinality-cap overflow bucket.',
  })
  route: string;
  @ApiProperty({ type: 'integer' })
  requests: number;
  @ApiProperty({ type: () => MetricsStatusClassesResponse })
  byStatus: MetricsStatusClassesResponse;
  @ApiProperty({ type: 'integer', description: 'Sum of durations in ms (rounded).' })
  sumMs: number;
  @ApiProperty({ type: 'number', description: 'avg = sumMs/requests, one decimal.' })
  avgMs: number;
  @ApiProperty({ type: 'number' })
  minMs: number;
  @ApiProperty({ type: 'number' })
  maxMs: number;
  @ApiProperty({ type: 'number', nullable: true, description: 'Histogram-estimated percentile (nearest bound >= true value); null when no samples.' })
  p50Ms: number | null;
  @ApiProperty({ type: 'number', nullable: true })
  p95Ms: number | null;
  @ApiProperty({ type: 'number', nullable: true })
  p99Ms: number | null;
  @ApiProperty({ type: () => MetricsHistogramBucketResponse, isArray: true })
  histogram: MetricsHistogramBucketResponse[];
}

export class MetricsTotalsResponse {
  @ApiProperty({ type: 'integer' })
  requests: number;
  @ApiProperty({ type: () => MetricsStatusClassesResponse })
  byStatus: MetricsStatusClassesResponse;
  @ApiProperty({ type: 'integer', description: 'Distinct tracked route keys (excludes the "other" overflow bucket).' })
  routeKeys: number;
  @ApiProperty({ type: 'boolean', description: 'True if the route-key cap ever tripped and folded new routes into "other".' })
  overflowed: boolean;
  @ApiProperty({ type: 'number', nullable: true })
  avgMs: number | null;
  @ApiProperty({ type: 'number', nullable: true })
  p50Ms: number | null;
  @ApiProperty({ type: 'number', nullable: true })
  p95Ms: number | null;
  @ApiProperty({ type: 'number', nullable: true })
  p99Ms: number | null;
  @ApiProperty({ type: 'number', nullable: true })
  maxMs: number | null;
}

export class AdminMetricsSnapshotResponse {
  @ApiProperty({ type: 'string', format: 'date-time' })
  generatedAt: string;
  @ApiProperty({ type: 'integer', description: 'Seconds since the registry was created (≈ process boot).' })
  uptimeSec: number;
  @ApiProperty({ type: 'integer', isArray: true, description: 'Histogram bucket upper bounds in ms; the +Inf bucket follows.' })
  boundsMs: number[];
  @ApiProperty({ type: () => MetricsTotalsResponse })
  totals: MetricsTotalsResponse;
  @ApiProperty({ type: () => MetricsRouteRowResponse, isArray: true, description: 'Sorted by request count desc, then route.' })
  routes: MetricsRouteRowResponse[];
}
