import { HttpException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PaymentsService, PaymentActor } from './payments.service';
import { Payment, PaymentStatus } from './payment.entity';
import { Order, OrderStatus } from '../orders/order.entity';
import { PaymentGateway } from './payment-gateway.interface';
import { AppException } from '../common/app-exception';
import { UserRole } from '../users/user.entity';

/**
 * Unit coverage of the provider-agnostic payment machine: access rules,
 * idempotency (replay / already-paid / new-after-failed), amount snapshot,
 * gateway error accounting, and the capture state table. The gateway is a
 * fake here — proving the SERVICE only ever talks to the interface.
 */

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const PAY_ID = '33333333-3333-4333-8333-333333333333';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREIGN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const owner: PaymentActor = { sub: OWNER, role: UserRole.CUSTOMER };
const admin: PaymentActor = { sub: OTHER, role: UserRole.ADMIN };
const stranger: PaymentActor = { sub: FOREIGN, role: UserRole.CUSTOMER };

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    code: 'FO-TEST',
    userId: OWNER,
    status: OrderStatus.PENDING,
    totalCents: 4200,
    ...overrides,
  } as Order;
}

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: PAY_ID,
    orderId: ORDER_ID,
    userId: OWNER,
    provider: 'mock',
    status: PaymentStatus.PENDING,
    amountCents: 4200,
    currency: 'IDR',
    providerRef: `mock_pi_${PAY_ID}`,
    failureReason: null,
    succeededAt: null,
    ...overrides,
  } as Payment;
}

function build(opts: {
  orderRow?: Order | null;
  payments?: Payment[];
  gateway?: Partial<PaymentGateway>;
} = {}) {
  const rows = opts.payments ?? [];
  const orderRow = 'orderRow' in opts ? opts.orderRow : order();
  const savedWrites: any[] = [];
  let insertSeq = 0;

  const paymentsRepo = {
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (x: any) => {
      // Emulate the DB minting the uuid PK on FIRST insert only.
      const row = x.id ? x : { ...x, id: `new-${++insertSeq}` };
      savedWrites.push(row);
      return row;
    }),
    find: jest.fn(async () => rows),
    findOne: jest.fn(async (o: any) =>
      o?.where?.id ? rows.find((r) => r.id === o.where.id) ?? null : null,
    ),
  } as unknown as Repository<Payment>;

  const ordersRepo = {
    findOne: jest.fn(async () => orderRow),
  } as unknown as Repository<Order>;

  const gateway = {
    id: 'mock',
    createIntent: jest.fn(async () => ({ providerRef: 'mock_pi_new', clientSecret: 'mock_secret_new' })),
    capture: jest.fn(async () => ({ succeeded: true })),
    ...opts.gateway,
  } as unknown as PaymentGateway & { createIntent: jest.Mock; capture: jest.Mock };

  const service = new PaymentsService(paymentsRepo, ordersRepo, gateway);
  return { service, paymentsRepo, ordersRepo, gateway, savedWrites };
}

/** Run a rejected promise and assert it is our envelope with a stable code. */
async function expectAppError(promise: Promise<unknown>, status: number, code?: string) {
  let err: any;
  await promise.catch((e) => (err = e));
  expect(err).toBeDefined();
  expect(err.getStatus?.()).toBe(status);
  if (code) expect((err.getResponse() as any).code).toBe(code);
  expect(err).toBeInstanceOf(HttpException);
}

describe('PaymentsService.pay', () => {
  it('happy path: amount snapshot from the ORDER total, intent attached, persisted-before-intent', async () => {
    const { service, gateway, savedWrites } = build();
    const res = await service.pay(ORDER_ID, owner);
    expect(res.clientSecret).toBe('mock_secret_new');
    expect(res.payment.providerRef).toBe('mock_pi_new');
    expect(res.payment.status).toBe(PaymentStatus.PENDING);
    // The MONEY invariant: copied from the order, never from a client.
    expect(res.payment.amountCents).toBe(4200);
    expect(gateway.createIntent).toHaveBeenCalledWith({
      paymentId: res.payment.id,
      orderId: ORDER_ID,
      orderCode: 'FO-TEST',
      amountCents: 4200,
      currency: 'IDR',
      customerRef: OWNER,
    });
    // draft saved BEFORE the intent (audit survives gateway explosions),
    // ref attached with the second save.
    expect(savedWrites).toHaveLength(2);
    expect(savedWrites[0].amountCents).toBe(4200);
    expect(savedWrites[1].providerRef).toBe('mock_pi_new');
  });

  it('unknown order → 404, gateway never called', async () => {
    const { service, gateway } = build({ orderRow: null });
    await expectAppError(service.pay(ORDER_ID, owner), 404);
    expect(gateway.createIntent).not.toHaveBeenCalled();
  });

  it('foreign order for a customer → 404 (no existence leak), but ADMIN bypasses', async () => {
    const b = build({ orderRow: order({ userId: OTHER }) });
    await expectAppError(b.service.pay(ORDER_ID, stranger), 404);
    expect(b.gateway.createIntent).not.toHaveBeenCalled();
    await expect(b.service.pay(ORDER_ID, admin)).resolves.toMatchObject({ clientSecret: 'mock_secret_new' });
  });

  it('guest order (no owner) is payable by any authenticated payer, who gets recorded', async () => {
    const { service } = build({ orderRow: order({ userId: null }) });
    const res = await service.pay(ORDER_ID, stranger);
    expect(res.payment.userId).toBe(FOREIGN); // the PAYER, not the (missing) order owner
  });

  it('pending and confirmed are payable; preparing/delivering/completed/cancelled 409', async () => {
    for (const status of [OrderStatus.PENDING, OrderStatus.CONFIRMED]) {
      const b = build({ orderRow: order({ status }) });
      await expect(b.service.pay(ORDER_ID, owner)).resolves.toBeTruthy();
    }
    for (const status of [OrderStatus.PREPARING, OrderStatus.DELIVERING, OrderStatus.COMPLETED, OrderStatus.CANCELLED]) {
      const b = build({ orderRow: order({ status }) });
      await expectAppError(b.service.pay(ORDER_ID, owner), 409, 'ORDER_NOT_PAYABLE');
    }
  });

  it('idempotent replay: a live PENDING row is returned untouched — no second intent ever', async () => {
    const pending = payment();
    const { service, gateway } = build({ payments: [pending] });
    const res = await service.pay(ORDER_ID, owner);
    expect(res.payment).toBe(pending);
    expect(res.clientSecret).toBeNull();
    expect(gateway.createIntent).not.toHaveBeenCalled();
  });

  it('a SUCCEEDED row means paid — 409 ORDER_ALREADY_PAID checked BEFORE pending replay', async () => {
    const rows = [
      payment({ id: 'a', status: PaymentStatus.SUCCEEDED }),
      payment({ id: 'b', status: PaymentStatus.PENDING }),
    ];
    const { service, gateway } = build({ payments: rows });
    await expectAppError(service.pay(ORDER_ID, owner), 409, 'ORDER_ALREADY_PAID');
    expect(gateway.createIntent).not.toHaveBeenCalled();
  });

  it('FAILED rows do not block — retry creates a NEW attempt (history never rewritten)', async () => {
    const failed = payment({ id: 'f', status: PaymentStatus.FAILED, failureReason: 'mock_declined' });
    const { service } = build({ payments: [failed] });
    const res = await service.pay(ORDER_ID, owner);
    expect(res.payment.id).not.toBe('f');
    expect(res.payment.status).toBe(PaymentStatus.PENDING);
    expect(failed.status).toBe(PaymentStatus.FAILED); // untouched
  });

  it('gateway createIntent explosion: row persisted FAILED with reason, caller gets 502', async () => {
    const { service, savedWrites } = build({
      gateway: { createIntent: jest.fn(async () => { throw new Error('socket hang up'); }) } as any,
    });
    await expectAppError(service.pay(ORDER_ID, owner), 502, 'PAYMENT_GATEWAY_ERROR');
    const last = savedWrites[savedWrites.length - 1];
    expect(last.status).toBe(PaymentStatus.FAILED);
    expect(last.failureReason).toMatch(/gateway_create_intent_failed: socket hang up/);
  });

  it('a malformed order id 404s BEFORE touching the DB (direct-call guard)', async () => {
    const { service, ordersRepo } = build();
    await expectAppError(service.pay('not-a-uuid', owner), 404);
    expect(ordersRepo.findOne).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.capture', () => {
  it('resolves a pending row to succeeded with a write-once timestamp', async () => {
    const row = payment();
    const { service, gateway } = build({ payments: [row] });
    const res = await service.capture(PAY_ID, owner);
    expect(res.status).toBe(PaymentStatus.SUCCEEDED);
    expect(res.succeededAt).toBeInstanceOf(Date);
    expect(gateway.capture).toHaveBeenCalledWith({
      paymentId: PAY_ID,
      providerRef: `mock_pi_${PAY_ID}`,
      amountCents: 4200,
    });
  });

  it('gateway decline marks the row FAILED with the machine reason', async () => {
    const row = payment();
    const { service } = build({
      payments: [row],
      gateway: { capture: jest.fn(async () => ({ succeeded: false, reason: 'mock_declined' })) } as any,
    });
    const res = await service.capture(PAY_ID, owner);
    expect(res.status).toBe(PaymentStatus.FAILED);
    expect(res.failureReason).toBe('mock_declined');
  });

  it('succeeded replays without calling the gateway', async () => {
    const row = payment({ status: PaymentStatus.SUCCEEDED });
    const { service, gateway } = build({ payments: [row] });
    const res = await service.capture(PAY_ID, owner);
    expect(res).toBe(row);
    expect(gateway.capture).not.toHaveBeenCalled();
  });

  it('a FAILED row 409s PAYMENT_ALREADY_FAILED — retrying means pay() again, not capture()', async () => {
    const row = payment({ status: PaymentStatus.FAILED });
    const { service, gateway } = build({ payments: [row] });
    await expectAppError(service.capture(PAY_ID, owner), 409, 'PAYMENT_ALREADY_FAILED');
    expect(gateway.capture).not.toHaveBeenCalled();
  });

  it('a pending row with NO providerRef 409s PAYMENT_NO_INTENT (defensive: intent never existed)', async () => {
    const row = payment({ providerRef: null });
    const { service, gateway } = build({ payments: [row] });
    await expectAppError(service.capture(PAY_ID, owner), 409, 'PAYMENT_NO_INTENT');
    expect(gateway.capture).not.toHaveBeenCalled();
  });

  it('a CANCELLED order kills capture even with a live pending row (409 ORDER_CANCELLED)', async () => {
    const row = payment();
    const { service, gateway } = build({
      payments: [row],
      orderRow: order({ status: OrderStatus.CANCELLED }),
    });
    await expectAppError(service.capture(PAY_ID, owner), 409, 'ORDER_CANCELLED');
    expect(gateway.capture).not.toHaveBeenCalled();
  });

  it('access: payer or admin only; foreign/malformed/unknown → 404, gateway untouched', async () => {
    const row = payment({ userId: OWNER });
    const b = build({ payments: [row] });
    await expectAppError(b.service.capture(PAY_ID, stranger), 404);
    await expectAppError(b.service.capture('junk-id', owner), 404);
    await expectAppError(b.service.capture('99999999-9999-4999-8999-999999999999', owner), 404);
    expect(b.gateway.capture).not.toHaveBeenCalled();

    const a = build({ payments: [row] });
    await expect(a.service.capture(PAY_ID, admin)).resolves.toBeTruthy();
  });
});

describe('PaymentsService.listForOrder', () => {
  it('returns the rows newest-first for the owner', async () => {
    const rows = [payment({ id: 'r1' }), payment({ id: 'r2' })];
    const { service, paymentsRepo } = build({ payments: rows });
    const res = await service.listForOrder(ORDER_ID, owner);
    expect(res).toBe(rows);
    expect(paymentsRepo.find).toHaveBeenCalledWith({
      where: { orderId: ORDER_ID },
      order: { createdAt: 'DESC' },
    });
  });

  it('guest orders list for any authenticated caller; foreign orders 404 BEFORE any payment query', async () => {
    const rows = [payment()];
    const g = build({ orderRow: order({ userId: null }), payments: rows });
    await expect(g.service.listForOrder(ORDER_ID, stranger)).resolves.toBe(rows);

    const b = build({ orderRow: order({ userId: OTHER }) });
    await expectAppError(b.service.listForOrder(ORDER_ID, stranger), 404);
    expect(b.paymentsRepo.find).not.toHaveBeenCalled();
  });
});
