import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Subject } from 'rxjs';
import { OrderNotificationsService } from './order-notifications.service';
import { MailService } from './mail.service';
import { OrderEventsService, OrderEvent } from '../orders/order-events.service';
import { Order, OrderStatus } from '../orders/order.entity';
import { User } from '../users/user.entity';
import { PushService } from './push.service';
import { verifyReceiptAccessToken } from '../orders/receipt-access';

// ── helpers ────────────────────────────────────────────────────────────────
function makeOrder(overrides: Partial<Order> = {}): Order {
  const o: Partial<Order> = {
    id: 'order-1',
    code: 'FO-TEST',
    status: OrderStatus.PENDING,
    customerName: 'Alice',
    deliveryAddress: '123 Main St',
    userId: 'user-1',
    contactEmail: null,
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
  let pushSend: jest.Mock;
  let ordersFindOne: jest.Mock;
  let usersFindOne: jest.Mock;

  beforeEach(async () => {
    bus = new Subject<OrderEvent>();
    mailSend = jest.fn().mockResolvedValue(undefined);
    pushSend = jest.fn().mockResolvedValue(undefined);
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
          provide: PushService,
          useValue: { sendToUser: pushSend },
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
      // Session 134: the channel arg is what the mail telemetry tallies on.
      expect(mailSend.mock.calls[0][1]).toBe('confirmation');
      expect(call.to).toBe('alice@example.com');
      expect(call.subject).toContain('FO-TEST');
      expect(call.text).toContain('Alice');
      expect(call.text).toContain('Burger Palace');
      expect(call.text).toContain('IDR');
      expect(pushSend).toHaveBeenCalledWith('user-1', {
        title: 'Order received — #FO-TEST',
        body: 'Burger Palace received your order.',
        url: '/orders/order-1',
        tag: 'order-order-1',
      });
    });

    it('sends a bilingual (EN+ID) confirmation to the guest contactEmail, no push', async () => {
      const guestOrder = makeOrder({
        userId: undefined as unknown as string,
        contactEmail: 'guest@example.com',
      });
      ordersFindOne.mockResolvedValue(guestOrder);

      bus.next({
        type: 'order.created',
        restaurantId: 'resto-1',
        userId: null,
        payload: { orderId: 'order-1', code: 'FO-TEST', status: 'pending' },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(mailSend).toHaveBeenCalledTimes(1);
      const call = mailSend.mock.calls[0][0] as Record<string, unknown>;
      expect(call.to).toBe('guest@example.com');
      expect(call.subject).toBe('Order confirmed / Pesanan dikonfirmasi — #FO-TEST');
      expect(String(call.text)).toContain('Hi Alice,');
      expect(String(call.text)).toContain('Hai Alice,');
      expect(String(call.text)).toContain('Kirim ke: 123 Main St');
      // Guests have no bearer identity — push subscriptions are JWT-scoped.
      expect(pushSend).not.toHaveBeenCalled();
      // No user lookup for guest orders.
      expect(usersFindOne).not.toHaveBeenCalled();
    });

    it('re-normalizes a non-canonical stored contactEmail before sending', async () => {
      const guestOrder = makeOrder({
        userId: undefined as unknown as string,
        contactEmail: '  Guest@Example.COM ',
      });
      ordersFindOne.mockResolvedValue(guestOrder);

      bus.next({
        type: 'order.created',
        restaurantId: 'resto-1',
        userId: null,
        payload: { orderId: 'order-1', code: 'FO-TEST', status: 'pending' },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(mailSend).toHaveBeenCalledTimes(1);
      expect(mailSend.mock.calls[0][0].to).toBe('guest@example.com');
    });

    it('still skips email for guest orders WITHOUT a contactEmail (silent)', async () => {
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
      expect(pushSend).not.toHaveBeenCalled();
    });

    it('bearer-only rule: an AUTHED order with contactEmail set still mails ONLY user.email, EN-only', async () => {
      ordersFindOne.mockResolvedValue(
        makeOrder({ contactEmail: 'someone-else@example.com' }),
      );
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
      // Authed copy stays English-only until a stored per-user locale lands.
      expect(String(call.subject)).toBe('Order confirmed — #FO-TEST');
      expect(String(call.text)).not.toContain('Pesanan');
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
      expect(pushSend).not.toHaveBeenCalled();
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
      expect(mailSend.mock.calls[0][1]).toBe('status'); // session 134 telemetry channel
      expect(call.text).toContain(expectedText);
      expect(pushSend).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          title: expect.stringContaining('FO-TEST'),
          body: expect.stringContaining(expectedText),
          url: '/orders/order-1',
          tag: 'order-order-1',
        }),
      );
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
      expect(pushSend).not.toHaveBeenCalled();
    });

    it('sends a bilingual status-update email to guests with contactEmail, no push', async () => {
      ordersFindOne.mockResolvedValue(
        makeOrder({
          userId: undefined as unknown as string,
          contactEmail: 'guest@example.com',
        }),
      );

      bus.next({
        type: 'order.updated',
        restaurantId: 'resto-1',
        userId: null,
        payload: { orderId: 'order-1', code: 'FO-TEST', status: 'confirmed' },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(mailSend).toHaveBeenCalledTimes(1);
      const call = mailSend.mock.calls[0][0] as Record<string, unknown>;
      expect(call.to).toBe('guest@example.com');
      expect(call.subject).toBe(
        'Your order has been confirmed / Pesanan Anda telah dikonfirmasi — #FO-TEST',
      );
      expect(String(call.text)).toContain('Pesanan Anda telah dikonfirmasi.');
      expect(pushSend).not.toHaveBeenCalled();
    });

    it('still skips guest orders without a contactEmail on updated events', async () => {
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
      expect(pushSend).not.toHaveBeenCalled();
    });
  });

  describe('per-user channel settings (Phase 14)', () => {
    // Same event driver as the created-path tests, extracted for the matrix.
    const emitCreated = async () => {
      bus.next({
        type: 'order.created',
        restaurantId: 'resto-1',
        userId: 'user-1',
        payload: { orderId: 'order-1', code: 'FO-TEST', status: 'pending' },
      });
      await new Promise((r) => setTimeout(r, 10));
    };

    it('orderEmailEnabled=false suppresses ONLY the email — push still rides', async () => {
      ordersFindOne.mockResolvedValue(makeOrder());
      usersFindOne.mockResolvedValue(makeUser({ orderEmailEnabled: false }));

      await emitCreated();

      expect(mailSend).not.toHaveBeenCalled();
      expect(pushSend).toHaveBeenCalledTimes(1);
    });

    it('orderPushEnabled=false suppresses ONLY the push — email still rides', async () => {
      ordersFindOne.mockResolvedValue(makeOrder());
      usersFindOne.mockResolvedValue(makeUser({ orderPushEnabled: false }));

      await emitCreated();

      expect(mailSend).toHaveBeenCalledTimes(1);
      expect(pushSend).not.toHaveBeenCalled();
    });

    it('both channels off -> zero sends, but the single settings read still happens', async () => {
      ordersFindOne.mockResolvedValue(makeOrder());
      usersFindOne.mockResolvedValue(makeUser({ orderEmailEnabled: false, orderPushEnabled: false }));

      await emitCreated();

      expect(mailSend).not.toHaveBeenCalled();
      expect(pushSend).not.toHaveBeenCalled();
      expect(usersFindOne).toHaveBeenCalledTimes(1);
      // The read carries the toggle columns — without them the gate cannot work.
      expect(usersFindOne.mock.calls[0][0].select).toEqual(
        expect.arrayContaining(['orderEmailEnabled', 'orderPushEnabled']),
      );
    });

    it('legacy rows with UNWRITTEN toggles (undefined) keep both channels ON', async () => {
      // Strict-false doctrine: fixtures/imports predating the columns must
      // behave exactly like the pre-feature all-on ladder.
      ordersFindOne.mockResolvedValue(makeOrder());
      usersFindOne.mockResolvedValue(makeUser()); // no orderEmailEnabled/orderPushEnabled keys

      await emitCreated();

      expect(mailSend).toHaveBeenCalledTimes(1);
      expect(pushSend).toHaveBeenCalledTimes(1);
    });

    it('status-update events honor the same gates (email off -> no status mail)', async () => {
      ordersFindOne.mockResolvedValue(makeOrder({ status: OrderStatus.CONFIRMED }));
      usersFindOne.mockResolvedValue(makeUser({ orderEmailEnabled: false, orderPushEnabled: false }));

      bus.next({
        type: 'order.updated',
        restaurantId: 'resto-1',
        userId: 'user-1',
        payload: { orderId: 'order-1', code: 'FO-TEST', status: 'confirmed' },
      });
      await new Promise((r) => setTimeout(r, 10));

      expect(mailSend).not.toHaveBeenCalled();
      expect(pushSend).not.toHaveBeenCalled();
    });

    it('guest orders never consult the user table — proof address email is unaffected', async () => {
      ordersFindOne.mockResolvedValue(
        makeOrder({ userId: undefined as unknown as string, contactEmail: 'guest@example.com' }),
      );

      bus.next({
        type: 'order.updated',
        restaurantId: 'resto-1',
        userId: null,
        payload: { orderId: 'order-1', code: 'FO-TEST', status: 'confirmed' },
      });
      await new Promise((r) => setTimeout(r, 10));

      expect(mailSend).toHaveBeenCalledTimes(1);
      expect((mailSend.mock.calls[0][0] as any).to).toBe('guest@example.com');
      expect(usersFindOne).not.toHaveBeenCalled();
      expect(pushSend).not.toHaveBeenCalled();
    });
  });
});

// ── magic-link receipt URL (Phase 14 #5) ───────────────────────────────────
describe('magic-link receipt URL in order emails', () => {
  const SECRET = 'notif-magic-link-unit-secret';
  let svc: OrderNotificationsService;
  let bus: Subject<OrderEvent>;
  let mailSend: jest.Mock;
  let pushSend: jest.Mock;
  let ordersFindOne: jest.Mock;

  function build(config: Record<string, string> | undefined) {
    bus = new Subject<OrderEvent>();
    mailSend = jest.fn().mockResolvedValue(undefined);
    pushSend = jest.fn().mockResolvedValue(undefined);
    ordersFindOne = jest.fn();
    svc = new OrderNotificationsService(
      { stream: () => bus.asObservable() } as any,
      { send: mailSend, enabled: true } as any,
      { sendToUser: pushSend } as any,
      { findOne: ordersFindOne } as any,
      { findOne: async () => makeUser() } as any,
      config === undefined ? undefined : ({ get: (k: string) => config[k] } as any),
    );
    svc.onModuleInit();
  }

  const rtOf = (text: string) => {
    const m = text.match(/[?&]rt=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  };

  afterEach(() => jest.clearAllMocks());

  it('confirmation email carries a verifiable View-your-order link', async () => {
    build({ JWT_SECRET: SECRET, WEB_PUBLIC_URL: 'https://eat.test' });
    ordersFindOne.mockResolvedValue(makeOrder());
    bus.next({ type: 'order.created', restaurantId: 'resto-1', userId: 'user-1',
      payload: { orderId: 'order-1', code: 'FO-TEST', status: 'pending' } });
    await new Promise((r) => setTimeout(r, 10));

    const text = (mailSend.mock.calls[0][0] as any).text as string;
    expect(text).toContain('View your order: https://eat.test/orders/order-1?rt=');
    const tok = rtOf(text)!;
    expect(tok).toBeTruthy();
    expect(verifyReceiptAccessToken(tok, 'order-1', SECRET)).toBe(true);
    // bound capability: the same token must NOT open another order
    expect(verifyReceiptAccessToken(tok, 'order-2', SECRET)).toBe(false);
  });

  it('status-update email carries a fresh verifiable link too', async () => {
    build({ JWT_SECRET: SECRET, WEB_PUBLIC_URL: 'https://eat.test/' }); // trailing slash trimmed
    ordersFindOne.mockResolvedValue(makeOrder({ status: OrderStatus.CONFIRMED }));
    bus.next({ type: 'order.updated', restaurantId: 'resto-1', userId: 'user-1',
      payload: { orderId: 'order-1', code: 'FO-TEST', status: 'confirmed' } });
    await new Promise((r) => setTimeout(r, 10));

    const text = (mailSend.mock.calls[0][0] as any).text as string;
    expect(text).toContain('View your order: https://eat.test/orders/order-1?rt=');
    expect(verifyReceiptAccessToken(rtOf(text)!, 'order-1', SECRET)).toBe(true);
  });

  it('guest bilingual email gets the localized ID line next to the EN one', async () => {
    build({ JWT_SECRET: SECRET });
    ordersFindOne.mockResolvedValue(
      makeOrder({ userId: undefined as unknown as string, contactEmail: 'guest@example.com' }),
    );
    bus.next({ type: 'order.created', restaurantId: 'resto-1', userId: null,
      payload: { orderId: 'order-1', code: 'FO-TEST', status: 'pending' } });
    await new Promise((r) => setTimeout(r, 10));

    const text = (mailSend.mock.calls[0][0] as any).text as string;
    expect(text).toContain('View your order: http://localhost:3000/orders/order-1?rt=');
    expect(text).toContain('Lihat pesanan Anda: http://localhost:3000/orders/order-1?rt=');
  });

  it('no JWT_SECRET visible -> no link line, email still ships (fail-open copy)', async () => {
    build({}); // config exists but knows no secret
    ordersFindOne.mockResolvedValue(makeOrder());
    bus.next({ type: 'order.created', restaurantId: 'resto-1', userId: 'user-1',
      payload: { orderId: 'order-1', code: 'FO-TEST', status: 'pending' } });
    await new Promise((r) => setTimeout(r, 10));

    expect(mailSend).toHaveBeenCalledTimes(1);
    const text = (mailSend.mock.calls[0][0] as any).text as string;
    expect(text).not.toContain('View your order');
    expect(text).not.toContain('rt=');
  });

  it('push url stays the bare order path (bearer rung unlocks it — no capability leak)', async () => {
    build({ JWT_SECRET: SECRET, WEB_PUBLIC_URL: 'https://eat.test' });
    ordersFindOne.mockResolvedValue(makeOrder());
    bus.next({ type: 'order.created', restaurantId: 'resto-1', userId: 'user-1',
      payload: { orderId: 'order-1', code: 'FO-TEST', status: 'pending' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(pushSend).toHaveBeenCalledWith('user-1', expect.objectContaining({ url: '/orders/order-1' }));
  });
});
