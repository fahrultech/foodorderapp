import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { UuidParam } from '../common/uuid';
import { ApiError } from '../common/swagger-response-models';
import { RestaurantMetricsResponse } from '../common/metrics/restaurant-metrics.response';
import { RequestMetricsService } from '../common/metrics/request-metrics.service';
import { MetricsPersistenceService } from '../common/metrics/metrics-persistence.service';
import { RestaurantsService } from './restaurants.service';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { UserRole } from '../users/user.entity';

/**
 * Phase 8 "per-restaurant traffic for owners" (session 98): OWNER-scoped
 * read over the request-metrics registry's restaurant dimension.
 *
 * The session-85 decision is enforced TWICE over:
 *  1. the payload is built EXCLUSIVELY from the requested restaurant's
 *     bucket — there is no field here carrying global totals at all;
 *  2. the ownership ladder (same getOwned path as updateOwned) means a
 *     caller can only ever address their own restaurant (admins bypass).
 *
 * Honesty policy matches GET /admin/metrics: the totals/routes fields are
 * cumulative SINCE API BOOT. Session 116 closed the last gap of that
 * policy: the restaurant dimension now rides the persisted
 * `metrics_snapshots` rows too, and an additive `durability` block exposes
 * a windowed delta computed STRICTLY inside the requested bucket — no
 * global totals, no global row count (the session-85 rule extends from
 * traffic to telemetry metadata). Unattributed traffic (auth, browse-list,
 * order-scoped routes without a restaurant path param) lives only in the
 * ADMIN-visible global view. The metrics read itself is exempt from
 * attribution, so a dashboard polling this route never inflates its own
 * numbers.
 */
@Controller('restaurants/:id')
@ApiTags('restaurants')
export class RestaurantMetricsController {
  constructor(
    private readonly restaurants: RestaurantsService,
    private readonly metrics: RequestMetricsService,
    private readonly persistence: MetricsPersistenceService,
  ) {}

  @Get('metrics')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({
    summary: 'Owner: per-restaurant request traffic (cumulative since boot + durability window)',
    description:
      'OWNER required (admins bypass). Restaurant-scoped view of the request-metrics registry: ' +
      'matched-template rows, status-class tallies and duration histograms for requests ATTRIBUTED ' +
      'to this restaurant (routes under /api/restaurants/:id/... incl. the :restaurantId menu variant). ' +
      'A bucket is minted by the first 2xx so uuid probes never create views; 304 revalidations and ' +
      'later 4xx/5xx on ' +
      'the same surface still count. Cumulative since this API process booted, PLUS the additive ' +
      '`durability` block (session 116): the restaurant dimension rides the same snapshot rows as ' +
      'the global view, so `durability.window` carries the windowed delta since the newest same-boot ' +
      'row, subtracted strictly inside this bucket. The global snapshot (all restaurants + unscoped ' +
      'traffic) and the global row count are ADMIN-only and never appear here.',
  })
  @ApiOkResponse({ type: RestaurantMetricsResponse })
  @ApiError(400, 'Malformed (non-UUID) restaurant id.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not OWNER, or the restaurant belongs to another owner (admins bypass).')
  @ApiError(404, 'Unknown restaurant id.')
  async traffic(@UuidParam('id') id: string, @CurrentUser() user: any) {
    await this.restaurants.getOwned(id, { sub: user.sub, role: user.role });
    const live = this.metrics.restaurantTraffic(id);
    // Additive extras, store failures included: describeRestaurant NEVER
    // throws, so a broken durability store degrades the block (error=true,
    // window=null) and can never turn this read into a 5xx.
    const durability = await this.persistence.describeRestaurant(id, live);
    return { ...live, durability };
  }
}
