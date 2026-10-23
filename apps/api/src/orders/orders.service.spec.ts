import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { OrdersService } from './orders.service';
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
  const findAndCount = jest.fn(async ({ where, skip, take }: any) => {
    const all = orders
      .filter(
        (o) =>
          o.userId === where.userId &&
          (!where.status || o.status === where.status),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const page = all.slice(skip ?? 0, (skip ?? 0) + (take ?? all.length));
    return [page, all.length];
  });
  const save = jest.fn(async (x: Order) => x);
  const repo = { findOne, findAndCount, save } as unknown as jest.Mocked<
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
  return { service, findOne, findAndCount, save, events };
}

describe('OrdersService.findMine — pagination + status filter', () => {
  it('uses defaults page=1/limit=20 and scopes by userId', async () => {
    const { service, findAndCount } = build();
    const out: any = await service.findMine(OWNER_ID, {});
    const args = (findAndCount as jest.Mock).mock.calls[0][0];
    expect(args.where).toEqual({ userId: OWNER_ID });
    expect(args.skip).toBe(0);
    expect(args.take).toBe(20);
    expect(args.order).toEqual({ createdAt: 'DESC' });
    // history cards show a line summary + restaurant without extra calls
    expect(args.relations).toEqual({ restaurant: true, items: true });
    expect(out).toMatchObject({ page: 1, limit: 20 });
    expect(Array.isArray(out.items)).toBe(true);
  });

  it('passes an explicit status into the where clause', async () => {
    const { service, findAndCount } = build();
    await service.findMine(OWNER_ID, { status: OrderStatus.DELIVERING });
    const args = (findAndCount as jest.Mock).mock.calls[0][0];
    expect(args.where).toEqual({ userId: OWNER_ID, status: 'delivering' });
  });

  it('computes skip from page/limit', async () => {
    const { service, findAndCount } = build();
    await service.findMine(OWNER_ID, { page: 3, limit: 10 });
    const args = (findAndCount as jest.Mock).mock.calls[0][0];
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
  });

  it('clamps junk defensively even if the DTO let it through', async () => {
    const { service, findAndCount } = build();
    const out: any = await service.findMine(OWNER_ID, { page: 0 as any, limit: 999 as any });
    const args = (findAndCount as jest.Mock).mock.calls[0][0];
    expect(args.skip).toBe(0);
    expect(args.take).toBe(50);
    expect(out.page).toBe(1);
    expect(out.limit).toBe(50);
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
    const findAndCount = jest.fn(async ({ where, skip, take }: any) => {
      const all = orders
        .filter(
          (o) =>
            o.restaurantId === where.restaurantId &&
            (!where.status || o.status === where.status),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return [all.slice(skip ?? 0, (skip ?? 0) + (take ?? all.length)), all.length];
    });
    const count = jest.fn(async ({ where }: any) =>
      orders.filter((o) => o.restaurantId === where.restaurantId && o.status === where.status)
        .length,
    );
    const repo = { findAndCount, count } as unknown as Repository<Order>;
    const restaurants = {
      findOne: jest.fn(async (id: string) =>
        !isUuid(id) || opts.restaurantExists === false
          ? null
          : ({ id, ownerId: opts.ownerId ?? OWNER_ID } as any),
      ),
    } as unknown as RestaurantsService;
    const service = new OrdersService(repo, {} as MenuService, restaurants, fakeEvents(), fakePromos(), fakeAddresses());
    return { service, findAndCount, count, restaurants };
  }

  const at = (n: number) => new Date(2026, 9, n);

  it('404s for an unknown or malformed restaurant id before listing anything', async () => {
    const { service, findAndCount } = buildPortal([], { restaurantExists: false });
    await expect(service.findForRestaurant(REST_ID, ownerActor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findAndCount).not.toHaveBeenCalled();

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
    const { service, findAndCount } = buildPortal(rows);
    const out: any = await service.findForRestaurant(REST_ID, ownerActor, { page: 2, limit: 5 });
    expect(out).toMatchObject({ page: 2, limit: 5, total: 12 });
    expect(out.items.length).toBe(5);
    expect(out.items[0].createdAt).toEqual(at(7)); // 6th newest
    const args = (findAndCount as jest.Mock).mock.calls[0][0];
    expect(args.relations).toEqual({ items: true });
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
    const { service, count } = buildPortal(rows);
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
    expect((count as jest.Mock).mock.calls.length).toBe(6);
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
      findOne: jest.fn(async (id: string) =>
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
      findOne: jest.fn(async (id: string) => ({ id, ownerId: OWNER_ID } as any)),
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
    } as unknown as Repository<Order>;
    const menu = {
      findByIds: jest.fn(async () => [
        { id: 'm1', name: 'Nasi', priceCents: 500, isAvailable: true, restaurantId: REST_ID },
      ]),
    } as unknown as MenuService;
    const restaurants = {
      findOne: jest.fn(async () => ({
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
      findOne: jest.fn(async (id: string) =>
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
      findOne: jest.fn(async () => ({ id: REST_ID, ownerId: OWNER_ID } as any)),
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
