import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { OrderStatusAudit, OrderStatusAuditSource } from './order-status-audit.entity';
import { Payment, PaymentStatus } from '../payments/payment.entity';
import { AppException } from '../common/app-exception';
import { confirmGateEnabled } from './payment-confirm-gate';
import { UserRole } from '../users/user.entity';
import { OrderItem } from './order-item.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import {
  DEFAULT_PAGE_SIZE,
  ListMyOrdersDto,
  MAX_PAGE_SIZE,
} from './dto/list-my-orders.dto';
import { MenuService } from '../menu/menu.service';
import { MenuOptionService } from '../menu/menu-option.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { OrderEventsService } from './order-events.service';
import { PromosService, normalizePromoCode } from '../promos/promos.service';
import { AddressesService } from '../users/addresses.service';
import { UsersService } from '../users/users.service';
import { isUuid } from '../common/uuid';
import {
  runStaleOrderSweep,
  resolveStaleSweepConfig,
  StaleSweepOptions,
  StaleSweepReport,
} from './stale-order-sweep';
import { restockCancelledOrder } from './stock-restock';
import {
  runRestockRepair,
  resolveRestockRepairConfig,
  RestockRepairOptions,
  RestockRepairReport,
} from './stock-restock-repair';

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
    // Payment-confirm gate (optional so every pre-gate construction keeps
    // working): unit specs either omit this repo (gate inert by
    // construction) or pin the flag explicitly; the gate itself is ENABLED
    // BY DEFAULT (session 44) — DI always provides both in the app.
    @InjectRepository(Payment) private readonly payments?: Repository<Payment>,
    private readonly config?: ConfigService,
    private readonly users?: UsersService,
    @Optional()
    @InjectRepository(OrderStatusAudit)
    private readonly statusAudits?: Repository<OrderStatusAudit>,
    // Menu-option pricing (Phase 5): resolves + validates every line's
    // selected choice ids server-side. Optional so pre-options unit
    // harnesses (which never send optionChoiceIds) stay valid; the app
    // module always injects it.
    @Optional()
    private readonly optionPricing?: MenuOptionService,
  ) {}

  private async auditStatusChange(
    orderId: string,
    fromStatus: OrderStatus,
    toStatus: OrderStatus,
    source: OrderStatusAuditSource,
    actor?: { sub: string; role: UserRole; email?: string },
  ): Promise<void> {
    if (!this.statusAudits) return;
    await this.statusAudits.save(this.statusAudits.create({
      orderId,
      fromStatus,
      toStatus,
      source,
      actorUserId: actor?.sub ?? null,
      actorRole: actor?.role ?? null,
      actorEmail: actor?.email ?? null,
    }));
  }

  /**
   * After every state-changing write, tell the live streams something moved.
   * The SSE consumers refetch the truth via the normal inbox GET — this event
   * only carries identity + status for cheap client-side coalescing.
   */
  private emit(
    type: 'order.created' | 'order.updated',
    order: Pick<Order, 'id' | 'code' | 'status' | 'restaurantId' | 'userId' | 'driverId'>,
    affectedDriverIds: Array<string | null | undefined> = [order.driverId],
  ): void {
    const driverIds = [...new Set(affectedDriverIds.filter((id): id is string => !!id))];
    this.events.publish({
      type,
      restaurantId: order.restaurantId,
      // Drives the WS customer-side room fan-out; null for guest orders.
      userId: order.userId ?? null,
      ...(driverIds.length > 0 ? { driverIds } : {}),
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
   * Order-machine gate (docs/ROADMAP.md Phase 5, `ORDER_CONFIRM_REQUIRES_
   * PAYMENT`, ENABLED BY DEFAULT since session 44): entering CONFIRMED
   * requires a `succeeded` payment row on this order — enforced on EVERY
   * path that can confirm (owner portal and the ADMIN backdoor alike, so
   * the gate cannot be stepped around). Explicit env opt-out
   * (`ORDER_CONFIRM_REQUIRES_PAYMENT=off` et al.) or a construction without
   * the payments repo (older unit specs) ⇒ inert, zero queries. 402 with a
   * stable PAYMENT_REQUIRED code; refunds do not un-confirm anything (a
   * `refunded` row never satisfies the gate — money that came back is not
   * payment). Checked after the flow legality, before any mutation.
   */
  private async assertConfirmGate(order: Order, target: OrderStatus): Promise<void> {
    if (target !== OrderStatus.CONFIRMED || !this.payments) return;
    if (!confirmGateEnabled(this.config?.get<string>('ORDER_CONFIRM_REQUIRES_PAYMENT'))) return;
    const paid = await this.payments.exist({
      where: { orderId: order.id, status: PaymentStatus.SUCCEEDED },
    });
    if (!paid) {
      throw new AppException(
        HttpStatus.PAYMENT_REQUIRED,
        'PAYMENT_REQUIRED',
        `Order ${order.code} has no succeeded payment — confirmation is gated until payment lands`,
        { orderId: order.id, flag: 'ORDER_CONFIRM_REQUIRES_PAYMENT' },
      );
    }
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

    // Menu options (Phase 5): validate every line's selected choice ids
    // against the dishes' option groups BEFORE any pricing is trusted —
    // duplicates, foreign-dish ids, unknown ids and group min/max all 400
    // the whole order. Results are INDEX-ALIGNED with dto.items.
    const optionLines = this.optionPricing
      ? await this.optionPricing.resolveSelections(dto.items)
      : dto.items.map(() => ({ extraCents: 0, selections: [] }));

    let subtotal = 0;
    const items: Partial<OrderItem>[] = [];
    // Stock guard (unit-of-work, session 71): dishes with a numeric `stock`
    // are stock-managed; `null`/absent (every seeded + legacy dish) stays
    // UNLIMITED and earns no decrement. Duplicate cart lines of the same
    // dish aggregate into ONE decrement; the atomic conditional UPDATE
    // below — not the read here — is the authority (the read only decides
    // managed-vs-unlimited and the honest 409 payload).
    const stockDeltas = new Map<string, { name: string; quantity: number; stockAtRead: number }>();
    for (let index = 0; index < dto.items.length; index++) {
      const line = dto.items[index];
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
      if (typeof m.stock === 'number') {
        const prev = stockDeltas.get(m.id);
        stockDeltas.set(m.id, {
          name: m.name,
          quantity: (prev?.quantity ?? 0) + quantity,
          stockAtRead: m.stock,
        });
      }
      // Server-side unit price: dish base + resolved option deltas. The
      // client never sends a price; deltas already survived validation.
      const options = optionLines[index];
      const unitPriceCents = m.priceCents + options.extraCents;
      subtotal += unitPriceCents * quantity;
      items.push({
        menuItemId: m.id,
        name: m.name,
        unitPriceCents,
        quantity,
        optionSelections: options.selections.length ? options.selections : null,
      });
    }

    if (subtotal < restaurant.minOrderCents) {
      throw new BadRequestException(
        `Order below minimum of ${(restaurant.minOrderCents / 100).toFixed(2)}`,
      );
    }

    // Promo evaluation runs AFTER the min-order check (a promo can never
    // smuggle a below-minimum cart through) and on the SERVER-computed
    // subtotal — the client's own numbers are not consulted here. The caller
    // identity is passed for per-user cap counting; guests only ever consume
    // the total cap.
    let discountCents = 0;
    let appliedPromoCode: string | null = null;
    let appliedPromoId: string | null = null;
    if (dto.promoCode) {
      const outcome = await this.promos.evaluate(dto.promoCode, dto.restaurantId, subtotal, {
        userId: userId ?? null,
      });
      if (!outcome.ok) throw new BadRequestException(outcome.message);
      discountCents = outcome.discountCents!;
      appliedPromoCode = normalizePromoCode(dto.promoCode);
      appliedPromoId = outcome.promo!.id;
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

    // UNIT OF WORK (roadmap Phase 5, session 71): every mutation this order
    // owns — stock decrements, the order+items rows, and the promo ledger
    // row — commits or rolls back as ONE transaction. Reads/pricing/
    // evaluate above stay outside (cheap idempotent work); the lock window
    // is only the writes. Dishes decrement in sorted-id order so two
    // concurrent multi-dish carts acquire row locks in the same sequence
    // (deadlock mitigation, not elimination — PG still detects and aborts
    // one side; that surfaces as a 500 the client can retry).
    //
    // The stock UPDATE is its OWN guard: `stock >= requested` lives in the
    // WHERE clause, so a conditional zero-row result is the atomic truth
    // (no read-then-write race). A dish whose owner flipped stock to null
    // between our read and this UPDATE also matches zero rows and FAILS
    // CLOSED — an honest 409 beats silently selling units the counter says
    // nothing about.
    const stockEntries = [...stockDeltas.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    );
    // Restock-on-cancel ledger (session 72): freeze what this order is about
    // to decrement (per-dish aggregated) INTO the row, so every path into
    // `cancelled` returns exactly these units — no more (a dish the owner
    // switched to stock-managed AFTER this order was placed must not be
    // padded with units this order never took), no less (duplicate cart lines
    // already aggregated). null = this order decrements nothing.
    order.stockDecrements = stockEntries.length
      ? stockEntries.map(([menuItemId, delta]) => ({
          menuItemId,
          quantity: delta.quantity,
        }))
      : null;
    const saved = await this.orders.manager.transaction(async (em) => {
      for (const [menuItemId, delta] of stockEntries) {
        const result = await em.query(
          `UPDATE "menu_items" SET "stock" = "stock" - $2
            WHERE "id" = $1 AND "stock" IS NOT NULL AND "stock" >= $2
            RETURNING "stock"`,
          [menuItemId, delta.quantity],
        );
        // Shape reality (session 71 live smoke): this TypeORM/pg stack
        // returns DML-with-RETURNING as a `[rows, rowCount]` TUPLE — a 0-row
        // miss is `[[], 0]` (length 2!), not `[]`. Normalize both shapes;
        // never trust `result.length` on the raw return.
        const rows: Array<{ stock: number }> =
          Array.isArray(result) && Array.isArray(result[0])
            ? result[0]
            : Array.isArray(result)
              ? result
              : [];
        if (rows.length === 0) {
          throw new AppException(
            HttpStatus.CONFLICT,
            'INSUFFICIENT_STOCK',
            `Not enough stock for "${delta.name}" — ${delta.quantity} requested, ${delta.stockAtRead} left when the order started`,
            {
              menuItemId,
              requested: delta.quantity,
              stockAtRead: delta.stockAtRead,
            },
          );
        }
      }
      const persisted: Order = await em.save(order);
      if (appliedPromoId) {
        // Ledger redemption row in the SAME transaction, under the promo
        // row lock — this closes the "last redemption" count→insert race
        // session 67 left documented (see PromosService.recordUsage).
        await this.promos.recordUsage(
          {
            promoId: appliedPromoId,
            orderId: persisted.id,
            userId: userId ?? null,
            discountCents,
          },
          em,
        );
      }
      return persisted;
    });

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

  /** Driver inbox: the JWT subject is the assignment scope, never a query input. */
  async findForDriver(driverId: string, q: ListMyOrdersDto = {}) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(q.limit) || DEFAULT_PAGE_SIZE));
    const where: FindOptionsWhere<Order> = { driverId };
    if (q.status) where.status = q.status;

    const [items, total] = await this.orders.findAndCount({
      where,
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
   * Owner analytics for one restaurant. Only completed orders contribute:
   * revenue is the sum of the server-computed order total, and demand is
   * grouped by the UTC hour in which the order was created. The database does
   * the aggregate work; the service only fills missing hours and resolves the
   * deterministic earliest-hour tie for the peak.
   */
  async analyticsForRestaurant(
    restaurantId: string,
    actor: { sub: string; role: UserRole },
  ) {
    await this.getOwnedRestaurant(restaurantId, actor);

    const completed = { status: OrderStatus.COMPLETED };
    const summary = await this.orders
      .createQueryBuilder('o')
      .select('COALESCE(SUM(o.totalCents), 0)', 'grossRevenueCents')
      .addSelect('COUNT(*)', 'completedOrderCount')
      .where('o.restaurantId = :restaurantId', { restaurantId })
      .andWhere('o.status = :status', completed)
      .getRawOne<{ grossRevenueCents: string; completedOrderCount: string }>();

    const hourExpression = 'EXTRACT(HOUR FROM o.createdAt)::int';
    const rows = await this.orders
      .createQueryBuilder('o')
      .select(hourExpression, 'hourUtc')
      .addSelect('COUNT(*)', 'completedOrderCount')
      .where('o.restaurantId = :restaurantId', { restaurantId })
      .andWhere('o.status = :status', completed)
      .groupBy(hourExpression)
      .orderBy(hourExpression, 'ASC')
      .getRawMany<{ hourUtc: string; completedOrderCount: string }>();

    const hourly = Array.from({ length: 24 }, (_, hourUtc) => ({
      hourUtc,
      completedOrderCount: 0,
    }));
    for (const row of rows) {
      const hourUtc = Number(row.hourUtc);
      if (Number.isInteger(hourUtc) && hourUtc >= 0 && hourUtc < 24) {
        hourly[hourUtc].completedOrderCount = Number(row.completedOrderCount) || 0;
      }
    }

    let peakHourUtc: number | null = null;
    for (const bucket of hourly) {
      if (
        bucket.completedOrderCount > 0 &&
        (peakHourUtc === null ||
          bucket.completedOrderCount > hourly[peakHourUtc].completedOrderCount)
      ) {
        peakHourUtc = bucket.hourUtc;
      }
    }

    return {
      grossRevenueCents: Number(summary?.grossRevenueCents) || 0,
      completedOrderCount: Number(summary?.completedOrderCount) || 0,
      peakHourUtc,
      hourly,
    };
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
    actor: { sub: string; role: UserRole; email?: string },
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
    await this.assertConfirmGate(order, status);
    const fromStatus = order.status;
    this.applyStatus(order, status);
    const saved = await this.orders.save(order);
    await this.auditStatusChange(
      saved.id,
      fromStatus,
      status,
      actor.role === UserRole.ADMIN
        ? OrderStatusAuditSource.ADMIN
        : OrderStatusAuditSource.OWNER,
      actor,
    );
    if (status === OrderStatus.CANCELLED) await this.restockOnCancel(saved);
    this.emit('order.updated', saved);
    return saved;
  }

  /** Owner/admin assignment action; terminal orders are immutable. */
  async assignDriverForRestaurant(
    restaurantId: string,
    orderId: string,
    driverId: string | null,
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
    if ([OrderStatus.COMPLETED, OrderStatus.CANCELLED].includes(order.status)) {
      throw new BadRequestException(`Cannot change driver for ${order.status} order`);
    }
    if (driverId !== null) {
      const driver = await this.users?.findById(driverId);
      if (!driver || driver.role !== UserRole.DRIVER) {
        throw new BadRequestException('Driver not found');
      }
    }

    const previousDriverId = order.driverId;
    order.driverId = driverId;
    const saved = await this.orders.save(order);
    this.emit('order.updated', saved, [previousDriverId, driverId]);
    return saved;
  }

  /** Assigned drivers own only the final two forward edges of the status flow. */
  async setStatusForDriver(
    id: string,
    status: OrderStatus,
    driverId: string,
    actorEmail?: string,
  ) {
    if (!isUuid(id)) throw new NotFoundException('Order not found');
    const order = await this.orders.findOne({
      where: { id, driverId },
      relations: { items: true, restaurant: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const allowed =
      (order.status === OrderStatus.PREPARING && status === OrderStatus.DELIVERING) ||
      (order.status === OrderStatus.DELIVERING && status === OrderStatus.COMPLETED);
    if (!allowed) {
      throw new BadRequestException(
        `Cannot move assigned order from ${order.status} to ${status}`,
      );
    }

    const fromStatus = order.status;
    this.applyStatus(order, status);
    const saved = await this.orders.save(order);
    await this.auditStatusChange(
      saved.id,
      fromStatus,
      status,
      OrderStatusAuditSource.DRIVER,
      { sub: driverId, role: UserRole.DRIVER, email: actorEmail },
    );
    this.emit('order.updated', saved);
    return saved;
  }

  /**
   * Restock every path into `cancelled` (owner portal, admin backdoor,
   * customer self-cancel, stale sweep). Called AFTER the status write
   * committed; the snapshot CAS inside runs as its own transaction, so the
   * units return exactly once even if two cancels race. If this throws the
   * DB has a real problem — let it surface (500) rather than swallow a
   * stock-vs-reality drift.
   */
  private async restockOnCancel(saved: Order): Promise<void> {
    await restockCancelledOrder(this.orders.manager, saved);
  }

  /**
   * Customer-initiated cancellation. The customer may only cancel their own
   * order, and only while the status machine still allows ->CANCELLED
   * (pending/confirmed/preparing). Once the food is out for delivery the
   * customer has no self-service cancel — the restaurant/admin path stands.
   */
  async cancel(id: string, userId: string, role?: UserRole, email?: string) {
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
    const fromStatus = order.status;
    this.applyStatus(order, OrderStatus.CANCELLED);
    const saved = await this.orders.save(order);
    await this.auditStatusChange(
      saved.id,
      fromStatus,
      OrderStatus.CANCELLED,
      OrderStatusAuditSource.CUSTOMER,
      role ? { sub: userId, role, email } : undefined,
    );
    await this.restockOnCancel(saved);
    this.emit('order.updated', saved);
    return saved;
  }

  async updateStatus(
    id: string,
    status: OrderStatus,
    actor?: { sub: string; role: UserRole; email?: string },
  ) {
    const order = await this.findOne(id);
    if (!STATUS_FLOW[order.status].includes(status)) {
      throw new BadRequestException(
        `Cannot move order from ${order.status} to ${status}`,
      );
    }
    await this.assertConfirmGate(order, status);
    const fromStatus = order.status;
    this.applyStatus(order, status);
    const saved = await this.orders.save(order);
    await this.auditStatusChange(
      saved.id,
      fromStatus,
      status,
      OrderStatusAuditSource.ADMIN,
      actor,
    );
    if (status === OrderStatus.CANCELLED) await this.restockOnCancel(saved);
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
        await this.auditStatusChange(
          order.id,
          OrderStatus.PENDING,
          OrderStatus.CANCELLED,
          OrderStatusAuditSource.STALE_SWEEP,
        );
        // Stale sweeps cancel stock-reserving pending orders too — return
        // the units through the same exactly-once path the HTTP cancels use.
        await this.restockOnCancel(order);
        this.emit('order.updated', order);
        await options.onCancelled?.(order);
      },
    });
  }

  /**
   * Ops repair (session-72 follow-up): return reserved units for cancelled
   * orders the restock pass MISSED (crash window between the status commit
   * and the restock commit). Goes through the shared plain `runRestockRepair`
   * — the same code the standalone `restock-repair` cron script runs — so
   * the marker CAS keeps every repair exactly-once even if a live cancel or
   * a second scheduler is racing it.
   */
  async restockRepair(options: RestockRepairOptions = {}): Promise<RestockRepairReport> {
    return runRestockRepair(this.orders.manager, {
      config: resolveRestockRepairConfig(),
      ...options,
    });
  }
}
