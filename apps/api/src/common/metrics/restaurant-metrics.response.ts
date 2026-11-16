import { ApiProperty } from '@nestjs/swagger';
import { MetricsRouteRowResponse, MetricsStatusClassesResponse } from '../../admin/admin-metrics.response';

/**
 * Response contract for GET /restaurants/:id/metrics (session 98). Mirrors
 * RestaurantTrafficSnapshot in common/metrics/request-metrics.ts EXACTLY —
 * the restaurant-metrics HTTP spec pins a fixture round-trip, and the
 * row/status classes are the SAME objects the admin snapshot documents, so
 * one rename cannot drift across the two views unnoticed.
 *
 * There is deliberately NO global total anywhere in this shape: the
 * OWNER rung only ever sees traffic attributed to the requested restaurant
 * (session 85 decision).
 */

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
    description: 'Honesty marker (same policy as /admin/metrics): totals are cumulative since this API process booted and are NOT persisted per restaurant.',
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
      'incl. menu/orders/reviews sub-routes) count; a bucket is minted by the first 2xx/3xx, errors ' +
      'only top up existing buckets, and the metrics read itself is exempt so polling never inflates the view.',
  })
  routes: MetricsRouteRowResponse[];
}
