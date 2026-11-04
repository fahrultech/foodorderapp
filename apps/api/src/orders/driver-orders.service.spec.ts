import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import { Order, OrderStatus } from './order.entity';
import { OrderEventsService } from './order-events.service';
import { MenuService } from '../menu/menu.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { PromosService } from '../promos/promos.service';
import { AddressesService } from '../users/addresses.service';
import { UsersService } from '../users/users.service';
import { UserRole } from '../users/user.entity';

const REST_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_REST_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DRIVER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_DRIVER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ownerActor = { sub: OWNER_ID, role: UserRole.OWNER };

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    code: 'FO-DRVR',
    userId: null,
    restaurantId: REST_ID,
    driverId: null,
    driver: null,
    status: OrderStatus.PREPARING,
    items: [],
    confirmedAt: new Date('2026-11-03T08:00:00Z'),
    preparingAt: new Date('2026-11-03T08:10:00Z'),
    deliveringAt: null,
    completedAt: null,
    cancelledAt: null,
    subtotalCents: 1000,
    discountCents: 0,
    promoCode: null,
    deliveryFeeCents: 200,
    totalCents: 1200,
    customerName: 'Diner',
    contactPhone: '0800',
    deliveryAddress: 'Street 1',
    note: null,
    createdAt: new Date('2026-11-03T07:50:00Z'),
    updatedAt: new Date('2026-11-03T08:10:00Z'),
    ...overrides,
  } as Order;
}

function build(rows: Order[] = [order()], userRole: UserRole | null = UserRole.DRIVER) {
  const findOne = jest.fn(async ({ where }: any) =>
    rows.find(
      (row) =>
        row.id === where.id &&
        (where.driverId === undefined || row.driverId === where.driverId),
    ) ?? null,
  );
  const findAndCount = jest.fn(async ({ where, skip, take }: any) => {
    const matched = rows.filter(
      (row) =>
        row.driverId === where.driverId &&
        (!where.status || row.status === where.status),
    );
    return [matched.slice(skip ?? 0, (skip ?? 0) + (take ?? matched.length)), matched.length];
  });
  const save = jest.fn(async (value: Order) => value);
  const repo = { findOne, findAndCount, save } as unknown as Repository<Order>;
  const restaurants = {
    findOne: jest.fn(async () => ({ id: REST_ID, ownerId: OWNER_ID })),
  } as unknown as RestaurantsService;
  const events = { publish: jest.fn() } as unknown as OrderEventsService & { publish: jest.Mock };
  const users = {
    findById: jest.fn(async (id: string) =>
      userRole === null ? null : ({ id, role: userRole }),
    ),
  } as unknown as UsersService & { findById: jest.Mock };
  const service = new OrdersService(
    repo,
    {} as MenuService,
    restaurants,
    events,
    { evaluate: jest.fn() } as unknown as PromosService,
    { getOwned: jest.fn() } as unknown as AddressesService,
    undefined,
    undefined,
    users,
  );
  return { service, findOne, findAndCount, save, events, users };
}

describe('OrdersService.assignDriverForRestaurant', () => {
  it('assigns a DRIVER to a nonterminal order scoped by owner + restaurant and emits order.updated', async () => {
    const h = build();
    const result = await h.service.assignDriverForRestaurant(
      REST_ID,
      ORDER_ID,
      DRIVER_ID,
      ownerActor,
    );
    expect(result.driverId).toBe(DRIVER_ID);
    expect(h.users.findById).toHaveBeenCalledWith(DRIVER_ID);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.events.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'order.updated',
        restaurantId: REST_ID,
        driverIds: [DRIVER_ID],
      }),
    );
  });

  it('accepts null to unassign without looking up a user', async () => {
    const h = build([order({ driverId: DRIVER_ID })]);
    const result = await h.service.assignDriverForRestaurant(
      REST_ID,
      ORDER_ID,
      null,
      ownerActor,
    );
    expect(result.driverId).toBeNull();
    expect(h.users.findById).not.toHaveBeenCalled();
    expect(h.events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ driverIds: [DRIVER_ID] }),
    );
  });

  it.each([null, UserRole.CUSTOMER, UserRole.OWNER, UserRole.ADMIN])(
    'rejects a missing or non-driver target (%s)',
    async (role) => {
      const h = build([order()], role);
      await expect(
        h.service.assignDriverForRestaurant(REST_ID, ORDER_ID, DRIVER_ID, ownerActor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(h.save).not.toHaveBeenCalled();
    },
  );

  it.each([OrderStatus.COMPLETED, OrderStatus.CANCELLED])(
    'rejects assignment changes on terminal %s orders',
    async (status) => {
      const h = build([order({ status })]);
      await expect(
        h.service.assignDriverForRestaurant(REST_ID, ORDER_ID, DRIVER_ID, ownerActor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(h.users.findById).not.toHaveBeenCalled();
      expect(h.save).not.toHaveBeenCalled();
    },
  );

  it('404s a foreign-path order before driver lookup', async () => {
    const h = build([order({ restaurantId: OTHER_REST_ID })]);
    await expect(
      h.service.assignDriverForRestaurant(REST_ID, ORDER_ID, DRIVER_ID, ownerActor),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.users.findById).not.toHaveBeenCalled();
  });
});

describe('OrdersService.findForDriver', () => {
  it('pages and filters only orders assigned to the JWT subject', async () => {
    const h = build([
      order({ driverId: DRIVER_ID }),
      order({ id: '44444444-4444-4444-8444-444444444444', driverId: OTHER_DRIVER_ID }),
    ]);
    const result = await h.service.findForDriver(DRIVER_ID, {
      status: OrderStatus.PREPARING,
      page: 2,
      limit: 5,
    });
    expect(result).toMatchObject({ total: 1, page: 2, limit: 5 });
    expect(h.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { driverId: DRIVER_ID, status: OrderStatus.PREPARING },
        relations: { restaurant: true, items: true },
        skip: 5,
        take: 5,
      }),
    );
  });
});

describe('OrdersService.setStatusForDriver', () => {
  it.each([
    [OrderStatus.PREPARING, OrderStatus.DELIVERING, 'deliveringAt'],
    [OrderStatus.DELIVERING, OrderStatus.COMPLETED, 'completedAt'],
  ] as const)('allows assigned driver %s → %s and emits', async (from, to, stamp) => {
    const h = build([order({ driverId: DRIVER_ID, status: from })]);
    const result = await h.service.setStatusForDriver(ORDER_ID, to, DRIVER_ID);
    expect(result.status).toBe(to);
    expect(result[stamp]).toBeInstanceOf(Date);
    expect(h.events.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'order.updated',
        restaurantId: REST_ID,
        driverIds: [DRIVER_ID],
      }),
    );
  });

  it('returns the same 404 for unknown and foreign assignments', async () => {
    const missing = build([]);
    await expect(
      missing.service.setStatusForDriver(ORDER_ID, OrderStatus.DELIVERING, DRIVER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);

    const foreign = build([order({ driverId: OTHER_DRIVER_ID })]);
    await expect(
      foreign.service.setStatusForDriver(ORDER_ID, OrderStatus.DELIVERING, DRIVER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(foreign.save).not.toHaveBeenCalled();
  });

  it.each([
    [OrderStatus.PREPARING, OrderStatus.COMPLETED],
    [OrderStatus.DELIVERING, OrderStatus.CANCELLED],
    [OrderStatus.CONFIRMED, OrderStatus.DELIVERING],
    [OrderStatus.COMPLETED, OrderStatus.COMPLETED],
  ])('rejects illegal driver transition %s → %s with 400', async (from, to) => {
    const h = build([order({ driverId: DRIVER_ID, status: from })]);
    await expect(
      h.service.setStatusForDriver(ORDER_ID, to, DRIVER_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('404s a malformed id without querying', async () => {
    const h = build();
    await expect(
      h.service.setStatusForDriver('bad-id', OrderStatus.DELIVERING, DRIVER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.findOne).not.toHaveBeenCalled();
  });
});
