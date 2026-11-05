import { Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { OrderStatusAudit, OrderStatusAuditSource } from './order-status-audit.entity';
import { OrdersService } from './orders.service';
import { MenuService } from '../menu/menu.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { OrderEventsService } from './order-events.service';
import { PromosService } from '../promos/promos.service';
import { AddressesService } from '../users/addresses.service';
import { UserRole } from '../users/user.entity';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESTAURANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DRIVER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ADMIN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function order(status: OrderStatus, overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    code: 'FO-AUD1',
    restaurantId: RESTAURANT_ID,
    userId: OWNER_ID,
    driverId: DRIVER_ID,
    status,
    confirmedAt: null,
    preparingAt: null,
    deliveringAt: null,
    completedAt: null,
    cancelledAt: null,
    ...overrides,
  } as Order;
}

function build(current: Order) {
  const orders = {
    findOne: jest.fn(async ({ where }: any) => {
      if (where?.id !== ORDER_ID) return null;
      if (where?.driverId && where.driverId !== current.driverId) return null;
      return current;
    }),
    save: jest.fn(async (value: Order) => value),
  } as unknown as Repository<Order> & { findOne: jest.Mock; save: jest.Mock };
  const audits = {
    create: jest.fn((value: Partial<OrderStatusAudit>) => value),
    save: jest.fn(async (value: Partial<OrderStatusAudit>) => value),
  } as unknown as Repository<OrderStatusAudit> & { create: jest.Mock; save: jest.Mock };
  const restaurants = {
    findOne: jest.fn(async () => ({ id: RESTAURANT_ID, ownerId: OWNER_ID })),
  } as unknown as RestaurantsService;
  const service = new OrdersService(
    orders,
    {} as MenuService,
    restaurants,
    { publish: jest.fn() } as unknown as OrderEventsService,
    {} as PromosService,
    {} as AddressesService,
    undefined,
    undefined,
    undefined,
    audits,
  );
  return { service, audits };
}

function savedAudit(audits: { save: jest.Mock }) {
  expect(audits.save).toHaveBeenCalledTimes(1);
  return audits.save.mock.calls[0][0] as Partial<OrderStatusAudit>;
}

describe('OrdersService status audit trail', () => {
  it('records an owner transition with before/after status and actor snapshot', async () => {
    const { service, audits } = build(order(OrderStatus.CONFIRMED));
    await service.setStatusForRestaurant(
      RESTAURANT_ID,
      ORDER_ID,
      OrderStatus.PREPARING,
      { sub: OWNER_ID, role: UserRole.OWNER, email: 'owner@example.test' },
    );
    expect(savedAudit(audits)).toMatchObject({
      orderId: ORDER_ID,
      fromStatus: OrderStatus.CONFIRMED,
      toStatus: OrderStatus.PREPARING,
      source: OrderStatusAuditSource.OWNER,
      actorUserId: OWNER_ID,
      actorRole: UserRole.OWNER,
      actorEmail: 'owner@example.test',
    });
  });

  it('records driver and customer transitions with their exact source', async () => {
    const driver = build(order(OrderStatus.PREPARING));
    await driver.service.setStatusForDriver(
      ORDER_ID,
      OrderStatus.DELIVERING,
      DRIVER_ID,
      'driver@example.test',
    );
    expect(savedAudit(driver.audits)).toMatchObject({
      fromStatus: OrderStatus.PREPARING,
      toStatus: OrderStatus.DELIVERING,
      source: OrderStatusAuditSource.DRIVER,
      actorUserId: DRIVER_ID,
      actorRole: UserRole.DRIVER,
      actorEmail: 'driver@example.test',
    });

    const customer = build(order(OrderStatus.CONFIRMED));
    await customer.service.cancel(ORDER_ID, OWNER_ID, UserRole.CUSTOMER, 'customer@example.test');
    expect(savedAudit(customer.audits)).toMatchObject({
      fromStatus: OrderStatus.CONFIRMED,
      toStatus: OrderStatus.CANCELLED,
      source: OrderStatusAuditSource.CUSTOMER,
      actorUserId: OWNER_ID,
      actorRole: UserRole.CUSTOMER,
      actorEmail: 'customer@example.test',
    });
  });

  it('records the generic admin route and stale sweep with distinct sources', async () => {
    const admin = build(order(OrderStatus.PREPARING));
    await admin.service.updateStatus(
      ORDER_ID,
      OrderStatus.DELIVERING,
      { sub: ADMIN_ID, role: UserRole.ADMIN, email: 'admin@example.test' },
    );
    expect(savedAudit(admin.audits)).toMatchObject({
      source: OrderStatusAuditSource.ADMIN,
      actorUserId: ADMIN_ID,
      actorRole: UserRole.ADMIN,
    });

    const stale = build(order(OrderStatus.PENDING, { createdAt: new Date(0) }));
    (stale.service as any).orders.find = jest.fn(async () => [order(OrderStatus.PENDING, { createdAt: new Date(0) })]);
    await stale.service.cancelStalePending({
      now: new Date('2026-11-05T00:00:00Z'),
      staleMinutes: 1,
    });
    expect(savedAudit(stale.audits)).toMatchObject({
      fromStatus: OrderStatus.PENDING,
      toStatus: OrderStatus.CANCELLED,
      source: OrderStatusAuditSource.STALE_SWEEP,
      actorUserId: null,
      actorRole: null,
      actorEmail: null,
    });
  });

  it('does not write an audit row when a transition is rejected', async () => {
    const { service, audits } = build(order(OrderStatus.COMPLETED));
    await expect(
      service.setStatusForRestaurant(
        RESTAURANT_ID,
        ORDER_ID,
        OrderStatus.PREPARING,
        { sub: OWNER_ID, role: UserRole.OWNER },
      ),
    ).rejects.toThrow();
    expect(audits.save).not.toHaveBeenCalled();
  });
});
