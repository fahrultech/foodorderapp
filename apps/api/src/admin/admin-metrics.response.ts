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

export class MetricsDurabilityResponse {
  @ApiProperty({ type: 'boolean', description: 'False when METRICS_SNAPSHOT_INTERVAL_SEC=0 — no writes, no DB reads.' })
  enabled: boolean;
  @ApiProperty({ type: 'integer', description: 'Resolved snapshot cadence in seconds (default 300; garbage falls back, never crash-boots).' })
  snapshotIntervalSec: number;
  @ApiProperty({ type: 'integer', description: 'Rows older than this many seconds are pruned on every write (default 86400).' })
  retentionSec: number;
  @ApiProperty({ type: 'string', format: 'date-time', description: 'ISO timestamp of the LIVE registry boot — rows stamped differently can never form a window.' })
  bootStartedAt: string;
  @ApiProperty({ type: 'integer', nullable: true, description: 'Stored snapshot rows (retention-bounded); null when disabled or the store errored.' })
  stored: number | null;
  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'capturedAt of the newest stored row; null when none / disabled / error.' })
  lastCapturedAt: string | null;
  @ApiProperty({
    type: 'boolean',
    nullable: true,
    description: 'True = newest row was written by THIS boot (window computable). False = row predates this boot. null = no rows / disabled / error.',
  })
  bootAligned: boolean | null;
  @ApiProperty({ type: 'boolean', description: 'The snapshot store could not be read on this call — the route STILL returns 200 with the live snapshot (a dead smoke detector never 5xxs).' })
  error: boolean;
}

export class MetricsWindowRouteResponse {
  @ApiProperty({ type: 'string', description: 'METHOD + matched route template, same key space as the snapshot rows.' })
  route: string;
  @ApiProperty({ type: 'integer', description: 'Requests seen in the WINDOW only (live minus baseline).' })
  requests: number;
  @ApiProperty({ type: () => MetricsStatusClassesResponse })
  byStatus: MetricsStatusClassesResponse;
  @ApiProperty({ type: 'number', nullable: true, description: 'Window avg duration in ms (delta sumMs / delta requests); null when no window samples.' })
  avgMs: number | null;
}

export class MetricsWindowResponse {
  @ApiProperty({ type: 'string', format: 'date-time', description: 'generatedAt of the baseline snapshot row.' })
  fromCapturedAt: string;
  @ApiProperty({ type: 'string', format: 'date-time', description: 'generatedAt of the live snapshot at read time.' })
  toCapturedAt: string;
  @ApiProperty({ type: 'integer', description: 'Window span in whole seconds.' })
  spanSec: number;
  @ApiProperty({ type: 'integer', description: 'Total requests inside the window (live totals minus baseline).' })
  requests: number;
  @ApiProperty({ type: () => MetricsStatusClassesResponse })
  byStatus: MetricsStatusClassesResponse;
  @ApiProperty({
    type: 'number',
    nullable: true,
    description: '5xx share of the window in percent (3 decimals); null when the window saw no requests. The since-boot error budget gets its non-zero-denominator sibling here.',
  })
  fiveXxRatePct: number | null;
  @ApiProperty({ type: 'number', nullable: true, description: 'Window avg duration ms; null when no samples. min/max cannot be subtracted from cumulative tallies and are deliberately absent.' })
  avgMs: number | null;
  @ApiProperty({ type: 'number', nullable: true, description: 'Nearest-bound percentile over the delta histogram; null past the last bound or with no samples.' })
  p50Ms: number | null;
  @ApiProperty({ type: 'number', nullable: true })
  p95Ms: number | null;
  @ApiProperty({ type: 'number', nullable: true })
  p99Ms: number | null;
  @ApiProperty({ type: () => MetricsHistogramBucketResponse, isArray: true, description: 'Cumulative delta histogram (element-wise subtraction of same-boot cumulative buckets).' })
  histogram: MetricsHistogramBucketResponse[];
  @ApiProperty({ type: () => MetricsWindowRouteResponse, isArray: true, description: 'Top 10 routes by WINDOW requests (never concrete ids).' })
  routes: MetricsWindowRouteResponse[];
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
  @ApiProperty({
    type: () => MetricsDurabilityResponse,
    description:
      'Additive durability layer (session 89): snapshot-scheduler config + what the `metrics_snapshots` ' +
      'table currently holds. Survives restarts — this is how the error budget keeps history when the ' +
      'in-process registry silently zeroes.',
  })
  durability: MetricsDurabilityResponse;
  @ApiProperty({
    type: () => MetricsWindowResponse,
    nullable: true,
    description:
      'Additive window delta: exact traffic between the newest SAME-BOOT stored snapshot and this live ' +
      'read. Null when persistence is disabled, no rows exist, the newest row predates this boot ' +
      '(fresh restart — no false cross-boot baseline), the store errored, or subtraction would be negative.',
  })
  window: MetricsWindowResponse | null;
}
