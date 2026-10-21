import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import { Order, OrderStatus } from './order.entity';
import { MenuService } from '../menu/menu.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { UserRole } from '../users/user.entity';
import { isUuid } from '../common/uuid';

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
    items: [],
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  } as Order;
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
  const service = new OrdersService(
    repo as Repository<Order>,
    {} as MenuService,
    {} as RestaurantsService,
  );
  return { service, findOne, findAndCount, save };
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
    const service = new OrdersService(repo, {} as MenuService, restaurants);
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
