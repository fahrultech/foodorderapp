import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FindOperator, Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import { dateRangeBounds } from './list-date-range';
import { Order, OrderStatus } from './order.entity';
import { OrderEventsService } from './order-events.service';
import { MenuService } from '../menu/menu.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { UserRole } from '../users/user.entity';
import { isUuid } from '../common/uuid';
import { PromosService } from '../promos/promos.service';
import { AddressesService } from '../users/addresses.service';

const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INTRUDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fakeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    code: 'FO-TEST',
    userId: OWNER_ID,
    restaurantId: '11111111-1111-4111-8111-111111111111',
    status: OrderStatus.PENDING,
    subtotalCents: 1000,
    deliveryFeeCents: 300,
    totalCents: 1300,
    discountCents: 0,
    promoCode: null,
    items: [],
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    confirmedAt: null,
    preparingAt: null,
    deliveringAt: null,
    completedAt: null,
    cancelledAt: null,
    ...overrides,
  } as Order;
}

/** Events-bus mock: records every publish() for emit assertions. */
function fakeEvents() {
  return { publish: jest.fn() } as unknown as OrderEventsService & {
    publish: jest.Mock;
  };
}

/** Promo-service mock for constructor arity; create() only calls it when a promoCode is sent. */
function fakePromos() {
  return {
    evaluate: jest.fn(),
  } as unknown as PromosService & { evaluate: jest.Mock };
}

/** Addresses-service mock for constructor arity; create() only calls getOwned when a deliveryAddressId is sent (covered in orders-address.spec.ts). */
function fakeAddresses() {
  return {
    getOwned: jest.fn(),
  } as unknown as AddressesService & { getOwned: jest.Mock };
}

function build(orders: Order[] = [fakeOrder()]) {
  const findOne = jest.fn(async ({ where }: any) =>
    orders.find((o) => o.id === where.id) ?? null,
  );
  // Session 144 (order-read audit): findMine/findForDriver page through
  // `find` and take their total from a join-free QueryBuilder COUNT(1) —
  // repo.findAndCount used to mirror the EAGER items relation into the
  // count (LEFT JOIN order_items, live-proven at 15.6k join rows). The
  // fake below keeps both halves honest: same filter/sort/slice semantics
  // for the page, and the count recomputed from the where() params.
  const countWhere = (p: any) =>
    orders.filter(
      (o) =>
        (p.userId === undefined || o.userId === p.userId) &&
        (p.driverId === undefined || o.driverId === p.driverId) &&
        (p.status === undefined || o.status === p.status) &&
        (p.rangeFrom === undefined || o.createdAt >= p.rangeFrom) &&
        (p.rangeTo === undefined || o.createdAt <= p.rangeTo),
    ).length;
  const countQbs: any[] = [];
  const createQueryBuilder = jest.fn(() => {
    const params: Record<string, any> = {};
    const qb: any = {
      select: jest.fn(() => qb),
      where: jest.fn((_sql: string, p: any) => (Object.assign(params, p), qb)),
      getRawOne: jest.fn(async () => ({ cnt: String(countWhere(params)) })),
    };
    countQbs.push(qb);
    return qb;
  });
  const find = jest.fn(async ({ where, skip, take }: any) => {
    let lo: Date | undefined;
    let hi: Date | undefined;
    if (where.createdAt instanceof FindOperator) {
      const bounds = dateRangeBounds(where.createdAt);
      lo = bounds.from;
      hi = bounds.to;
    }
    const all = orders
      .filter(
        (o) =>
          o.userId === where.userId &&
          (!where.status || o.status === where.status) &&
          (!lo || o.createdAt >= lo) &&
          (!hi || o.createdAt <= hi),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return all.slice(skip ?? 0, (skip ?? 0) + (take ?? all.length));
  });
  const save = jest.fn(async (x: Order) => x);
  // Session 144 perf contract: resurrecting findAndCount here would put
  // the eager items join back into the count — the fake LOUDLY rejects it.
  const bannedFindAndCount = jest.fn(() => {
    throw new Error('findAndCount is banned on the audited order reads (session 144): its count mirrors the EAGER items join');
  });
  const repo = { findOne, find, createQueryBuilder, save, findAndCount: bannedFindAndCount } as unknown as jest.Mocked<
    Partial<Repository<Order>>
  >;
  const restaurants = {} as RestaurantsService;
  const events = fakeEvents();
  const service = new OrdersService(
    repo as Repository<Order>,
    {} as MenuService,
    restaurants,
    events,
    fakePromos(),
    fakeAddresses(),
  );
  return { service, findOne, find, createQueryBuilder, countQbs, save, events };
}

describe('OrdersService.findMine — pagination + status filter', () => {
  it('uses defaults page=1/limit=20 and scopes by userId', async () => {
    const { service, find, countQbs } = build();
    const out: any = await service.findMine(OWNER_ID, {});
    const args = (find as jest.Mock).mock.calls[0][0];
    expect(args.where).toEqual({ userId: OWNER_ID });
    expect(args.skip).toBe(0);
    expect(args.take).toBe(20);
    expect(args.order).toEqual({ createdAt: 'DESC' });
    // restaurant joins explicitly; line items ride the eager relation
    expect(args.relations).toEqual({ restaurant: true });
    expect(out).toMatchObject({ page: 1, limit: 20 });
    expect(Array.isArray(out.items)).toBe(true);
    // session 144 perf contract: the total is ONE join-free QB COUNT(1),
    // not findAndCount's eager-join count and not six per-status counts.
    expect(countQbs.length).toBe(1);
    expect(countQbs[0].getRawOne).toHaveBeenCalled();
  });

  it('passes an explicit status into the where clause', async () => {
    const { service, find } = build();
    await service.findMine(OWNER_ID, { status: OrderStatus.DELIVERING });
    const args = (find as jest.Mock).mock.calls[0][0];
    expect(args.where).toEqual({ userId: OWNER_ID, status: 'delivering' });
  });

  it('computes skip from page/limit', async () => {
    const { service, find } = build();
    await service.findMine(OWNER_ID, { page: 3, limit: 10 });
    const args = (find as jest.Mock).mock.calls[0][0];
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
  });

  it('clamps junk defensively even if the DTO let it through', async () => {
    const { service, find } = build();
    const out: any = await service.findMine(OWNER_ID, { page: 0 as any, limit: 999 as any });
    const args = (find as jest.Mock).mock.calls[0][0];
    expect(args.skip).toBe(0);
    expect(args.take).toBe(50);
    expect(out.page).toBe(1);
    expect(out.limit).toBe(50);
  });

  // Session 87 sweep: `page: 1e30` passes IsInt+Min at the DTO, but the
  // old `Math.max(1, Number(page) || 1)` bound it straight into OFFSET —
  // Postgres bigint overflow (22001/22P02) → HTTP 500. Closed range now,
  // live-proven against the real driver in the session-87 smoke.
  it('hostile page=1e30 / limit=500 lands on the closed range, never an overflowing OFFSET', async () => {
    const { service, find } = build();
    const out: any = await service.findMine(OWNER_ID, { page: 1e30 as any, limit: 500 as any });
    const args = (find as jest.Mock).mock.calls[0][0];
    expect(out.page).toBe(100_000); // MAX_PUBLIC_PAGE
    expect(out.limit).toBe(50); // MAX_PAGE_SIZE
    expect(args.skip).toBe((100_000 - 1) * 50);
    expect(args.take).toBe(50);
    expect(Number.isSafeInteger(args.skip)).toBe(true);
  });

  it('non-finite page/limit collapse to the defaults, not NaN in SQL', async () => {
    const { service, find } = build();
    await service.findMine(OWNER_ID, { page: Number.POSITIVE_INFINITY, limit: NaN });
    const args = (find as jest.Mock).mock.calls[0][0];
    expect(args.skip).toBe(0);
    expect(args.take).toBe(20);
  });

  it('returns exactly the page slice plus the full total', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      fakeOrder({
        id: `55555555-5555-4555-8555-55555555555${i}`,
        createdAt: new Date(2026, 9, 1 + i),
      }),
    );
    const { service } = build(rows);
    const out: any = await service.findMine(OWNER_ID, { page: 2, limit: 5 });
    expect(out.total).toBe(12);
    expect(out.items.length).toBe(5);
    // newest first: page 2 = items #6..#10 of the desc-sorted list
    expect(out.items[0].createdAt).toEqual(new Date(2026, 9, 7));
  });

  it('never returns another user’s orders even with an empty filter', async () => {
    const rows = [
      fakeOrder(),
      fakeOrder({ id: '66666666-6666-4666-8666-666666666666', userId: INTRUDER_ID }),
    ];
    const { service } = build(rows);
    const out: any = await service.findMine(OWNER_ID, {});
    expect(out.total).toBe(1);
    expect(out.items.map((o: Order) => o.userId)).toEqual([OWNER_ID]);
  });
});

// Phase 17 (order-history date range): the closed from/to filter must land
// on BOTH halves of the envelope — the paged find and the join-free COUNT
// QB — or `total` would describe a wider window than the rows shown.
describe('OrdersService.findMine — date range filter', () => {
  const datedRows = () =>
    Array.from({ length: 6 }, (_, i) =>
      fakeOrder({
        id: `55555555-5555-4555-8555-55555555555${i}`,
        createdAt: new Date(Date.UTC(2026, 10, 1 + i * 10)), // Nov 1/11/21 + Dec 1/11/21 (day overflow)
      }),
    );

  it('attaches from/to as Date bounds to the page where AND the count QB params', async () => {
    const { service, find, countQbs } = build(datedRows());
    const out: any = await service.findMine(OWNER_ID, {
      from: '2026-11-10T00:00:00.000Z',
      to: '2026-11-25T00:00:00.000Z',
    });
    const args = (find as jest.Mock).mock.calls[0][0];
    expect(args.where.createdAt).toBeInstanceOf(FindOperator);
    expect(dateRangeBounds(args.where.createdAt)).toEqual({
      type: 'between',
      from: new Date(Date.UTC(2026, 10, 10)),
      to: new Date(Date.UTC(2026, 10, 25)),
    });
    const countParams = countQbs[0].where.mock.calls[0][1];
    expect(countParams.rangeFrom).toEqual(new Date(Date.UTC(2026, 10, 10)));
    expect(countParams.rangeTo).toEqual(new Date(Date.UTC(2026, 10, 25)));
    // Nov 11 + Nov 21 of the fixture rows fall inside the window — total
    // and items must AGREE (the fake enforces the same predicate both ways).
    expect(out.total).toBe(2);
    expect(out.items.map((o: Order) => o.createdAt.toISOString())).toEqual([
      '2026-11-21T00:00:00.000Z',
      '2026-11-11T00:00:00.000Z',
    ]);
  });

  it('single-sided from leaves the where dialect $gte-only (never a phantom $lte)', async () => {
    const { service, find } = build(datedRows());
    const out: any = await service.findMine(OWNER_ID, { from: '2026-11-20T00:00:00.000Z' });
    const args = (find as jest.Mock).mock.calls[0][0];
    expect(dateRangeBounds(args.where.createdAt)).toEqual({
      type: 'moreThanOrEqual',
      from: new Date(Date.UTC(2026, 10, 20)),
      to: undefined,
    });
    expect(out.total).toBe(4); // Nov 21 + Dec 1/11/21 (upper side stays open)
  });

  it('an empty bound means UNSET at the service too (no epoch-wide predicate)', async () => {
    const { service, find } = build(datedRows());
    await service.findMine(OWNER_ID, { from: '', to: undefined });
    const args = (find as jest.Mock).mock.calls[0][0];
    expect('createdAt' in args.where).toBe(false);
  });

  it('an inverted range 400s before any query runs', async () => {
    const { service, find, createQueryBuilder } = build(datedRows());
    await expect(
      service.findMine(OWNER_ID, { from: '2026-11-25', to: '2026-11-01' }),
    ).rejects.toThrow(BadRequestException);
    expect(find).not.toHaveBeenCalled();
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });

  it('a malformed direct-call bound 400s instead of binding an Invalid Date', async () => {
    const { service, find } = build();
    await expect(service.findMine(OWNER_ID, { from: '31/11/2026' })).rejects.toThrow(
      BadRequestException,
    );
    expect(find).not.toHaveBeenCalled();
  });

  it('range composes with the status filter on both halves', async () => {
    const rows = datedRows().map((o, i) =>
      fakeOrder({ ...o, status: i % 2 === 0 ? OrderStatus.COMPLETED : o.status }),
    );
    const { service, find } = build(rows);
    const out: any = await service.findMine(OWNER_ID, {
      status: OrderStatus.COMPLETED,
      from: '2026-11-05T00:00:00.000Z',
    });
    const args = (find as jest.Mock).mock.calls[0][0];
    expect(args.where.status).toBe('completed');
    expect(dateRangeBounds(args.where.createdAt)).toEqual({
      type: 'moreThanOrEqual',
      from: new Date(Date.UTC(2026, 10, 5)),
      to: undefined,
    });
    expect(out.total).toBe(2); // idx2 (Nov 21) + idx4 (Dec 11) are completed AND >= Nov 5
    expect(out.items.length).toBe(2);
  });
});

describe('OrdersService.cancel — customer self-cancellation', () => {
  for (const status of [
    OrderStatus.PENDING,
    OrderStatus.CONFIRMED,
    OrderStatus.PREPARING,
  ]) {
    it(`cancels the owner's own ${status} order`, async () => {
      const { service, save } = build([fakeOrder({ status })]);
      const out = await service.cancel(ORDER_ID, OWNER_ID);
      expect(out.status).toBe(OrderStatus.CANCELLED);
      expect(save).toHaveBeenCalledTimes(1);
    });
  }

  for (const status of [
    OrderStatus.DELIVERING,
    OrderStatus.COMPLETED,
    OrderStatus.CANCELLED,
  ]) {
    it(`refuses to cancel a ${status} order with 400`, async () => {
      const { service, save } = build([fakeOrder({ status })]);
      await expect(service.cancel(ORDER_ID, OWNER_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(save).not.toHaveBeenCalled();
    });
  }

  it('answers 404 for another user’s order — existence is not leaked', async () => {
    const { service, save } = build();
    await expect(service.cancel(ORDER_ID, INTRUDER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('answers 404 for guest orders (userId null) — no proof of possession', async () => {
    const { service } = build([fakeOrder({ userId: null as any })]);
    await expect(service.cancel(ORDER_ID, OWNER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('answers 404 for a missing order', async () => {
    const { service } = build([]);
    await expect(
      service.cancel('99999999-9999-4999-8999-999999999999', OWNER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a malformed uuid before touching the DB', async () => {
    const { service, findOne } = build();
    await expect(service.cancel('not-a-uuid', OWNER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe('OrdersService.findOne — malformed uuid guard', () => {
  it('404s on a malformed id without a DB roundtrip (no 22P02 500s)', async () => {
    const { service, findOne } = build();
    await expect(service.findOne('garbage')).rejects.toBeInstanceOf(NotFoundException);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('404s on a well-formed but unknown id', async () => {
    const { service } = build([]);
    await expect(service.findOne(ORDER_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('OrdersService.findForRestaurant — owner orders inbox', () => {
  const REST_ID = '11111111-1111-4111-8111-111111111111';
  const OTHER_REST = '22222222-2222-4222-8222-222222222222';
  const ADMIN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  const ownerActor = { sub: OWNER_ID, role: UserRole.OWNER };

  function buildPortal(
    orders: Order[],
    opts: { ownerId?: string | null; restaurantExists?: boolean } = {},
  ) {
    const find = jest.fn(async ({ where, skip, take }: any) => {
      const all = orders
        .filter(
          (o) =>
            o.restaurantId === where.restaurantId &&
            (!where.status || o.status === where.status),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return all.slice(skip ?? 0, (skip ?? 0) + (take ?? all.length));
    });
    // Session 144 perf contract: ONE grouped query replaces the six
    // eager-joined per-status counts AND the page total.
    const grouped: { where: string | null }[] = [];
    const createQueryBuilder = jest.fn(() => {
      const st = { where: null as string | null };
      grouped.push(st);
      const qb: any = {
        select: jest.fn(() => qb),
        addSelect: jest.fn(() => qb),
        where: jest.fn((_sql: string, p: any) => ((st.where = p.restaurantId), qb)),
        groupBy: jest.fn(() => qb),
        getRawMany: jest.fn(async () => {
          const by: Record<string, number> = {};
          for (const o of orders)
            if (o.restaurantId === st.where) by[o.status] = (by[o.status] ?? 0) + 1;
          return Object.entries(by).map(([status, count]) => ({ status, count: String(count) }));
        }),
      };
      return qb;
    });
    const banned = jest.fn(() => {
    throw new Error('findAndCount is banned on the audited order reads (session 144)');
  });
  const repo = { find, createQueryBuilder, count: banned, findAndCount: banned } as unknown as Repository<Order>;
    const restaurants = {
      findOrderScope: jest.fn(async (id: string) =>
        !isUuid(id) || opts.restaurantExists === false
          ? null
          : ({ id, ownerId: opts.ownerId ?? OWNER_ID } as any),
      ),
    } as unknown as RestaurantsService;
    const service = new OrdersService(repo, {} as MenuService, restaurants, fakeEvents(), fakePromos(), fakeAddresses());
    return { service, find, createQueryBuilder, restaurants };
  }

  const at = (n: number) => new Date(2026, 9, n);

  it('404s for an unknown or malformed restaurant id before listing anything', async () => {
    const { service, find, createQueryBuilder } = buildPortal([], { restaurantExists: false });
    await expect(service.findForRestaurant(REST_ID, ownerActor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(find).not.toHaveBeenCalled();
    expect(createQueryBuilder).not.toHaveBeenCalled();

    await expect(service.findForRestaurant('garbage', ownerActor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('403s a non-owner; admin bypasses the ownership check', async () => {
    const rows = [fakeOrder({ restaurantId: REST_ID })];
    const { service } = buildPortal(rows);
    await expect(
      service.findForRestaurant(REST_ID, { sub: INTRUDER_ID, role: UserRole.OWNER }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const admin = buildPortal(rows);
    const out: any = await admin.service.findForRestaurant(REST_ID, {
      sub: ADMIN_ID,
      role: UserRole.ADMIN,
    });
    expect(out.total).toBe(1);
  });

  it('scopes strictly to the restaurant — other restaurants’ orders never leak', async () => {
    const rows = [
      fakeOrder({ id: ORDER_ID, restaurantId: REST_ID }),
      fakeOrder({ id: '77777777-7777-4777-8777-777777777777', restaurantId: OTHER_REST }),
    ];
    const { service } = buildPortal(rows);
    const out: any = await service.findForRestaurant(REST_ID, ownerActor);
    expect(out.total).toBe(1);
    expect(out.items.map((o: Order) => o.restaurantId)).toEqual([REST_ID]);
  });

  it('paginates newest-first and clamps limit like findMine', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      fakeOrder({
        id: `55555555-5555-4555-8555-55555555555${i}`,
        restaurantId: REST_ID,
        createdAt: at(i + 1),
      }),
    );
    const { service, find } = buildPortal(rows);
    const out: any = await service.findForRestaurant(REST_ID, ownerActor, { page: 2, limit: 5 });
    expect(out).toMatchObject({ page: 2, limit: 5, total: 12 });
    expect(out.items.length).toBe(5);
    expect(out.items[0].createdAt).toEqual(at(7)); // 6th newest
    const args = (find as jest.Mock).mock.calls[0][0];
    // items ride the EAGER relation now (session 144) — no relations opt
    expect(args.relations).toBeUndefined();
    expect(args.order).toEqual({ createdAt: 'DESC' });

    const clamped: any = await service.findForRestaurant(REST_ID, ownerActor, {
      page: 0 as any,
      limit: 999 as any,
    });
    expect(clamped.page).toBe(1);
    expect(clamped.limit).toBe(50);
  });

  it('filters by status and reports per-status counts over ALL statuses', async () => {
    const rows = [
      fakeOrder({ id: ORDER_ID, restaurantId: REST_ID, status: OrderStatus.PENDING, createdAt: at(1) }),
      fakeOrder({
        id: '88888888-8888-4888-8888-888888888881',
        restaurantId: REST_ID,
        status: OrderStatus.PENDING,
        createdAt: at(2),
      }),
      fakeOrder({
        id: '88888888-8888-4888-8888-888888888882',
        restaurantId: REST_ID,
        status: OrderStatus.COMPLETED,
        createdAt: at(3),
      }),
      fakeOrder({
        id: '88888888-8888-4888-8888-888888888883',
        restaurantId: OTHER_REST,
        status: OrderStatus.PENDING,
        createdAt: at(4),
      }),
    ];
    const { service, createQueryBuilder } = buildPortal(rows);
    const pending: any = await service.findForRestaurant(REST_ID, ownerActor, {
      status: OrderStatus.PENDING,
    });
    expect(pending.total).toBe(2);
    expect(pending.items.every((o: Order) => o.status === OrderStatus.PENDING)).toBe(true);
    // counts are NOT affected by the status filter — tabs need the whole picture
    expect(pending.counts).toEqual({
      pending: 2,
      confirmed: 0,
      preparing: 0,
      delivering: 0,
      completed: 1,
      cancelled: 0,
    });
    // session 144: the six eager-joined per-status counts collapsed into
    // exactly ONE grouped query (and the page total rides its numbers).
    expect((createQueryBuilder as jest.Mock).mock.calls.length).toBe(1);
  });
});

describe('OrdersService.analyticsForRestaurant — completed-order SQL aggregates', () => {
  const REST_ID = '11111111-1111-4111-8111-111111111111';
  const ownerActor = { sub: OWNER_ID, role: UserRole.OWNER };

  function buildAnalytics(
    summary: { grossRevenueCents: string; completedOrderCount: string },
    rows: Array<{ hourUtc: string; completedOrderCount: string }>,
    ownerId: string | null = OWNER_ID,
  ) {
    const queryBuilders = [
      {
        select: jest.fn().mockReturnThis(), addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn(async () => summary),
      },
      {
        select: jest.fn().mockReturnThis(), addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn(async () => rows),
      },
    ];
    const createQueryBuilder = jest
      .fn()
      .mockReturnValueOnce(queryBuilders[0])
      .mockReturnValueOnce(queryBuilders[1]);
    const restaurants = {
      findOrderScope: jest.fn(async () => ({ id: REST_ID, ownerId })),
    } as unknown as RestaurantsService;
    const service = new OrdersService(
      { createQueryBuilder } as unknown as Repository<Order>,
      {} as MenuService,
      restaurants,
      fakeEvents(),
      fakePromos(),
      fakeAddresses(),
    );
    return { service, createQueryBuilder, queryBuilders };
  }

  it('returns all-time completed revenue and 24 UTC demand buckets with the earliest peak', async () => {
    const summaryQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(async () => ({ grossRevenueCents: '7200', completedOrderCount: '4' })),
    };
    const hourlyQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(async () => [
        { hourUtc: '9', completedOrderCount: '2' },
        { hourUtc: '18', completedOrderCount: '2' },
      ]),
    };
    const createQueryBuilder = jest
      .fn()
      .mockReturnValueOnce(summaryQb)
      .mockReturnValueOnce(hourlyQb);
    const restaurants = {
      findOrderScope: jest.fn(async () => ({ id: REST_ID, ownerId: OWNER_ID })),
    } as unknown as RestaurantsService;
    const service = new OrdersService(
      { createQueryBuilder } as unknown as Repository<Order>,
      {} as MenuService,
      restaurants,
      fakeEvents(),
      fakePromos(),
      fakeAddresses(),
    );

    const out = await service.analyticsForRestaurant(REST_ID, ownerActor);

    expect(out).toMatchObject({
      grossRevenueCents: 7200,
      completedOrderCount: 4,
      peakHourUtc: 9,
    });
    expect(out.hourly).toHaveLength(24);
    expect(out.hourly[0]).toEqual({ hourUtc: 0, completedOrderCount: 0 });
    expect(out.hourly[9]).toEqual({ hourUtc: 9, completedOrderCount: 2 });
    expect(out.hourly[18]).toEqual({ hourUtc: 18, completedOrderCount: 2 });
    expect(summaryQb.andWhere).toHaveBeenCalledWith('o.status = :status', {
      status: OrderStatus.COMPLETED,
    });
    expect(hourlyQb.andWhere).toHaveBeenCalledWith('o.status = :status', {
      status: OrderStatus.COMPLETED,
    });
  });

  it('returns integer zeroes, 24 empty buckets, and a null peak when there are no completed orders', async () => {
    const { service } = buildAnalytics(
      { grossRevenueCents: '0', completedOrderCount: '0' },
      [],
    );
    const out = await service.analyticsForRestaurant(REST_ID, ownerActor);
    expect(out).toEqual({
      grossRevenueCents: 0,
      completedOrderCount: 0,
      peakHourUtc: null,
      hourly: Array.from({ length: 24 }, (_, hourUtc) => ({
        hourUtc,
        completedOrderCount: 0,
      })),
    });
  });

  it('rechecks ownership before aggregates and lets admins bypass ownership', async () => {
    const foreign = buildAnalytics(
      { grossRevenueCents: '0', completedOrderCount: '0' },
      [],
      INTRUDER_ID,
    );
    await expect(
      foreign.service.analyticsForRestaurant(REST_ID, ownerActor),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(foreign.createQueryBuilder).not.toHaveBeenCalled();

    const admin = buildAnalytics(
      { grossRevenueCents: '500', completedOrderCount: '1' },
      [{ hourUtc: '4', completedOrderCount: '1' }],
      null,
    );
    await expect(
      admin.service.analyticsForRestaurant(REST_ID, {
        sub: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        role: UserRole.ADMIN,
      }),
    ).resolves.toMatchObject({ grossRevenueCents: 500, peakHourUtc: 4 });
  });
});

describe('OrdersService.setStatusForRestaurant — owner status actions', () => {
  const REST_ID = '11111111-1111-4111-8111-111111111111';
  const OTHER_REST = '22222222-2222-4222-8222-222222222222';
  const ADMIN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const ownerActor = { sub: OWNER_ID, role: UserRole.OWNER };

  function buildActions(
    order: Order | null,
    opts: { ownerId?: string | null; restaurantExists?: boolean } = {},
  ) {
    const findOne = jest.fn(async ({ where }: any) =>
      order && order.id === where.id ? order : null,
    );
    const save = jest.fn(async (x: Order) => x);
    const repo = { findOne, save } as unknown as Repository<Order>;
    const events = fakeEvents();
    const restaurants = {
      findOrderScope: jest.fn(async (id: string) =>
        !isUuid(id) || opts.restaurantExists === false
          ? null
          : ({ id, ownerId: opts.ownerId ?? OWNER_ID } as any),
      ),
    } as unknown as RestaurantsService;
    const service = new OrdersService(repo, {} as MenuService, restaurants, events, fakePromos(), fakeAddresses());
    return { service, findOne, save, events };
  }

  const legal: Array<[OrderStatus, OrderStatus]> = [
    [OrderStatus.PENDING, OrderStatus.CONFIRMED],
    [OrderStatus.CONFIRMED, OrderStatus.PREPARING],
    [OrderStatus.PREPARING, OrderStatus.DELIVERING],
    [OrderStatus.DELIVERING, OrderStatus.COMPLETED],
  ];
  it.each(legal)(
    'owner advances a %s order to %s',
    async (from: OrderStatus, to: OrderStatus) => {
      const order = fakeOrder({ restaurantId: REST_ID, status: from });
      const { service, save } = buildActions(order);
      const out: any = await service.setStatusForRestaurant(
        REST_ID,
        ORDER_ID,
        to,
        ownerActor,
      );
      expect(out.status).toBe(to);
      expect(save).toHaveBeenCalledTimes(1);
    },
  );

  it.each([OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.PREPARING])(
    'owner can cancel a %s order (restaurant-side cancellation)',
    async (from: OrderStatus) => {
      const order = fakeOrder({ restaurantId: REST_ID, status: from });
      const { service } = buildActions(order);
      const out: any = await service.setStatusForRestaurant(
        REST_ID,
        ORDER_ID,
        OrderStatus.CANCELLED,
        ownerActor,
      );
      expect(out.status).toBe(OrderStatus.CANCELLED);
    },
  );

  it('refuses owner-cancel of a delivering order — food is already out', async () => {
    const order = fakeOrder({ restaurantId: REST_ID, status: OrderStatus.DELIVERING });
    const { service, save } = buildActions(order);
    await expect(
      service.setStatusForRestaurant(REST_ID, ORDER_ID, OrderStatus.CANCELLED, ownerActor),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });

  it('400s illegal transitions and leaves the order untouched', async () => {
    for (const [from, to] of [
      [OrderStatus.PENDING, OrderStatus.DELIVERING],
      [OrderStatus.PENDING, OrderStatus.COMPLETED],
      [OrderStatus.COMPLETED, OrderStatus.CONFIRMED],
      [OrderStatus.CANCELLED, OrderStatus.PENDING],
    ] as Array<[OrderStatus, OrderStatus]>) {
      const order = fakeOrder({ restaurantId: REST_ID, status: from });
      const { service, save } = buildActions(order);
      await expect(
        service.setStatusForRestaurant(REST_ID, ORDER_ID, to, ownerActor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(order.status).toBe(from);
      expect(save).not.toHaveBeenCalled();
    }
  });

  it('403s a non-owner before loading the order; admin bypasses', async () => {
    const order = fakeOrder({ restaurantId: REST_ID });
    const intruder = buildActions(order, { ownerId: INTRUDER_ID });
    await expect(
      intruder.service.setStatusForRestaurant(REST_ID, ORDER_ID, OrderStatus.CONFIRMED, {
        sub: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        role: UserRole.OWNER,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(intruder.findOne).not.toHaveBeenCalled();

    // Admin passes even an unowned (ownerId null) restaurant.
    const admin = buildActions(order, { ownerId: null });
    const out: any = await admin.service.setStatusForRestaurant(
      REST_ID,
      ORDER_ID,
      OrderStatus.CONFIRMED,
      { sub: ADMIN_ID, role: UserRole.ADMIN },
    );
    expect(out.status).toBe(OrderStatus.CONFIRMED);
  });

  it('404s an order that lives under a different restaurant than the path', async () => {
    const order = fakeOrder({ restaurantId: OTHER_REST });
    const { service, save } = buildActions(order);
    await expect(
      service.setStatusForRestaurant(REST_ID, ORDER_ID, OrderStatus.CONFIRMED, ownerActor),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(save).not.toHaveBeenCalled();
  });

  it('404s for unknown restaurant or malformed/garbage ids before saving', async () => {
    const order = fakeOrder({ restaurantId: REST_ID });

    const gone = buildActions(order, { restaurantExists: false });
    await expect(
      gone.service.setStatusForRestaurant(REST_ID, ORDER_ID, OrderStatus.CONFIRMED, ownerActor),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(gone.findOne).not.toHaveBeenCalled();

    const badOrder = buildActions(order);
    await expect(
      badOrder.service.setStatusForRestaurant(REST_ID, 'not-a-uuid', OrderStatus.CONFIRMED, ownerActor),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(badOrder.findOne).not.toHaveBeenCalled();

    const missing = buildActions(null);
    await expect(
      missing.service.setStatusForRestaurant(REST_ID, ORDER_ID, OrderStatus.CONFIRMED, ownerActor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('owner can action a guest order (userId null) under their restaurant', async () => {
    const order = fakeOrder({ restaurantId: REST_ID, userId: null });
    const { service } = buildActions(order);
    const out: any = await service.setStatusForRestaurant(
      REST_ID,
      ORDER_ID,
      OrderStatus.CONFIRMED,
      ownerActor,
    );
    expect(out.status).toBe(OrderStatus.CONFIRMED);
  });
});


describe('OrdersService — live event emission (SSE bus)', () => {
  const REST_ID = '11111111-1111-4111-8111-111111111111';
  const ownerActor = { sub: OWNER_ID, role: UserRole.OWNER };

  function buildActionsWithEvents(order: Order) {
    const findOne = jest.fn(async ({ where }: any) =>
      order && order.id === where.id ? order : null,
    );
    const save = jest.fn(async (x: Order) => x);
    const repo = { findOne, save } as unknown as Repository<Order>;
    const events = fakeEvents();
    const restaurants = {
      findOrderScope: jest.fn(async (id: string) => ({ id, ownerId: OWNER_ID } as any)),
    } as unknown as RestaurantsService;
    const service = new OrdersService(repo, {} as MenuService, restaurants, events, fakePromos(), fakeAddresses());
    return { service, events };
  }

  it('setStatusForRestaurant publishes order.updated with id/code/status payload', async () => {
    const order = fakeOrder({ restaurantId: REST_ID, status: OrderStatus.PENDING });
    const { service, events } = buildActionsWithEvents(order);
    await service.setStatusForRestaurant(REST_ID, ORDER_ID, OrderStatus.CONFIRMED, ownerActor);
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish.mock.calls[0][0]).toEqual({
      type: 'order.updated',
      restaurantId: REST_ID,
      userId: OWNER_ID,
      payload: { orderId: ORDER_ID, code: 'FO-TEST', status: 'confirmed' },
    });
  });

  it('customer cancel publishes order.updated too (owner inbox must react)', async () => {
    const order = fakeOrder({ restaurantId: REST_ID, status: OrderStatus.CONFIRMED });
    const { service, events } = buildActionsWithEvents(order);
    await service.cancel(ORDER_ID, OWNER_ID);
    expect(events.publish).toHaveBeenCalledWith({
      type: 'order.updated',
      restaurantId: REST_ID,
      userId: OWNER_ID,
      payload: { orderId: ORDER_ID, code: 'FO-TEST', status: 'cancelled' },
    });
  });

  it('admin-generic updateStatus publishes order.updated', async () => {
    const order = fakeOrder({ restaurantId: REST_ID, status: OrderStatus.PREPARING });
    const { service, events } = buildActionsWithEvents(order);
    await service.updateStatus(ORDER_ID, OrderStatus.DELIVERING);
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish.mock.calls[0][0].payload.status).toBe('delivering');
  });

  it('publishes NOTHING when the write fails validation or lookup', async () => {
    const order = fakeOrder({ restaurantId: REST_ID, status: OrderStatus.PENDING });
    const { service, events } = buildActionsWithEvents(order);
    await expect(
      service.setStatusForRestaurant(REST_ID, ORDER_ID, OrderStatus.COMPLETED, ownerActor),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('create publishes order.created after the order is saved', async () => {
    // Full create() path needs menu + restaurants pricing mocks.
    const created = fakeOrder({ restaurantId: REST_ID });
    const save = jest.fn(async (x: Partial<Order>) => ({ ...x, id: ORDER_ID }));
    const repo = {
      create: (x: any) => x,
      save,
      findOne: jest.fn(async () => created),
      // unit-of-work (session 71): mutations run inside manager.transaction
      manager: {
        transaction: jest.fn(async (cb: any) =>
          cb({
            save: async (x: any) => ({ ...x, id: ORDER_ID }),
            query: async () => [[{ stock: 99 }], 1],
          }),
        ),
      },
    } as unknown as Repository<Order>;
    const menu = {
      findByIds: jest.fn(async () => [
        { id: 'm1', name: 'Nasi', priceCents: 500, isAvailable: true, restaurantId: REST_ID },
      ]),
    } as unknown as MenuService;
    const restaurants = {
      findOrderScope: jest.fn(async () => ({
        id: REST_ID,
        ownerId: OWNER_ID,
        minOrderCents: 1000,
        deliveryFeeCents: 300,
      })),
    } as unknown as RestaurantsService;
    const events = fakeEvents();
    const service = new OrdersService(repo, menu, restaurants, events, fakePromos(), fakeAddresses());
    await service.create(
      { restaurantId: REST_ID, customerName: 'A', contactPhone: '1', deliveryAddress: 'x', items: [{ menuItemId: 'm1', quantity: 2 }] } as any,
      OWNER_ID,
    );
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish.mock.calls[0][0]).toMatchObject({
      type: 'order.created',
      restaurantId: REST_ID,
      payload: { orderId: ORDER_ID },
    });
  });
});

describe('OrdersService.assertStreamAccess — SSE ownership gate', () => {
  const REST_ID = '11111111-1111-4111-8111-111111111111';
  const ownerActor = { sub: OWNER_ID, role: UserRole.OWNER };

  function buildGate(opts: { ownerId?: string | null; restaurantExists?: boolean } = {}) {
    const restaurants = {
      findOrderScope: jest.fn(async (id: string) =>
        !isUuid(id) || opts.restaurantExists === false
          ? null
          : ({ id, ownerId: opts.ownerId ?? OWNER_ID } as any),
      ),
    } as unknown as RestaurantsService;
    const service = new OrdersService(
      {} as Repository<Order>,
      {} as MenuService,
      restaurants,
      fakeEvents(),
      fakePromos(),
      fakeAddresses(),
    );
    return { service, restaurants };
  }

  it('resolves for the owner and for an admin (bypass)', async () => {
    const { service } = buildGate();
    await expect(service.assertStreamAccess(REST_ID, ownerActor)).resolves.toMatchObject({
      id: REST_ID,
    });
    const admin = buildGate({ ownerId: null });
    await expect(
      admin.service.assertStreamAccess(REST_ID, { sub: OWNER_ID, role: UserRole.ADMIN }),
    ).resolves.toBeTruthy();
  });

  it('404s unknown/malformed, 403s foreign restaurants — same shape as the inbox', async () => {
    const gone = buildGate({ restaurantExists: false });
    await expect(gone.service.assertStreamAccess(REST_ID, ownerActor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(gone.service.assertStreamAccess('garbage', ownerActor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const foreign = buildGate({ ownerId: INTRUDER_ID });
    await expect(
      foreign.service.assertStreamAccess(REST_ID, ownerActor),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('OrdersService — status-step timestamps (tracking timeline)', () => {
  const REST_ID = '11111111-1111-4111-8111-111111111111';
  const ownerActor = { sub: OWNER_ID, role: UserRole.OWNER };

  beforeAll(() => jest.useFakeTimers({ now: new Date('2026-10-23T04:00:00Z') }));
  afterAll(() => jest.useRealTimers());

  function buildOwner(order: Order) {
    const findOne = jest.fn(async ({ where }: any) =>
      order && order.id === where.id ? order : null,
    );
    const save = jest.fn(async (x: Order) => x);
    const repo = { findOne, save } as unknown as Repository<Order>;
    const restaurants = {
      findOrderScope: jest.fn(async () => ({ id: REST_ID, ownerId: OWNER_ID } as any)),
    } as unknown as RestaurantsService;
    return new OrdersService(repo, {} as MenuService, restaurants, fakeEvents(), fakePromos(), fakeAddresses());
  }

  it('pending -> confirmed stamps confirmedAt only', async () => {
    const service = buildOwner(fakeOrder({ restaurantId: REST_ID }));
    const out: any = await service.setStatusForRestaurant(
      REST_ID, ORDER_ID, OrderStatus.CONFIRMED, ownerActor,
    );
    expect(out.confirmedAt).toEqual(new Date('2026-10-23T04:00:00Z'));
    expect(out.preparingAt).toBeNull();
    expect(out.deliveringAt).toBeNull();
    expect(out.completedAt).toBeNull();
    expect(out.cancelledAt).toBeNull();
  });

  it('stamps each step along a full walk and never re-stamps', async () => {
    const order = fakeOrder({ restaurantId: REST_ID });
    const service = buildOwner(order);
    const walk: Array<[OrderStatus, keyof Order]> = [
      [OrderStatus.CONFIRMED, 'confirmedAt'],
      [OrderStatus.PREPARING, 'preparingAt'],
      [OrderStatus.DELIVERING, 'deliveringAt'],
      [OrderStatus.COMPLETED, 'completedAt'],
    ];
    const seen = new Map<string, Date>();
    for (const [status, field] of walk) {
      jest.advanceTimersByTime(60_000); // one minute per step
      const out: any = await service.setStatusForRestaurant(
        REST_ID, ORDER_ID, status, ownerActor,
      );
      expect(out[field]).toEqual(new Date(Date.now()));
      seen.set(field as string, out[field]);
      // every earlier step keeps its original value
      for (const [prevField, prevVal] of seen) {
        if (prevField !== field) expect((out as any)[prevField]).toBe(prevVal);
      }
    }
  });

  it('write-once: a backfilled confirmedAt survives the confirmed -> preparing step', async () => {
    const old = new Date('2026-10-22T09:00:00Z');
    const order = fakeOrder({ restaurantId: REST_ID, status: OrderStatus.CONFIRMED, confirmedAt: old });
    const service = buildOwner(order);
    const out: any = await service.setStatusForRestaurant(
      REST_ID, ORDER_ID, OrderStatus.PREPARING, ownerActor,
    );
    expect(out.confirmedAt).toBe(old);
    expect(out.preparingAt).toEqual(new Date(Date.now()));
  });

  it('customer cancel stamps cancelledAt', async () => {
    const { service } = build([fakeOrder({ status: OrderStatus.PENDING })]);
    const out: any = await service.cancel(ORDER_ID, OWNER_ID);
    expect(out.status).toBe(OrderStatus.CANCELLED);
    expect(out.cancelledAt).toEqual(new Date(Date.now()));
    expect(out.confirmedAt).toBeNull();
  });

  it('admin PATCH path stamps too', async () => {
    const { service } = build([fakeOrder()]);
    const out: any = await service.updateStatus(ORDER_ID, OrderStatus.CONFIRMED);
    expect(out.confirmedAt).toEqual(new Date(Date.now()));
  });

  it('rejected transitions do not stamp anything', async () => {
    const order = fakeOrder({ restaurantId: REST_ID });
    const service = buildOwner(order);
    await expect(
      service.setStatusForRestaurant(REST_ID, ORDER_ID, OrderStatus.COMPLETED, ownerActor),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(order.confirmedAt).toBeNull();
    expect(order.completedAt).toBeNull();
  });
});
