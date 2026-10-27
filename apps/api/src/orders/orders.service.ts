import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { UserRole } from '../users/user.entity';
import { OrderItem } from './order-item.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import {
  DEFAULT_PAGE_SIZE,
  ListMyOrdersDto,
  MAX_PAGE_SIZE,
} from './dto/list-my-orders.dto';
import { MenuService } from '../menu/menu.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { OrderEventsService } from './order-events.service';
import { PromosService, normalizePromoCode } from '../promos/promos.service';
import { AddressesService } from '../users/addresses.service';
import { isUuid } from '../common/uuid';
import {
  runStaleOrderSweep,
  resolveStaleSweepConfig,
  StaleSweepOptions,
  StaleSweepReport,
} from './stale-order-sweep';

const STATUS_FLOW: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.DELIVERING, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERING]: [OrderStatus.COMPLETED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [],
};

/** Which entity column stamps first entry into each status (pending = createdAt). */
const STATUS_TIMESTAMP_FIELD: Partial<
  Record<OrderStatus, 'confirmedAt' | 'preparingAt' | 'deliveringAt' | 'completedAt' | 'cancelledAt'>
> = {
  [OrderStatus.CONFIRMED]: 'confirmedAt',
  [OrderStatus.PREPARING]: 'preparingAt',
  [OrderStatus.DELIVERING]: 'deliveringAt',
  [OrderStatus.COMPLETED]: 'completedAt',
  [OrderStatus.CANCELLED]: 'cancelledAt',
};

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly menu: MenuService,
    private readonly restaurants: RestaurantsService,
    private readonly events: OrderEventsService,
    private readonly promos: PromosService,
    private readonly addresses: AddressesService,
  ) {}

  /**
   * After every state-changing write, tell the live streams something moved.
   * The SSE consumers refetch the truth via the normal inbox GET — this event
   * only carries identity + status for cheap client-side coalescing.
   */
  private emit(
    type: 'order.created' | 'order.updated',
    order: Pick<Order, 'id' | 'code' | 'status' | 'restaurantId' | 'userId'>,
  ): void {
    this.events.publish({
      type,
      restaurantId: order.restaurantId,
      // Drives the WS customer-side room fan-out; null for guest orders.
      userId: order.userId ?? null,
      payload: {
        orderId: order.id,
        code: order.code,
        status: order.status,
      },
    });
  }

  private generateCode(): string {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return `FO-${out}`;
  }

  /**
   * Move the order to a new status and stamp the tracking timestamp for
   * first entry into that step. Write-once: an already-set step timestamp is
   * never overwritten, so the timeline keeps the true first-arrival times.
   */
  private applyStatus(order: Order, status: OrderStatus, now: Date = new Date()): void {
    order.status = status;
    const field = STATUS_TIMESTAMP_FIELD[status];
    if (field && !order[field]) order[field] = now;
  }

  /**
   * Resolve the delivery contact block before anything else. Either the
   * client sends name+phone+address explicitly (guest path, unchanged), or a
   * signed-in customer names one of their saved addresses and the server
   * copies its stored text — the client's echo of those fields is then
   * ignored, so checkout can never deliver to a location the account does
   * not own. The copied text becomes the order's immutable snapshot.
   */
  private async resolveContact(
    dto: CreateOrderDto,
    userId?: string,
  ): Promise<{ customerName: string; contactPhone: string; deliveryAddress: string }> {
    if (dto.deliveryAddressId) {
      if (!userId) {
        throw new BadRequestException(
          'deliveryAddressId requires a signed-in customer',
        );
      }
      const addr = await this.addresses.getOwned(userId, dto.deliveryAddressId);
      return {
        customerName: addr.recipientName,
        contactPhone: addr.phone,
        deliveryAddress: addr.address,
      };
    }
    const missing = (
      [
        ['customerName', dto.customerName],
        ['contactPhone', dto.contactPhone],
        ['deliveryAddress', dto.deliveryAddress],
      ] as const
    ).filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
      throw new BadRequestException(
        `Missing required field(s): ${missing.join(', ')} — or send a saved deliveryAddressId`,
      );
    }
    return {
      customerName: dto.customerName!,
      contactPhone: dto.contactPhone!,
      deliveryAddress: dto.deliveryAddress!,
    };
  }

  async create(dto: CreateOrderDto, userId?: string) {
    const contact = await this.resolveContact(dto, userId);
    const restaurant = await this.restaurants.findOne(dto.restaurantId);
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    const menuItems = await this.menu.findByIds(dto.items.map((i) => i.menuItemId));
    const byId = new Map(menuItems.map((m) => [m.id, m]));

    let subtotal = 0;
    const items: Partial<OrderItem>[] = [];
    for (const line of dto.items) {
      const quantity = Math.floor(line.quantity);
      if (!Number.isFinite(quantity) || quantity < 1 || quantity > 50) {
        throw new BadRequestException(`Invalid quantity for ${line.menuItemId}`);
      }
      const m = byId.get(line.menuItemId);
      if (!m || !m.isAvailable) {
        throw new BadRequestException(`Item ${line.menuItemId} is not available`);
      }
      if (m.restaurantId !== dto.restaurantId) {
        throw new BadRequestException(`Item ${m.id} does not belong to this restaurant`);
      }
      subtotal += m.priceCents * quantity;
      items.push({
        menuItemId: m.id,
        name: m.name,
        unitPriceCents: m.priceCents,
        quantity,
      });
    }

    if (subtotal < restaurant.minOrderCents) {
      throw new BadRequestException(
        `Order below minimum of ${(restaurant.minOrderCents / 100).toFixed(2)}`,
      );
    }

    // Promo evaluation runs AFTER the min-order check (a promo can never
    // smuggle a below-minimum cart through) and on the SERVER-computed
    // subtotal — the client's own numbers are not consulted here.
    let discountCents = 0;
    let appliedPromoCode: string | null = null;
    if (dto.promoCode) {
      const outcome = await this.promos.evaluate(dto.promoCode, dto.restaurantId, subtotal);
      if (!outcome.ok) throw new BadRequestException(outcome.message);
      discountCents = outcome.discountCents!;
      appliedPromoCode = normalizePromoCode(dto.promoCode);
    }

    const order = this.orders.create({
      code: this.generateCode(),
      restaurantId: dto.restaurantId,
      userId: userId ?? null,
      customerName: contact.customerName,
      contactPhone: contact.contactPhone,
      deliveryAddress: contact.deliveryAddress,
      note: dto.note,
      subtotalCents: subtotal,
      discountCents,
      promoCode: appliedPromoCode,
      deliveryFeeCents: restaurant.deliveryFeeCents,
      // Discount only ever touches the subtotal (evaluate clamps it there),
      // so the fee always survives: total = subtotal - discount + fee.
      totalCents: subtotal - discountCents + restaurant.deliveryFeeCents,
      items,
    });
    const saved = await this.orders.save(order);
    const full = await this.findOne(saved.id);
    this.emit('order.created', full);
    return full;
  }

  async findOne(id: string) {
    if (!isUuid(id)) throw new NotFoundException('Order not found');
    const order = await this.orders.findOne({
      where: { id },
      relations: { items: true, restaurant: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /**
   * Paginated, status-filterable order history for the authenticated customer.
   * Returns the same { items, total, page, limit } envelope restaurants.findAll uses.
   */
  async findMine(userId: string, q: ListMyOrdersDto = {}) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(q.limit) || DEFAULT_PAGE_SIZE));

    const where: FindOptionsWhere<Order> = { userId };
    if (q.status) where.status = q.status;

    const [items, total] = await this.orders.findAndCount({
      where,
      // items included so the web order-history page can render a per-order
      // line summary without an extra request per card.
      relations: { restaurant: true, items: true },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, page, limit };
  }

  /**
   * Owner-facing orders inbox for one restaurant (Phase 2 portal). Scoping is
   * enforced server-side: only the restaurant's owner may list its orders
   * (admins bypass). An unknown/garbage id is 404; someone else's restaurant
   * is 403 — restaurant pages are public so existence is not secret, the
   * ORDER data is. Same paginated envelope as findMine, plus per-status
   * `counts` for the inbox tabs (simple count queries per status — cheap at
   * this scale and trivially mock-testable).
   */
  async findForRestaurant(
    restaurantId: string,
    actor: { sub: string; role: UserRole },
    q: ListMyOrdersDto = {},
  ) {
    await this.getOwnedRestaurant(restaurantId, actor);

    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(q.limit) || DEFAULT_PAGE_SIZE));

    const where: FindOptionsWhere<Order> = { restaurantId };
    if (q.status) where.status = q.status;

    const [items, total] = await this.orders.findAndCount({
      where,
      relations: { items: true },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const counts = {} as Record<OrderStatus, number>;
    for (const status of Object.values(OrderStatus)) {
      counts[status] = await this.orders.count({ where: { restaurantId, status } });
    }

    return { items, total, page, limit, counts };
  }

  /**
   * Shared ownership gate for the owner portal routes: unknown/malformed
   * restaurant -> 404; someone else's restaurant -> 403 (admins bypass).
   * Same semantics findForRestaurant has always had.
   */
  private async getOwnedRestaurant(
    restaurantId: string,
    actor: { sub: string; role: UserRole },
  ): Promise<{ id: string; ownerId: string | null }> {
    const restaurant = await this.restaurants.findOne(restaurantId);
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    if (actor.role !== UserRole.ADMIN && restaurant.ownerId !== actor.sub) {
      throw new ForbiddenException('You do not own this restaurant');
    }
    return restaurant;
  }

  /**
   * Ownership gate for the SSE order stream: same 404/403 semantics as the
   * inbox GET. Called from the @Sse handler BEFORE the observable is returned,
   * so a rejected caller gets a normal JSON error — the stream never starts.
   */
  assertStreamAccess(
    restaurantId: string,
    actor: { sub: string; role: UserRole },
  ): Promise<{ id: string }> {
    return this.getOwnedRestaurant(restaurantId, actor);
  }

  /**
   * Owner-portal status action (Phase 2): the restaurant's owner (or an admin)
   * moves one of that restaurant's orders along STATUS_FLOW — accept, start
   * preparing, out for delivery, complete, or cancel on the restaurant's side.
   * Ordering of checks matters: 404 restaurant, 403 foreign restaurant, then
   * 404 for an order that does not exist *or* lives under a different
   * restaurant (the path scope is enforced without leaking other
   * restaurants' order existence), then 400 for a flow violation. The
   * restaurant the order belongs to is loaded via findOne's relations, so the
   * response shape matches the rest of the orders API.
   */
  async setStatusForRestaurant(
    restaurantId: string,
    orderId: string,
    status: OrderStatus,
    actor: { sub: string; role: UserRole },
  ) {
    await this.getOwnedRestaurant(restaurantId, actor);
    if (!isUuid(orderId)) throw new NotFoundException('Order not found');

    const order = await this.orders.findOne({
      where: { id: orderId },
      relations: { items: true, restaurant: true },
    });
    if (!order || order.restaurantId !== restaurantId) {
      throw new NotFoundException('Order not found');
    }
    if (!STATUS_FLOW[order.status].includes(status)) {
      throw new BadRequestException(
        `Cannot move order from ${order.status} to ${status}`,
      );
    }
    this.applyStatus(order, status);
    const saved = await this.orders.save(order);
    this.emit('order.updated', saved);
    return saved;
  }

  /**
   * Customer-initiated cancellation. The customer may only cancel their own
   * order, and only while the status machine still allows ->CANCELLED
   * (pending/confirmed/preparing). Once the food is out for delivery the
   * customer has no self-service cancel — the restaurant/admin path stands.
   */
  async cancel(id: string, userId: string) {
    if (!isUuid(id)) throw new NotFoundException('Order not found');
    const order = await this.orders.findOne({
      where: { id },
      relations: { restaurant: true, items: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) {
      // Same 404 as a missing order — do not leak that it exists under another user.
      throw new NotFoundException('Order not found');
    }
    if (!STATUS_FLOW[order.status].includes(OrderStatus.CANCELLED)) {
      throw new BadRequestException(
        `Order can no longer be cancelled (status: ${order.status})`,
      );
    }
    this.applyStatus(order, OrderStatus.CANCELLED);
    const saved = await this.orders.save(order);
    this.emit('order.updated', saved);
    return saved;
  }

  async updateStatus(id: string, status: OrderStatus) {
    const order = await this.findOne(id);
    if (!STATUS_FLOW[order.status].includes(status)) {
      throw new BadRequestException(
        `Cannot move order from ${order.status} to ${status}`,
      );
    }
    this.applyStatus(order, status);
    const saved = await this.orders.save(order);
    this.emit('order.updated', saved);
    return saved;
  }

  nextStatuses(id: string) {
    return this.findOne(id).then((o) => STATUS_FLOW[o.status]);
  }

  /**
   * Ops sweep (Phase 5 "auto-cancel stale pending orders"): move abandoned
   * `pending` orders to `cancelled` through the shared stale-order-sweep
   * logic. Each transition emits `order.updated` so live owner inboxes update
   * the same way a manual cancel does. The default age window comes from
   * STALE_ORDER_MINUTES (see resolveStaleSweepConfig); callers (the admin
   * route, the cron script) may override per-run.
   */
  async cancelStalePending(
    options: StaleSweepOptions = {},
  ): Promise<StaleSweepReport> {
    return runStaleOrderSweep(this.orders, {
      config: resolveStaleSweepConfig(),
      ...options,
      // Compose, don't clobber: a caller-provided hook still runs after ours.
      onCancelled: async (order) => {
        this.emit('order.updated', order);
        await options.onCancelled?.(order);
      },
    });
  }
}
