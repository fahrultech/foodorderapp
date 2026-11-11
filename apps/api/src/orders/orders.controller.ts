import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UuidParam } from '../common/uuid';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiError,
  CancelStaleResponse,
  NextStatusesResponse,
  OrderResponse,
  PaginatedOrdersResponse,
  RestockRepairResponse,
} from '../common/swagger-response-models';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { CancelStaleDto } from './dto/cancel-stale.dto';
import { RestockRepairDto } from './dto/restock-repair.dto';
import { ListMyOrdersDto } from './dto/list-my-orders.dto';
import { OrderStatus } from './order.entity';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/optional-jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { UserRole } from '../users/user.entity';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { RateLimit } from '../common/rate-limit/rate-limit.decorator';

@Controller('orders')
@ApiTags('orders')
export class OrdersController {
  constructor(private readonly service: OrdersService) {}

  /**
   * Guest checkout allowed. When a valid access token is present the order is
   * attached to that user (enables /orders/my + self-cancellation); invalid or
   * expired tokens silently fall back to guest — checkout must never break on
   * a stale session.
   * Rate limit runs FIRST: spam order creation must be shed before pricing.
   */
  @Post()
  @RateLimit('orders')
  @UseGuards(RateLimitGuard, OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Place an order (guest checkout allowed)', description: 'Prices, delivery fee, min-order and promo are all recomputed server-side — client totals are never trusted. With a valid bearer token the order is attached to the caller (enables /orders/my + self-cancel); invalid tokens silently fall back to guest. Rate-limited per IP; below min-order or illegal carts answer 400.' })
  @ApiCreatedResponse({ type: OrderResponse, description: 'Nest default POST status. Fully server-priced order with snapshot line items.' })
  @ApiError(400, 'Unknown/unavailable line items, quantity outside 1..50, items from another restaurant, below min-order, or a rejected promo code.')
  @ApiError(404, 'Restaurant id validly shaped but unknown.')
  @ApiError(429, 'Orders rate limit exceeded; Retry-After header says when to retry.')
  create(@Body() dto: CreateOrderDto, @CurrentUser() user?: any) {
    return this.service.create(dto, user?.sub);
  }

  @Get('my')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My order history (paginated, newest first)' })
  @ApiOkResponse({ type: PaginatedOrdersResponse })
  @ApiError(401, 'Missing/invalid/expired access token.')

  my(@CurrentUser() user: any, @Query() query: ListMyOrdersDto) {
    return this.service.findMine(user.sub, query);
  }

  /** Customer cancels their own order while the status machine still permits it. */
  @Post(':id/cancel')
  @RateLimit('orders')
  @UseGuards(RateLimitGuard, JwtAuthGuard)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Cancel my order (while still cancellable)', description: 'Allowed until the order is out for delivery: pending/confirmed/preparing may move to cancelled; anything later answers 400. Foreign or unknown ids answer the same 404 (no existence leak). Rate-limited per IP.' })
  @ApiCreatedResponse({ type: OrderResponse, description: 'The cancelled order. Nest default POST status is 201.' })
  @ApiError(400, 'Order already delivering/completed/cancelled — no longer cancellable; a malformed (non-UUID) id also answers 400.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(404, 'Unknown order id or an order belonging to another customer (guest orders cannot be cancelled either).')
  @ApiError(429, 'Orders rate limit exceeded.')
  cancel(@UuidParam('id') id: string, @CurrentUser() user: any) {
    return this.service.cancel(id, user.sub, user.role, user.email);
  }

    /**
   * The receipt view (Phase 6 ownership fix). No longer open to whoever
   * knows the uuid: a bearer token unlocks it for the order's own customer
   * (and for ADMIN oversight); a guest must present the order's stored
   * contact email as `?contactEmail=`. Everything else gets the plain 404 —
   * unknown ids and failed proofs are indistinguishable (no existence leak).
   */
  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'contactEmail', required: false, description: 'Guest proof: the email given at checkout, compared case-insensitively. Unnecessary when a bearer token already identifies the owner (or an ADMIN).' })
  @ApiOperation({ summary: 'One order incl. line items — owner bearer, ADMIN, or the checkout contact-email proof', description: 'Powers the post-checkout receipt. A valid access token for the customer who owns the order (or any ADMIN) unlocks it; without one the caller must present contactEmail matching what was stored at checkout. Wrong or missing proof answers the same 404 as an unknown id — the uuid alone no longer reads a receipt.' })
  @ApiOkResponse({ type: OrderResponse, description: 'Includes the embedded restaurant summary.' })
  @ApiError(400, 'Malformed (non-UUID) order id.')
  @ApiError(404, 'Unknown order id, or the caller is neither the owner nor an admin, and did not present the stored contact email (existence is never confirmed).')
  one(
    @UuidParam('id') id: string,
    @CurrentUser() user?: any,
    @Query('contactEmail') contactEmail?: string,
  ) {
    return this.service.findOneForViewer(
      id,
      user ? { sub: user.sub, role: user.role } : undefined,
      contactEmail,
    );
  }

  @Get(':id/next-statuses')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Statuses legally reachable from the order\u2019s current one' })
  @ApiOkResponse({ type: NextStatusesResponse })
  @ApiError(400, 'Malformed (non-UUID) order id.')
  @ApiError(404, 'Unknown order id.')
  async next(@UuidParam('id') id: string) {
    return { next: await this.service.nextStatuses(id) };
  }

  /**
   * Generic status transition — ADMIN only since Phase 2. Owner-portal
   * actions go through PATCH /restaurants/:id/orders/:orderId/status, which
   * scopes the write to the caller's restaurants; this route stays as the
   * ops backdoor and used to be completely unauthenticated.
   */
  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'status', enum: OrderStatus, description: 'Target status; illegal transitions answer 400' })
  @ApiOperation({ summary: 'Admin: force a status transition', description: 'Ops backdoor (ADMIN role required). Owner-portal transitions go through PATCH /restaurants/:id/orders/:orderId/status instead.' })
  @ApiOkResponse({ type: OrderResponse })
  @ApiError(400, 'Illegal transition from the current status, or the path id is not a UUID.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not ADMIN.')
  @ApiError(404, 'Unknown order id.')
  updateStatus(
    @UuidParam('id') id: string,
    @Query('status') status: OrderStatus,
    @CurrentUser() user: any,
  ) {
    return this.service.updateStatus(id, status, {
      sub: user.sub,
      role: user.role,
      email: user.email,
    });
  }

  /**
   * Ops sweep (ADMIN only): auto-cancel abandoned `pending` orders. This is
   * the same logic the `ops/cancel-stale.sh` cron runs, exposed over HTTP so an
   * operator can drain the backlog (or dry-check the window) against a live
   * API — and, unlike the standalone script, cancellations here push `order.updated`
   * to any connected owner-inbox SSE stream. Overrides are optional; omitting
   * them uses STALE_ORDER_MINUTES / STALE_ORDER_BATCH.
   */
  @Post('ops/cancel-stale')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin: auto-cancel stale pending orders', description: 'Sweeps pending orders older than the abandonment window (default STALE_ORDER_MINUTES=45) to cancelled — the machine path for guest checkouts nobody acted on. Only `pending` is touched; confirmed/preparing/delivering are human decisions. Returns how many were cancelled and whether the batch cap was hit (re-run to drain a larger backlog). ADMIN role required.' })
  @ApiOkResponse({ type: CancelStaleResponse, description: 'Sweep report for this run.' })
  @ApiError(400, 'staleMinutes or limit out of bounds / not an integer.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not ADMIN.')
  cancelStale(@Body() dto?: CancelStaleDto) {
    return this.service.cancelStalePending({
      staleMinutes: dto?.staleMinutes,
      limit: dto?.limit,
    });
  }

  /**
   * Ops repair (ADMIN only): return reserved units for cancelled orders the
   * restock pass missed — the crash window between the status commit and the
   * restock transaction. Same shared exactly-once code as the standalone
   * `ops/restock-repair.sh` cron; re-running is always safe.
   */
  @Post('ops/restock-repair')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin: repair stock missed by cancelled-order restocks', description: 'Sweeps cancelled orders that carry a non-NULL stockDecrements snapshot but a NULL stockRestockedAt (the crash window between the status commit and the restock transaction) and returns their reserved units — the exactly-once marker CAS makes re-runs and concurrency safe. Only orders untouched for the grace window (default RESTOCK_REPAIR_GRACE_MINUTES=10) are considered, so a healthy in-flight cancel is never raced. Orders with a NULL/empty snapshot are never touched (nothing was decremented). Returns scanned/repaired/skipped counts and per-order units. ADMIN role required.' })
  @ApiOkResponse({ type: RestockRepairResponse, description: 'Repair report for this run.' })
  @ApiError(400, 'graceMinutes or limit out of bounds / not an integer.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Valid token but role is not ADMIN.')
  restockRepair(@Body() dto?: RestockRepairDto) {
    return this.service.restockRepair({
      graceMinutes: dto?.graceMinutes,
      limit: dto?.limit,
    });
  }
}
