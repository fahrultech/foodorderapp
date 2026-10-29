import { HttpStatus } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { ConfigService } from '@nestjs/config';
import { OrdersService } from './orders.service';
import { Order, OrderStatus } from './order.entity';
import { Payment, PaymentStatus } from '../payments/payment.entity';
import { AppException } from '../common/app-exception';
import { confirmGateEnabled } from './payment-confirm-gate';
import { OrderEventsService } from './order-events.service';
import { MenuService } from '../menu/menu.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { PromosService } from '../promos/promos.service';
import { AddressesService } from '../users/addresses.service';
import { UserRole } from '../users/user.entity';

const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const REST_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function fakeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    code: 'FO-GATE',
    userId: OWNER_ID,
    restaurantId: REST_ID,
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

const ownerActor = { sub: OWNER_ID, role: UserRole.OWNER };

/**
 * Build a fully-wired service (payments repo + config included).
 * `paid` = what payments.exist() answers; `flag` = raw env value.
 */
function build(opts: {
  order?: Order;
  paid: boolean;
  flag?: string | undefined;
  withPayments?: boolean;
}) {
  const order = opts.order ?? fakeOrder();
  const findOne = jest.fn(async ({ where }: any) =>
    order.id === where.id || order.id === where.orderId ? order : null,
  );
  const save = jest.fn(async (x: Order) => x);
  const ordersRepo = { findOne, save } as unknown as Repository<Order>;

  const restaurants = {
    findOne: jest.fn(async (id: string) => ({ id, ownerId: OWNER_ID } as any)),
  } as unknown as RestaurantsService;

  const exist = jest.fn(async () => opts.paid);
  const paymentsRepo = { exist } as unknown as Repository<Payment>;

  const config = {
    get: jest.fn(() => opts.flag),
  } as unknown as ConfigService;

  const service = new OrdersService(
    ordersRepo,
    {} as MenuService,
    restaurants,
    { publish: jest.fn() } as unknown as OrderEventsService,
    { evaluate: jest.fn() } as unknown as PromosService,
    { getOwned: jest.fn() } as unknown as AddressesService,
    opts.withPayments === false ? undefined : paymentsRepo,
    opts.withPayments === false ? undefined : config,
  );
  return { service, order, findOne, save, exist, config };
}

describe('confirmGateEnabled — flag parsing (ENABLED BY DEFAULT, explicit opt-out)', () => {
  it.each([undefined, null, '', '1', 'true', 'TRUE', ' yes ', 'On', 'maybe', 'ture', 'enable'])(
    'treats %j as ON (unset/garbage keeps the gate on — fail-closed)',
    (raw) => {
      expect(confirmGateEnabled(raw as string | undefined)).toBe(true);
    },
  );
  it.each(['0', 'false', 'FALSE', 'no', 'off', ' Off ', 'NO'])(
    'treats %j as OFF (the deliberate opt-out spelling only)',
    (raw) => {
      expect(confirmGateEnabled(raw)).toBe(false);
    },
  );
});

describe('Order-confirm gate — owner portal path', () => {
  it('402 PAYMENT_REQUIRED confirms nothing when the flag is ON and no payment succeeded', async () => {
    const { service, save, exist, order } = build({ paid: false, flag: '1' });
    const err = await service
      .setStatusForRestaurant(REST_ID, ORDER_ID, OrderStatus.CONFIRMED, ownerActor)
      .catch((e) => e);
    expect(err).toBeInstanceOf(AppException);
    expect((err as AppException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect((err as AppException).code).toBe('PAYMENT_REQUIRED');
    expect(save).not.toHaveBeenCalled();
    expect(order.status).toBe(OrderStatus.PENDING);
    expect(order.confirmedAt).toBeNull();
    // The query is an existence probe scoped to THIS order + succeeded status.
    expect(exist).toHaveBeenCalledWith({
      where: { orderId: ORDER_ID, status: PaymentStatus.SUCCEEDED },
    });
  });

  it('confirms normally when a succeeded payment exists', async () => {
    const { service, save } = build({ paid: true, flag: 'true' });
    const out: any = await service.setStatusForRestaurant(
      REST_ID, ORDER_ID, OrderStatus.CONFIRMED, ownerActor,
    );
    expect(out.status).toBe(OrderStatus.CONFIRMED);
    expect(out.confirmedAt).toBeInstanceOf(Date);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('a REFUNDED payment does not satisfy the gate (query stays status-scoped)', async () => {
    const { service, exist } = build({ paid: false, flag: 'on' });
    await expect(
      service.setStatusForRestaurant(REST_ID, ORDER_ID, OrderStatus.CONFIRMED, ownerActor),
    ).rejects.toBeInstanceOf(AppException);
    expect(exist).toHaveBeenCalledWith({
      where: { orderId: ORDER_ID, status: PaymentStatus.SUCCEEDED },
    });
  });

  it('flag unset (the production default): the gate is ON — unpaid confirm 402s', async () => {
    const { service, save, exist } = build({ paid: false, flag: undefined });
    const err = await service
      .setStatusForRestaurant(REST_ID, ORDER_ID, OrderStatus.CONFIRMED, ownerActor)
      .catch((e) => e);
    expect(err).toBeInstanceOf(AppException);
    expect((err as AppException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect(save).not.toHaveBeenCalled();
    expect(exist).toHaveBeenCalledTimes(1);
  });

  it("explicit opt-out 'off': no payment is consulted at all and confirm works (zero regression)", async () => {
    const { service, save, exist } = build({ paid: false, flag: 'off' });
    const out: any = await service.setStatusForRestaurant(
      REST_ID, ORDER_ID, OrderStatus.CONFIRMED, ownerActor,
    );
    expect(out.status).toBe(OrderStatus.CONFIRMED);
    expect(exist).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flag ON does not touch non-confirm transitions — cancel stays payment-free', async () => {
    const { service, exist, save } = build({
      order: fakeOrder({ status: OrderStatus.CONFIRMED }),
      paid: false,
      flag: '1',
    });
    const out: any = await service.setStatusForRestaurant(
      REST_ID, ORDER_ID, OrderStatus.CANCELLED, ownerActor,
    );
    expect(out.status).toBe(OrderStatus.CANCELLED);
    expect(exist).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('illegal transition still answers 400 BEFORE any payment lookup', async () => {
    const { service, exist } = build({ paid: false, flag: '1' });
    await expect(
      service.setStatusForRestaurant(REST_ID, ORDER_ID, OrderStatus.COMPLETED, ownerActor),
    ).rejects.toThrow(/Cannot move order/);
    expect(exist).not.toHaveBeenCalled();
  });

  it('construction without the payments repo keeps the gate inert (legacy specs)', async () => {
    const { service, save } = build({ paid: false, flag: '1', withPayments: false });
    const out: any = await service.setStatusForRestaurant(
      REST_ID, ORDER_ID, OrderStatus.CONFIRMED, ownerActor,
    );
    expect(out.status).toBe(OrderStatus.CONFIRMED);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('Order-confirm gate — ADMIN backdoor path (no step-around)', () => {
  it('402s a flagged confirm through updateStatus too, saving nothing', async () => {
    const { service, save } = build({ paid: false, flag: '1' });
    const err = await service
      .updateStatus(ORDER_ID, OrderStatus.CONFIRMED)
      .catch((e) => e);
    expect(err).toBeInstanceOf(AppException);
    expect((err as AppException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect(save).not.toHaveBeenCalled();
  });

  it('passes updateStatus confirm when paid', async () => {
    const { service, save } = build({ paid: true, flag: '1' });
    const out: any = await service.updateStatus(ORDER_ID, OrderStatus.CONFIRMED);
    expect(out.status).toBe(OrderStatus.CONFIRMED);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
