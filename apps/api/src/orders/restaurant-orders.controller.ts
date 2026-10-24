import {
  Controller,
  Get,
  MessageEvent,
  Param,
  Patch,
  Query,
  Sse,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Observable, filter, map, merge, of, timer } from 'rxjs';
import { OrdersService } from './orders.service';
import {
  ORDER_STREAM_HEARTBEAT_MS,
  OrderEventsService,
} from './order-events.service';
import { ListMyOrdersDto } from './dto/list-my-orders.dto';
import { SetOrderStatusDto } from './dto/set-order-status.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { SseJwtAuthGuard } from '../common/sse-jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { UserRole } from '../users/user.entity';

/**
 * Owner portal routes under /api/restaurants/:id/orders — the orders inbox
 * behind the /dashboard page plus its status actions (accept/start/deliver/
 * complete/cancel). Lives in OrdersModule (which already imports
 * RestaurantsModule) so there is no module cycle; the route shape follows the
 * REST resource, not the module layout. Ownership is enforced in
 * OrdersService (admins bypass): the restaurant must belong to the caller and
 * the order must belong to the restaurant in the path.
 */
@Controller('restaurants/:id/orders')
@ApiTags('orders')
export class RestaurantOrdersController {
  constructor(
    private readonly service: OrdersService,
    private readonly events: OrderEventsService,
  ) {}

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Owner inbox: orders of my restaurant (status filter + paging)', description: 'OWNER required (admins bypass). Unknown restaurant or one not owned by the caller answers 404/403. Same ListMyOrdersDto query contract as /orders/my.' })
  list(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Query() query: ListMyOrdersDto,
  ) {
    return this.service.findForRestaurant(id, { sub: user.sub, role: user.role }, query);
  }

  /**
   * Owner status action. `status` is a query param like the generic
   * /orders/:id/status route, validated against the OrderStatus enum by DTO.
   * Same OWNER role gate as the inbox: customer tokens get 403 from
   * RolesGuard, admin tokens pass it and rely on the service-side ownership
   * bypass (admins may action any restaurant's orders).
   */
  @Patch(':orderId/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: 'orderId', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Owner: move one of my restaurant\u2019s orders (accept/start/deliver/complete/cancel)', description: '`status` is a QUERY param validated against the OrderStatus enum (junk → 400 before touching the DB); illegal transitions of a valid status also answer 400. Customer tokens get 403 from RolesGuard; admins pass and rely on the service-side ownership bypass.' })
  setStatus(
    @Param('id') id: string,
    @Param('orderId') orderId: string,
    @CurrentUser() user: any,
    @Query() dto: SetOrderStatusDto,
  ) {
    return this.service.setStatusForRestaurant(
      id,
      orderId,
      dto.status,
      { sub: user.sub, role: user.role },
    );
  }

  /**
   * Live order stream (Phase 2 item "SSE"): GET /restaurants/:id/orders/stream
   * — a server-sent-events channel the owner dashboard subscribes to so new
   * orders and status changes push in (~1s) instead of waiting on the 10s
   * poll. Contract:
   *
   *   event: hello          { restaurantId, serverTime }            — once, on connect
   *   event: order.created  { orderId, code, status }               — any new order
   *   event: order.updated  { orderId, code, status }               — any status move
   *   event: ping           { serverTime }                          — every 15s keep-alive
   *
   * Events are TRIGGER-ONLY: the payload identifies the change but carries no
   * inbox data — the dashboard refetches `GET /restaurants/:id/orders` to get
   * the truth, so a dropped/malformed event costs latency, never correctness.
   * Live-only (no replay): a gap between connect and last poll is covered by
   * the immediate catch-up fetch the client runs on `hello`.
   *
   * Guards: SseJwtAuthGuard (bearer header or ?access_token= for EventSource)
   * + RolesGuard/OWNER (admins pass). Ownership (404 unknown / 403 foreign) is
   * asserted by the async handler BEFORE the observable is returned — Nest
   * awaits async @Sse handlers, so rejections stay ordinary JSON errors and
   * the stream never starts for a caller who could not list the inbox.
   */
  @Sse('stream')
  @UseGuards(SseJwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'access_token', required: false, description: 'EventSource cannot send an Authorization header — pass the JWT here instead (SseJwtAuthGuard accepts either).' })
  @ApiProduces('text/event-stream')
  @ApiOperation({ summary: 'Owner: live order stream (SSE)', description: 'Server-sent events for one restaurant: `hello` on connect, then `order.created` / `order.updated` (id-only payloads — the client refetches the inbox on each event), `ping` every 15s. Live-only, no replay. Ownership is checked before the stream starts, so a caller who could not list the inbox gets an ordinary JSON 403/404 here.' })
  async stream(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ): Promise<Observable<MessageEvent>> {
    await this.service.assertStreamAccess(id, { sub: user.sub, role: user.role });
    const orderEvents = this.events
      .stream()
      .pipe(
        filter((e) => e.restaurantId === id),
        map((e) => ({ type: e.type, data: e.payload } as MessageEvent)),
      );
    const hello: MessageEvent = {
      type: 'hello',
      data: { restaurantId: id, serverTime: new Date().toISOString() },
    };
    const pings = timer(ORDER_STREAM_HEARTBEAT_MS, ORDER_STREAM_HEARTBEAT_MS).pipe(
      map(() => ({ type: 'ping', data: { serverTime: new Date().toISOString() } } as MessageEvent)),
    );
    return merge(of(hello), pings, orderEvents);
  }
}

