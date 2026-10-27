import {
  Body,
  Controller,
  Get,
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
  NextStatusesResponse,
  OrderResponse,
  PaginatedOrdersResponse,
} from '../common/swagger-response-models';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
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
    return this.service.cancel(id, user.sub);
  }

  @Get(':id')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'One order incl. line items (public by id — order number receipt view)', description: 'No auth: this powers the post-checkout receipt page for guest orders. It exposes only that one order\u2019s snapshot.' })
  @ApiOkResponse({ type: OrderResponse, description: 'Includes the embedded restaurant summary.' })
  @ApiError(400, 'Malformed (non-UUID) order id.')
  @ApiError(404, 'Unknown order id.')
  one(@UuidParam('id') id: string) {
    return this.service.findOne(id);
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
  updateStatus(@UuidParam('id') id: string, @Query('status') status: OrderStatus) {
    return this.service.updateStatus(id, status);
  }

}
