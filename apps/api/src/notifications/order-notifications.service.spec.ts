import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Subject } from 'rxjs';
import { OrderNotificationsService } from './order-notifications.service';
import { MailService } from './mail.service';
import { OrderEventsService, OrderEvent } from '../orders/order-events.service';
import { Order, OrderStatus } from '../orders/order.entity';
import { User } from '../users/user.entity';

// ── helpers ────────────────────────────────────────────────────────────────
function makeOrder(overrides: Partial<Order> = {}): Order {
  const o: Partial<Order> = {
    id: 'order-1',
    code: 'FO-TEST',
    status: OrderStatus.PENDING,
    customerName: 'Alice',
    deliveryAddress: '123 Main St',
    userId: 'user-1',
    subtotalCents: 10000,
    discountCents: 0,
    promoCode: null,
    deliveryFeeCents: 2000,
    totalCents: 12000,
    items: [
      { name: 'Burger', quantity: 2, unitPriceCents: 5000 } as never,
    ],
    restaurant: { name: 'Burger Palace' } as never,
    ...overrides,
  };
  return o as Order;
}

function makeUser(overrides: Partial<User> = {}): User {
  return { id: 'user-1', email: 'alice@example.com', name: 'Alice', ...overrides } as User;
}

// ── tests ──────────────────────────────────────────────────────────────────
describe('OrderNotificationsService', () => {
  let svc: OrderNotificationsService;
  let bus: Subject<OrderEvent>;
  let mailSend: jest.Mock;
  let ordersFindOne: jest.Mock;
  let usersFindOne: jest.Mock;

  beforeEach(async () => {
    bus = new Subject<OrderEvent>();
    mailSend = jest.fn().mockResolvedValue(undefined);
    ordersFindOne = jest.fn();
    usersFindOne = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderNotificationsService,
        {
          provide: MailService,
          useValue: { send: mailSend, enabled: true },
        },
        {
          provide: OrderEventsService,
          useValue: { stream: () => bus.asObservable() },
        },
        {
          provide: getRepositoryToken(Order),
          useValue: { findOne: ordersFindOne },
        },
        {
          provide: getRepositoryToken(User),
          useValue: { findOne: usersFindOne },
        },
      ],
    }).compile();

    svc = module.get(OrderNotificationsService);
    svc.onModuleInit();
  });

  afterEach(() => jest.clearAllMocks());

  describe('order.created event', () => {
    it('sends order-confirmation email to authenticated user', async () => {
      ordersFindOne.mockResolvedValue(makeOrder());
      usersFindOne.mockResolvedValue(makeUser());

      bus.next({
        type: 'order.created',
        restaurantId: 'resto-1',
        userId: 'user-1',
        payload: { orderId: 'order-1', code: 'FO-TEST', status: 'pending' },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(mailSend).toHaveBeenCalledTimes(1);
      const call = mailSend.mock.calls[0][0] as Record<string, unknown>;
      expect(call.to).toBe('alice@example.com');
      expect(call.subject).toContain('FO-TEST');
      expect(call.text).toContain('Alice');
      expect(call.text).toContain('Burger Palace');
      expect(call.text).toContain('IDR');
    });

    it('skips email for guest orders (no userId)', async () => {
      const guestOrder = makeOrder({ userId: undefined as unknown as string });
      ordersFindOne.mockResolvedValue(guestOrder);

      bus.next({
        type: 'order.created',
        restaurantId: 'resto-1',
        userId: null,
        payload: { orderId: 'order-1', code: 'FO-TEST', status: 'pending' },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(mailSend).not.toHaveBeenCalled();
    });

    it('skips email when order is not found', async () => {
      ordersFindOne.mockResolvedValue(null);

      bus.next({
        type: 'order.created',
        restaurantId: 'resto-1',
        userId: 'user-1',
        payload: { orderId: 'missing', code: 'FO-X', status: 'pending' },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(mailSend).not.toHaveBeenCalled();
    });

    it('includes promo discount line when applicable', async () => {
      ordersFindOne.mockResolvedValue(makeOrder({ discountCents: 1000, promoCode: 'SAVE10' }));
      usersFindOne.mockResolvedValue(makeUser());

      bus.next({
        type: 'order.created',
        restaurantId: 'resto-1',
        userId: 'user-1',
        payload: { orderId: 'order-1', code: 'FO-TEST', status: 'pending' },
      });

      await new Promise((r) => setTimeout(r, 10));
      const text = mailSend.mock.calls[0][0].text as string;
      expect(text).toContain('SAVE10');
      expect(text).toContain('Discount');
    });
  });

  describe('order.updated event', () => {
    it.each([
      ['confirmed', 'has been confirmed'],
      ['preparing', 'being prepared'],
      ['delivering', "on its way"],
      ['completed', 'has been delivered'],
      ['cancelled', 'has been cancelled'],
    ])('sends status-update email for status=%s', async (status, expectedText) => {
      ordersFindOne.mockResolvedValue(makeOrder({ status: status as OrderStatus }));
      usersFindOne.mockResolvedValue(makeUser());

      bus.next({
        type: 'order.updated',
        restaurantId: 'resto-1',
        userId: 'user-1',
        payload: { orderId: 'order-1', code: 'FO-TEST', status },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(mailSend).toHaveBeenCalledTimes(1);
      const call = mailSend.mock.calls[0][0] as Record<string, unknown>;
      expect(call.text).toContain(expectedText);
    });

    it('does NOT send email for pending status updates (no label defined)', async () => {
      bus.next({
        type: 'order.updated',
        restaurantId: 'resto-1',
        userId: 'user-1',
        payload: { orderId: 'order-1', code: 'FO-TEST', status: 'pending' },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(mailSend).not.toHaveBeenCalled();
    });

    it('skips email for guest orders (no userId on updated event)', async () => {
      ordersFindOne.mockResolvedValue(makeOrder({ userId: undefined as unknown as string }));
      usersFindOne.mockResolvedValue(null);

      bus.next({
        type: 'order.updated',
        restaurantId: 'resto-1',
        userId: null,
        payload: { orderId: 'order-1', code: 'FO-TEST', status: 'confirmed' },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(mailSend).not.toHaveBeenCalled();
    });
  });
});
