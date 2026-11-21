import { ApiProperty } from '@nestjs/swagger';
import { MetricsRouteRowResponse, MetricsStatusClassesResponse, MetricsWindowResponse } from '../../admin/admin-metrics.response';

/**
 * Response contract for GET /restaurants/:id/metrics (session 98, durability
 * extras session 116). Mirrors the route payload —
 * RestaurantTrafficSnapshot in common/metrics/request-metrics.ts plus the
 * additive `durability` block — EXACTLY; the restaurant-metrics HTTP spec
 * pins a fixture round-trip, and the row/status classes are the SAME
 * objects the admin snapshot documents, so one rename cannot drift across
 * the two views unnoticed.
 *
 * There is deliberately NO global traffic total anywhere in this shape:
 * the OWNER rung only ever sees traffic attributed to the requested
 * restaurant (session 85 decision). Session 116 extends that rule to
 * durability METADATA too: the scoped block below carries no `stored`
 * global row count — its window is subtracted strictly inside this
 * restaurant's bucket.
 */

export class RestaurantMetricsDurabilityResponse {
  @ApiProperty({ type: 'boolean', description: 'False when METRICS_SNAPSHOT_INTERVAL_SEC=0 — no writes, no DB reads.' })
  enabled: boolean;
  @ApiProperty({ type: 'integer', description: 'Resolved snapshot cadence in seconds (default 300; garbage falls back, never crash-boots).' })
  snapshotIntervalSec: number;
  @ApiProperty({ type: 'integer', description: 'Rows older than this many seconds are pruned on every write (default 86400).' })
  retentionSec: number;
  @ApiProperty({ type: 'string', format: 'date-time', description: 'ISO timestamp of the LIVE registry boot — rows stamped differently can never form a window.' })
  bootStartedAt: string;
  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'capturedAt of the newest stored row; null when none / disabled / error.' })
  lastCapturedAt: string | null;
  @ApiProperty({
    type: 'boolean',
    nullable: true,
    description: 'True = the newest row was written by THIS boot (window computable). False = it predates this boot. null = no rows / disabled / error.',
  })
  bootAligned: boolean | null;
  @ApiProperty({ type: 'boolean', description: 'False = the baseline row predates restaurant-dimension persistence (session 116); window stays null.' })
  restaurantsPersisted: boolean;
  @ApiProperty({ type: 'boolean', description: 'True = this restaurant bucket was minted AFTER the baseline row, so the window rides an honest zero baseline anchored at the row instant (it covers every sample this bucket ever took).' })
  mintedAfterBaseline: boolean;
  @ApiProperty({ type: 'boolean', description: 'The snapshot store could not be read on this call — the route STILL 200s with the live bucket (a dead smoke detector never 5xxs).' })
  error: boolean;
  @ApiProperty({
    type: () => MetricsWindowResponse,
    nullable: true,
    description:
      'Window delta over THIS restaurant bucket since the newest SAME-BOOT stored snapshot row ' +
      '(nested because the top-level `window` key is the honesty-marker string). Same subtraction ' +
      'engine as the admin window, same monotonicity refusals: null when disabled, no rows, a ' +
      'cross-boot baseline, a pre-session-116 row, an operator-corrupted entry, or a negative pair.',
  })
  window: MetricsWindowResponse | null;
}

export class RestaurantMetricsTotalsResponse {
  @ApiProperty({ type: 'integer' })
  requests: number;
  @ApiProperty({ type: () => MetricsStatusClassesResponse })
  byStatus: MetricsStatusClassesResponse;
  @ApiProperty({ type: 'integer', description: 'Distinct route keys inside THIS restaurant bucket (excludes the "other" overflow bucket).' })
  routeKeys: number;
  @ApiProperty({ type: 'boolean', description: 'True if the per-bucket route-key cap ever tripped (unreachable with the current template surface; the global registry folds too).' })
  overflowed: boolean;
  @ApiProperty({ type: 'number', nullable: true })
  avgMs: number | null;
  @ApiProperty({ type: 'number', nullable: true, description: 'Histogram-estimated percentile (nearest bound >= true value); null when no samples.' })
  p50Ms: number | null;
  @ApiProperty({ type: 'number', nullable: true })
  p95Ms: number | null;
  @ApiProperty({ type: 'number', nullable: true })
  p99Ms: number | null;
  @ApiProperty({ type: 'number', nullable: true })
  maxMs: number | null;
}

export class RestaurantMetricsResponse {
  @ApiProperty({ type: 'string', format: 'uuid', description: 'Lowercased restaurant id this view is scoped to.' })
  restaurantId: string;
  @ApiProperty({
    type: 'string',
    enum: ['restaurant'],
    description: 'Constant discriminator: this payload is a restaurant view, NEVER the global snapshot.',
  })
  scope: 'restaurant';
  @ApiProperty({
    type: 'string',
    enum: ['since_api_boot'],
    description: 'Honesty marker for the totals/routes fields of THIS payload (they are cumulative since this API process booted). Per-restaurant WINDOWED deltas live nested under `durability.window` — this top-level string is the session-98 contract and stays byte-identical.',
  })
  window: 'since_api_boot';
  @ApiProperty({ type: 'string', format: 'date-time' })
  generatedAt: string;
  @ApiProperty({ type: 'integer', description: 'Seconds since the registry was created (≈ process boot).' })
  uptimeSec: number;
  @ApiProperty({ type: 'integer', isArray: true, description: 'Histogram bucket upper bounds in ms; the +Inf bucket follows.' })
  boundsMs: number[];
  @ApiProperty({ type: () => RestaurantMetricsTotalsResponse })
  totals: RestaurantMetricsTotalsResponse;
  @ApiProperty({
    type: () => MetricsRouteRowResponse,
    isArray: true,
    description:
      'Matched-template rows inside this restaurant only, sorted by request count desc, then route. ' +
      'Attribution: only routes whose MATCHED TEMPLATE is restaurant-scoped (/api/restaurants/:id/... ' +
      'incl. menu/orders/reviews sub-routes) count; a bucket is minted by the first 2xx, 304 ' +
      'revalidations and errors ' +
      'only top up existing buckets, and the metrics read itself is exempt so polling never inflates the view.',
  })
  routes: MetricsRouteRowResponse[];
  @ApiProperty({
    type: () => RestaurantMetricsDurabilityResponse,
    description:
      'Additive durability layer (session 116): the restaurant dimension now rides the same ' +
      '`metrics_snapshots` rows as the global view, so this block exposes boot alignment + a ' +
      'windowed delta computed STRICTLY inside this restaurant\'s bucket. No global row count, ' +
      'no global totals — the scoped shape is the OWNER-rung safety contract, pinned by the ' +
      'restaurant-metrics HTTP spec key-set.',
  })
  durability: RestaurantMetricsDurabilityResponse;
}
