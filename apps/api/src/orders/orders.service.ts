import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOperator, FindOptionsWhere, Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { OrderStatusAudit, OrderStatusAuditSource } from './order-status-audit.entity';
import { Payment, PaymentStatus } from '../payments/payment.entity';
import { AppException } from '../common/app-exception';
import { attributeRequestRestaurant } from '../common/metrics/restaurant-attribution';
import { confirmGateEnabled } from './payment-confirm-gate';
import { verifyReceiptAccessToken } from './receipt-access';
import { UserRole } from '../users/user.entity';
import { OrderItem } from './order-item.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import {
  DEFAULT_PAGE_SIZE,
  ListMyOrdersDto,
  ListMyOrdersRangeDto,
  MAX_PAGE_SIZE,
} from './dto/list-my-orders.dto';
import { dateRangeBounds, dateRangeOperator, parseListDateRange } from './list-date-range';
import { MenuService } from '../menu/menu.service';
import { MenuOptionService } from '../menu/menu-option.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { DELIVERY_ETA_SQL, EtaSqlRow } from '../restaurants/delivery-eta';
import { buildOrderDeliveryView } from './delivery-view';
import { OrderEventsService } from './order-events.service';
import { PromosService, normalizePromoCode } from '../promos/promos.service';
import { AddressesService } from '../users/addresses.service';
import { UsersService } from '../users/users.service';
import { clampToIntRange, MAX_PUBLIC_PAGE } from '../common/int-range';
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

/**
 * True for a driver-level unique violation (SQLSTATE 23505). pg surfaces
 * the class on `QueryFailedError.code`. Used by create()'s code-collision
 * retry (session 121) — see the call-site contract comment.
 */
function isUniqueViolationError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

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

/**
 * Receipt proof normalization (Phase 6 ownership fix): trim + lowercase.
 * ONE function feeds both the write path (`create` stores the order's
 * `contactEmail`) and the read path (`findOneForViewer` compares the
 * presented proof), so the two can never drift on casing/whitespace.
 * Empty/undefined collapse to null.
 * The typeof guard is the belt-and-braces for non-string wire shapes a raw
 * `@Query('contactEmail')` can deliver (repeated key => array; bracket form
 * => nested object). Today the global ValidationPipe's String metatype
 * coercion happens to flatten those to 'a,b' / '[object Object]' before
 * this function ever runs (session-132 probe), so nothing reaches here —
 * but that coercion is a pipe-side accident, not a contract: if the param
 * is ever typed `any`/DTO-whitelisted away, the array must still collapse
 * to null (a DENY), never `arr.trim is not a function` => 500 (session-84
 * non-5xx doctrine). See receipt-proof-sweep.http.spec.ts.
 */
export function normalizeContactEmail(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return v ? v : null;
}

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

  private readonly logger = new Logger(OrdersService.name);

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

  /**
   * Human-readable short code. 31-char unambiguous alphabet (no I/O/L/0/1).
   * Session 121: the width grew 4 -> 6. Four chars = 31^4 ≈ 924k codes into
   * a UNIQUE column — a birthday-paradox collision every ~1.6k orders, live-
   * reproduced as a random 500 on order-create under the k6 write ladder.
   * 31^6 ≈ 887M makes a collision rare; the create() retry makes it a
   * non-event. crypto.randomInt (not Math.random): uniform draws from a
   * CSPRNG for a customer-facing identifier.
   */
  private generateCode(): string {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 6; i++) out += chars[randomInt(chars.length)];
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
    // Session 144: pricing needs {id, minOrderCents, deliveryFeeCents} only —
    // the full DETAIL read (6 statements, menu hydration) was pure overhead
    // on the hottest write path. Same null/404 semantics for junk ids.
    const restaurant = await this.restaurants.findOrderScope(dto.restaurantId);
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    // EXPLICIT order-centric attribution (session 125, Phase 8): POST /orders
    // carries the restaurant in the BODY and its matched template has no
    // restaurant param, so the service stamps the resolved row for the
    // metrics middleware at finish time. Stamped BEFORE pricing/validation
    // so the later 400/409 branches top up the owner's view (bucket MINTING
    // stays 2xx-only — an unknown restaurant already threw, junk cannot
    // mint; the hook itself re-gates uuid shape).
    attributeRequestRestaurant(restaurant.id);

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
      restaurantId: dto.restaurantId,
      userId: userId ?? null,
      customerName: contact.customerName,
      contactPhone: contact.contactPhone,
      contactEmail: normalizeContactEmail(dto.contactEmail),
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
    // Unit-of-work run with CODE-COLLISION RETRY (session 121): a fresh code
    // is drawn per attempt; if the INSERT trips a unique violation (SQLSTATE
    // 23505) the whole transaction already rolled back (stock decrements
    // included, and `em.save` re-mints the PK), so re-running the unit of
    // work with a redrawn code cannot double-take anything. Inside this tx
    // the ONLY by-chance collidable constraint is the random code: the promo
    // caps re-check under the FOR UPDATE lock raise plain 400s, not 23505,
    // and the PK is a fresh uuid. Everything else (INSUFFICIENT_STOCK, 400s,
    // driver errors) propagates exactly as before; a persistent 23505 past
    // the bound is rethrown, so the failure mode is never worse than pre-
    // retry — it just becomes vanishingly rare instead of a random 500.
    const CODE_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt += 1) {
      order.code = this.generateCode();
      try {
        const saved = await this.attemptCreateUnitOfWork(order, stockEntries, {
          appliedPromoId,
          discountCents,
          userId: userId ?? null,
        });
        const full = await this.findOne(saved.id);
        this.emit('order.created', full);
        return full;
      } catch (err) {
        if (!isUniqueViolationError(err) || attempt >= CODE_ATTEMPTS) throw err;
        this.logger.warn(
          `order code collision on insert (attempt ${attempt}/${CODE_ATTEMPTS}) — retrying with a fresh code`,
          { restaurantId: dto.restaurantId },
        );
      }
    }
  }

  /**
   * ONE execution of create()'s write set, extracted session 121 so the
   * code-collision retry can re-run the whole unit of work. Contract notes
   * live at the call site (session 71 unit-of-work + session 72 restock
   * ledger + session 67 promo cap under FOR UPDATE).
   */
  private async attemptCreateUnitOfWork(
    order: Order,
    stockEntries: Array<[string, { name: string; quantity: number; stockAtRead: number }]>,
    promo: { appliedPromoId: string | null; discountCents: number; userId: string | null },
  ): Promise<Order> {
    return this.orders.manager.transaction(async (em) => {
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
      if (promo.appliedPromoId) {
        // Ledger redemption row in the SAME transaction, under the promo
        // row lock — this closes the "last redemption" count→insert race
        // session 67 left documented (see PromosService.recordUsage).
        await this.promos.recordUsage(
          {
            promoId: promo.appliedPromoId,
            orderId: persisted.id,
            userId: promo.userId,
            discountCents: promo.discountCents,
          },
          em,
        );
      }
      return persisted;
    });
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
   * JWT_SECRET as visible to THIS service. Belt-and-braces by design:
   * unit/DI harnesses pass assorted stubs into the optional config slot
   * (plain objects, jest.fn, noop — orders-ownership.spec.ts). Anything
   * that is not a readable string leaves the magic-link rung inert (every
   * token DENIES via the empty-secret guard) — a legacy harness can never
   * 500 on rung 4 (session-84 non-5xx doctrine).
   */
  private receiptSecret(): string | undefined {
    try {
      const raw =
        typeof this.config?.get === 'function'
          ? this.config.get<string>('JWT_SECRET')
          : undefined;
      return typeof raw === 'string' && raw ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Receipt read for the PUBLIC `GET /orders/:id` surface (Phase 6
   * ownership fix). `findOne` above stays the unguarded internal loader
   * (create-echo, status flows, event fan-out) — this is the authorization
   * edge the HTTP route uses. Access ladder:
   *
   * 1. ADMIN bearer (the admin panel reads receipts for oversight);
   * 2. the order's own customer (bearer `sub === order.userId`);
   * 3. anyone who presents the order's stored `contactEmail` — the guest
   *    checkout proof, compared normalized and case-insensitively. Orders
   *    with a NULL stored email (legacy rows, API clients that omitted it)
   *    simply have no rung 3;
   * 4. a valid magic-link token (`?rt=`, Phase 14 #5) minted for THIS
   *    order id — the short-lived HMAC capability embedded in the order
   *    emails' receipt link. The bearer rungs 1–2 and the typed-proof
   *    rung 3 stay byte-identical; rung 4 needs nothing typed. With
   *    no JWT_SECRET visible to this service (bare unit-spec harnesses)
   *    the rung is inert and every token DENIES.
   *
   * Everything else answers the SAME 404 as an unknown id — no existence
   * oracle, same convention as the customer cancel route.
   */
  async findOneForViewer(
    id: string,
    viewer?: { sub: string; role?: UserRole },
    contactEmail?: string,
    receiptToken?: string,
  ) {
    const order = await this.findOne(id);
    const proof = normalizeContactEmail(contactEmail);
    const authorized =
      viewer?.role === UserRole.ADMIN ||
      (viewer != null && order.userId != null && order.userId === viewer.sub) ||
      (proof != null && order.contactEmail != null && proof === order.contactEmail) ||
      verifyReceiptAccessToken(receiptToken, id, this.receiptSecret());
    if (!authorized) throw new NotFoundException('Order not found');
    // EXPLICIT receipt-read attribution (session 125): GET /orders/:id
    // addresses the restaurant one join away (order.restaurantId). Stamped
    // only on the AUTHORIZED rungs — a rung-missing 404 stays global-only,
    // so probes cannot even top up a restaurant's 4xx row with guesses
    // about orders they cannot see (no-oracle doctrine, extended to the
    // owner's traffic view).
    attributeRequestRestaurant(order.restaurantId);
    return this.attachDeliveryView(order);
  }

  /**
   * Tracking-page delivery polish (Phase 12, session 119). Attached ONLY here
   * (the receipt read) and ONLY when the order is `delivering` — every other
   * status and every other read/echo stays byte-identical. The view names the
   * driver and counts down from session 113's per-restaurant ETA; any failed
   * sub-read degrades to the honest null inside the view, never a 500 on the
   * receipt (the session-89 "extras degrade, the route stays 200" doctrine).
   */
  async attachDeliveryView(order: Order): Promise<Order> {
    if (order.status !== OrderStatus.DELIVERING) return order;

    let etaRow: EtaSqlRow | null | undefined = undefined;
    try {
      // Session 113's OWN batched statement (same file, same semantics:
      // undefined = nothing eligible, null = read failed). Positional $1
      // array param per the raw-SQL rule (session 106).
      const raw = (await this.orders.query(DELIVERY_ETA_SQL, [[order.restaurantId]])) as unknown;
      const rows = Array.isArray(raw) ? (raw as EtaSqlRow[]) : [];
      etaRow = rows.length > 0 ? rows[0] : undefined;
    } catch (err) {
      etaRow = null;
      this.logger.warn(`delivery ETA aggregate read failed: ${(err as Error).message}`);
    }

    let driverName: string | null = null;
    if (order.driverId && this.users) {
      try {
        const driver = await this.users.findById(order.driverId);
        driverName = driver?.name ?? null;
      } catch (err) {
        this.logger.warn(`delivery driver read failed: ${(err as Error).message}`);
      }
    }

    (order as unknown as Record<string, unknown>).delivery = buildOrderDeliveryView({
      etaRow,
      driverName,
      avgPrepMinutes: order.restaurant?.avgPrepMinutes ?? null,
      confirmedAt: order.confirmedAt,
      createdAt: order.createdAt,
    });
    return order;
  }

  /**
   * Paginated, status-filterable order history for the authenticated customer.
   * Returns the same { items, total, page, limit } envelope restaurants.findAll uses.
   * Session 144 (order-read audit): the query-logger proved this path emits a
   * CONSTANT 3 statements (distinct-ids page + one IN-batch row fetch — items
   * ride in one pass, no N+1 — plus the total). `findAndCount` was split into
   * `find` + join-free `COUNT(1)` because `Order.items` is an EAGER relation:
   * findAndCount's count mirrored the eager `LEFT JOIN order_items`, turning
   * an indexed count into a 15k-row join scan. Same statement count, the
   * count is now orders-only.
   *
   * Phase 17 date range: `from`/`to` (ISO-8601, closed) ride the SAME
   * (userId, createdAt) index — the bound lands on `createdAt` inside the
   * leading-column equality, so the backward index scan simply starts at
   * the upper bound. Both halves (page + total) consume ONE where object,
   * so the envelope cannot drift between them.
   */
  async findMine(userId: string, q: ListMyOrdersRangeDto = {}) {
    // Session 87 sweep: bounded clamping, NOT Number() math — a huge page
    // that passes IsInt used to bind an OFFSET past bigint (driver 500).
    const page = clampToIntRange(q.page, 1, MAX_PUBLIC_PAGE, 1);
    const limit = clampToIntRange(q.limit, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);

    const where: FindOptionsWhere<Order> = { userId };
    if (q.status) where.status = q.status;
    const created = dateRangeOperator(parseListDateRange(q));
    if (created) where.createdAt = created;

    // The per-order line items the history page renders ride on the EAGER
    // `items` relation — loaded in the SAME IN-batch statement, not one per card.
    const items = await this.orders.find({
      where,
      relations: { restaurant: true },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const total = await this.countOrders(where);
    return { items, total, page, limit };
  }

  /** Driver inbox: the JWT subject is the assignment scope, never a query input. */
  async findForDriver(driverId: string, q: ListMyOrdersDto = {}) {
    // Session 87 sweep: bounded clamping, NOT Number() math — a huge page
    // that passes IsInt used to bind an OFFSET past bigint (driver 500).
    const page = clampToIntRange(q.page, 1, MAX_PUBLIC_PAGE, 1);
    const limit = clampToIntRange(q.limit, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
    const where: FindOptionsWhere<Order> = { driverId };
    if (q.status) where.status = q.status;

    const items = await this.orders.find({
      where,
      relations: { restaurant: true },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const total = await this.countOrders(where);
    return { items, total, page, limit };
  }

  /**
   * Join-free total for the inbox/history lists (session 144). Plain repo
   * counts ride the eager `items` relation (LEFT JOIN order_items); a QueryBuilder
   * does NOT — proven live by the query logger, pinned by the perf contract spec.
   * Every caller passes at least an owner column; a predicate-less count would
   * silently count the whole table, so that shape answers 0 (fail closed).
   */
  private async countOrders(where: FindOptionsWhere<Order>): Promise<number> {
    const conds: string[] = [];
    const params: Record<string, unknown> = {};
    // FindOptionsWhere here is always { owner-col?, status?, createdAt? }
    // from the list methods above — flat column predicates, no relations.
    if (where.userId !== undefined) {
      conds.push('o.userId = :userId');
      params.userId = where.userId;
    }
    if (where.driverId !== undefined) {
      conds.push('o.driverId = :driverId');
      params.driverId = where.driverId;
    }
    if (where.restaurantId !== undefined) {
      conds.push('o.restaurantId = :restaurantId');
      params.restaurantId = where.restaurantId;
    }
    if (where.status !== undefined) {
      conds.push('o.status = :status');
      params.status = where.status;
    }
    // Phase 17: the COUNT mirrors the page's date bounds by DECOMPOSING
    // the same FindOperator dateRangeOperator minted for find, so `total`
    // can never describe a wider window than the rows being paged. A
    // closed-set violation throws loudly (helper) rather than widening.
    if (where.createdAt instanceof FindOperator) {
      const bounds = dateRangeBounds(where.createdAt);
      if (bounds.from !== undefined) {
        conds.push('o.createdAt >= :rangeFrom');
        params.rangeFrom = bounds.from;
      }
      if (bounds.to !== undefined) {
        conds.push('o.createdAt <= :rangeTo');
        params.rangeTo = bounds.to;
      }
    }
    if (conds.length === 0) return 0;
    const raw = await this.orders
      .createQueryBuilder('o')
      .select('COUNT(1)', 'cnt')
      .where(conds.join(' AND '), params)
      .getRawOne<{ cnt: string }>();
    return Number(raw?.cnt) || 0;
  }

  /**
   * Owner-facing orders inbox for one restaurant (Phase 2 portal). Scoping is
   * enforced server-side: only the restaurant's owner may list its orders
   * (admins bypass). An unknown/garbage id is 404; someone else's restaurant
   * is 403 — restaurant pages are public so existence is not secret, the
   * ORDER data is. Same paginated envelope as findMine, plus per-status
   * `counts` for the inbox tabs.
   *
   * Session 144 (order-read audit): this used to be 14 statements/request —
   * the ownership gate ran the full restaurant DETAIL read (6), the
   * findAndCount count mirrored the eager items join (3 total for the page),
   * and ONE `count({restaurantId, status})` per status ran SIX more
   * eager-joined COUNT(DISTINCT) scans (EXPLAIN: 287 buffers + a seq scan of
   * order_items EACH). Now: 1 projection gate + 2 page statements + ONE
   * index-only `GROUP BY status` over (restaurantId, status) (EXPLAIN: 8
   * buffers) whose per-status values serve BOTH `counts` and `total`
   * (total = the filtered status's count, or the sum when unfiltered —
   * exactly what the old separate count query computed). Response envelope
   * is byte-identical: every status key stays present, zero-filled.
   */
  async findForRestaurant(
    restaurantId: string,
    actor: { sub: string; role: UserRole },
    q: ListMyOrdersDto = {},
  ) {
    await this.getOwnedRestaurant(restaurantId, actor);

    // Session 87 sweep: bounded clamping, NOT Number() math — a huge page
    // that passes IsInt used to bind an OFFSET past bigint (driver 500).
    const page = clampToIntRange(q.page, 1, MAX_PUBLIC_PAGE, 1);
    const limit = clampToIntRange(q.limit, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);

    const where: FindOptionsWhere<Order> = { restaurantId };
    if (q.status) where.status = q.status;

    const items = await this.orders.find({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const rows = await this.orders
      .createQueryBuilder('o')
      .select('o.status', 'status')
      .addSelect('COUNT(1)', 'count')
      .where('o.restaurantId = :restaurantId', { restaurantId })
      .groupBy('o.status')
      .getRawMany<{ status: OrderStatus; count: string }>();

    const counts = {} as Record<OrderStatus, number>;
    for (const status of Object.values(OrderStatus)) counts[status] = 0;
    let allStatuses = 0;
    for (const row of rows) {
      const n = Number(row.count) || 0;
      if (Object.prototype.hasOwnProperty.call(counts, row.status)) {
        counts[row.status] = n;
        allStatuses += n;
      }
    }

    const total = q.status ? counts[q.status] : allStatuses;
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
    const restaurant = await this.restaurants.findOrderScope(restaurantId);
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
