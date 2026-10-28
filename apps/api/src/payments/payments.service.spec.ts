import { HttpException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PaymentsService, PaymentActor } from './payments.service';
import { Payment, PaymentStatus } from './payment.entity';
import { PaymentRefund } from './payment-refund.entity';
import { Order, OrderStatus } from '../orders/order.entity';
import { PaymentGateway, PaymentRefundGateway } from './payment-gateway.interface';
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
    refundedCents: 0,
    refundedAt: null,
    ...overrides,
  } as Payment;
}

function build(opts: {
  orderRow?: Order | null;
  payments?: Payment[];
  gateway?: Partial<PaymentGateway & PaymentRefundGateway>;
} = {}) {
  const rows = opts.payments ?? [];
  const orderRow = 'orderRow' in opts ? opts.orderRow : order();
  const savedWrites: any[] = [];
  let insertSeq = 0;

  // The refund audit ledger as the transaction fake sees it: insert appends,
  // find replays — so a refund() followed by listRefunds() reads its own
  // trail, mirroring the real table.
  const refundRows: PaymentRefund[] = [];
  const refundsRepo = {
    insert: jest.fn(async (x: any) => {
      refundRows.push({ ...x });
      return { identifiers: [{ id: `audit-${refundRows.length}` }] };
    }),
    find: jest.fn(async () => refundRows.map((r) => ({ ...r }))),
  } as unknown as Repository<PaymentRefund>;

  const paymentsRepo = {
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (x: any) => {
      // Emulate the DB minting the uuid PK on FIRST insert only.
      const row = x.id ? x : { ...x, id: `new-${++insertSeq}` };
      savedWrites.push(row);
      return row;
    }),
    find: jest.fn(async () => rows),
    // Hydrates per query, like a real ORM read: a concurrent mutation of the
    // row after this call must NOT be visible through the earlier snapshot
    // (the refund CAS test depends on this being a copy, not a live object).
    findOne: jest.fn(async (o: any) => {
      const hit = o?.where?.id ? rows.find((r) => r.id === o.where.id) : undefined;
      return hit ? { ...hit } : null;
    }),
    // Compare-and-set UPDATE emulation (refund concurrency): matches id +
    // the expected refundedCents, mutates the in-place row when it lands.
    update: jest.fn(async (criteria: any, partial: any) => {
      const hit = rows.find(
        (r) => r.id === criteria.id && r.refundedCents === criteria.refundedCents,
      );
      if (!hit) return { affected: 0 } as any;
      Object.assign(hit, partial);
      savedWrites.push({ updated: hit });
      return { affected: 1 } as any;
    }),
    // The refund path writes CAS + audit through manager.transaction; this
    // fake runs the callback against the same repo fakes (an exception
    // thrown inside propagates, standing in for the real rollback).
    manager: {
      transaction: jest.fn(async (cb: any) =>
        cb({
          getRepository: (entity: any) => (entity === PaymentRefund ? refundsRepo : paymentsRepo),
        }),
      ),
    },
  } as unknown as Repository<Payment>;

  const ordersRepo = {
    findOne: jest.fn(async () => orderRow),
  } as unknown as Repository<Order>;

  const gateway = {
    id: 'mock',
    createIntent: jest.fn(async () => ({ providerRef: 'mock_pi_new', clientSecret: 'mock_secret_new' })),
    capture: jest.fn(async () => ({ succeeded: true })),
    refundIntent: jest.fn(async () => ({ succeeded: true, providerRefundRef: 'mock_re_new' })),
    ...opts.gateway,
  } as unknown as PaymentGateway & {
    createIntent: jest.Mock;
    capture: jest.Mock;
    refundIntent: jest.Mock;
  };

  const service = new PaymentsService(paymentsRepo, ordersRepo, gateway, refundsRepo);
  return { service, paymentsRepo, ordersRepo, gateway, savedWrites, refundsRepo, refundRows };
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
    // The fake (like a real ORM read) hydrates a fresh instance per query —
    // identity is not the contract; "same row, gateway never consulted" is.
    expect(res).toStrictEqual(row);
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

describe('PaymentsService.refund', () => {
  const paid = (overrides: Partial<Payment> = {}) =>
    payment({ status: PaymentStatus.SUCCEEDED, succeededAt: new Date(), ...overrides });

  it('rejects non-admin actors BEFORE touching the repository (route guard is not the only door)', async () => {
    const { service, paymentsRepo } = build({ payments: [paid()] });
    let err: any;
    await service.refund(PAY_ID, owner).catch((e) => (err = e));
    expect(err.getStatus()).toBe(403);
    expect(paymentsRepo.update).not.toHaveBeenCalled();
  });

  it('unknown / malformed payment id → 404, no gateway call', async () => {
    const { service, gateway } = build({ payments: [] });
    await expectAppError(service.refund(PAY_ID, admin), 404);
    await expectAppError(service.refund('not-a-uuid', admin), 404);
    expect(gateway.refundIntent).not.toHaveBeenCalled();
  });

  it.each([
    [PaymentStatus.PENDING, 'PAYMENT_NOT_CAPTURED'],
    [PaymentStatus.FAILED, 'PAYMENT_ALREADY_FAILED'],
    [PaymentStatus.REFUNDED, 'PAYMENT_ALREADY_REFUNDED'],
  ])('status %s cannot be refunded → 409 %s', async (status, code) => {
    const { service, gateway } = build({ payments: [payment({ status })] });
    await expectAppError(service.refund(PAY_ID, admin), 409, code);
    expect(gateway.refundIntent).not.toHaveBeenCalled();
  });

  it('full refund (no amount given): exact captured amount, terminal refunded, refundedAt set', async () => {
    const row = paid();
    const { service, gateway } = build({ payments: [row] });
    const res = await service.refund(PAY_ID, admin);
    expect(gateway.refundIntent).toHaveBeenCalledWith({
      paymentId: PAY_ID,
      providerRef: `mock_pi_${PAY_ID}`,
      amountCents: 4200,
      remainingCents: 4200,
      currency: 'IDR',
    });
    expect(res.status).toBe(PaymentStatus.REFUNDED);
    expect(res.refundedCents).toBe(4200);
    expect(res.refundedAt).toBeInstanceOf(Date);
  });

  it('partial refund: amount lands, status stays succeeded, remainder shrinks', async () => {
    const row = paid();
    const { service } = build({ payments: [row] });
    const first = await service.refund(PAY_ID, admin, 1500);
    expect(first.refundedCents).toBe(1500);
    expect(first.status).toBe(PaymentStatus.SUCCEEDED);
    // Second admin action refunds the remainder — full now.
    const second = await service.refund(PAY_ID, admin, 2700);
    expect(second.refundedCents).toBe(4200);
    expect(second.status).toBe(PaymentStatus.REFUNDED);
  });

  it('after a partial, the omitted amount means "remaining" — not the original total', async () => {
    const row = paid({ refundedCents: 1000 });
    const { service, gateway } = build({ payments: [row] });
    await service.refund(PAY_ID, admin);
    expect(gateway.refundIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 3200, remainingCents: 3200 }),
    );
  });

  it.each([
    [4201, 'exceeds remainder'],
    [0, 'non-positive'],
    [12.5, 'float'],
  ])('INVALID_REFUND_AMOUNT for %p (%s) — rejected BEFORE the gateway', async (amount) => {
    const { service, gateway } = build({ payments: [paid()] });
    await expectAppError(service.refund(PAY_ID, admin, amount), 400, 'INVALID_REFUND_AMOUNT');
    expect(gateway.refundIntent).not.toHaveBeenCalled();
  });

  it('a gateway WITHOUT the refund add-on → 501 REFUND_UNSUPPORTED, row untouched', async () => {
    const { service, paymentsRepo } = build({
      payments: [paid()],
      gateway: { refundIntent: undefined },
    });
    await expectAppError(service.refund(PAY_ID, admin), 501, 'REFUND_UNSUPPORTED');
    expect(paymentsRepo.update).not.toHaveBeenCalled();
  });

  it('a DECLINED provider refund leaves the row exactly as it was (history never rewritten)', async () => {
    const row = paid();
    const { service, paymentsRepo, refundsRepo } = build({
      payments: [row],
      gateway: { refundIntent: async () => ({ succeeded: false, reason: 'insufficient_provider_funds' }) },
    });
    await expectAppError(service.refund(PAY_ID, admin), 409, 'REFUND_DECLINED');
    expect(paymentsRepo.update).not.toHaveBeenCalled();
    expect(refundsRepo.insert).not.toHaveBeenCalled(); // declined attempts leave NO audit trail
    expect(row.refundedCents).toBe(0);
    expect(row.status).toBe(PaymentStatus.SUCCEEDED);
  });

  it('a gateway EXCEPTION on refund → 502, row unchanged (retry is safe)', async () => {
    const row = paid();
    const { service, paymentsRepo, refundsRepo } = build({
      payments: [row],
      gateway: { refundIntent: async () => { throw new Error('network down'); } },
    });
    await expectAppError(service.refund(PAY_ID, admin), 502, 'PAYMENT_GATEWAY_ERROR');
    expect(paymentsRepo.update).not.toHaveBeenCalled();
    expect(refundsRepo.insert).not.toHaveBeenCalled(); // provider never moved money → no audit row
    expect(row.refundedCents).toBe(0);
  });

  it('compare-and-set loser (row refunded concurrently mid-flight) → 409 REFUND_CONFLICT, no double refund', async () => {
    // The fake update matches refundedCents as the CAS key: pre-race the row
    // to 1500 while the service still thinks it read 0.
    const row = paid();
    const { service, gateway, refundsRepo } = build({ payments: [row] });
    gateway.refundIntent.mockImplementation(async () => {
      row.refundedCents = 1500; // someone else landed during our await
      return { succeeded: true };
    });
    await expectAppError(service.refund(PAY_ID, admin, 1000), 409, 'REFUND_CONFLICT');
    expect(row.refundedCents).toBe(1500); // the winner's value stands
    // The loser's audit insert must never run: the throw happens INSIDE the
    // transaction before it — in the real DB the rollback would erase it too.
    expect(refundsRepo.insert).not.toHaveBeenCalled();
  });

  it('capture refuses a fully refunded row (PAYMENT_ALREADY_REFUNDED, no gateway settle)', async () => {
    const { service, gateway } = build({
      payments: [payment({ status: PaymentStatus.REFUNDED, refundedCents: 4200 })],
    });
    await expectAppError(service.capture(PAY_ID, admin), 409, 'PAYMENT_ALREADY_REFUNDED');
    expect(gateway.capture).not.toHaveBeenCalled();
  });

  it('a fully refunded row releases the ORDER_ALREADY_PAID lock — repaying starts a NEW attempt', async () => {
    const { service, gateway } = build({
      payments: [payment({ status: PaymentStatus.REFUNDED, refundedCents: 4200 })],
    });
    const res = await service.pay(ORDER_ID, owner);
    expect(res.payment.id).toBe('new-1');
    expect(res.payment.amountCents).toBe(4200);
    expect(gateway.createIntent).toHaveBeenCalledTimes(1);
  });

  it('a PARTIALLY refunded row is still the paid attempt — pay() keeps saying ORDER_ALREADY_PAID', async () => {
    const { service } = build({
      payments: [payment({ status: PaymentStatus.SUCCEEDED, succeededAt: new Date(), refundedCents: 800 })],
    });
    await expectAppError(service.pay(ORDER_ID, owner), 409, 'ORDER_ALREADY_PAID');
  });

  // ---- audit trail (payment_refunds rows) ---------------------------------

  it('a landed refund writes ONE audit row with full attribution', async () => {
    const row = paid();
    const { service, refundsRepo, refundRows } = build({ payments: [row] });
    await service.refund(PAY_ID, { ...admin, email: 'admin@foodorder.app' }, 1500);
    expect(refundsRepo.insert).toHaveBeenCalledTimes(1);
    expect(refundRows[0]).toMatchObject({
      paymentId: PAY_ID,
      provider: 'mock',
      providerRefundRef: 'mock_re_new', // whatever the adapter reported, snapshotted
      amountCents: 1500,
      refundedAfterCents: 1500,
      actingAdminId: OTHER,
      actingAdminEmail: 'admin@foodorder.app',
    });
  });

  it('successive partials append one row each, with the running balance', async () => {
    const row = paid(); // 4200 captured
    const { service, refundRows } = build({ payments: [row] });
    await service.refund(PAY_ID, admin, 1500);
    await service.refund(PAY_ID, admin, 900);
    await service.refund(PAY_ID, admin); // remainder = 1800 → terminal
    expect(refundRows.map((r) => r.amountCents)).toEqual([1500, 900, 1800]);
    expect(refundRows.map((r) => r.refundedAfterCents)).toEqual([1500, 2400, 4200]);
    // The ledger explains the row exactly: last running balance == row total.
    expect(refundRows[refundRows.length - 1].refundedAfterCents).toBe(row.refundedCents);
  });

  it('a token without an email claim still lands the refund; the snapshot is null, not a crash', async () => {
    const row = paid();
    const { service, refundRows } = build({ payments: [row] });
    await service.refund(PAY_ID, admin, 500); // `admin` actor has no email
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0].actingAdminEmail).toBeNull();
    expect(row.refundedCents).toBe(500); // the refund itself landed
  });

  it('an adapter returning NO provider ref stores null (the column is a snapshot, not a requirement)', async () => {
    const row = paid();
    const { service, refundRows } = build({
      payments: [row],
      gateway: { refundIntent: async () => ({ succeeded: true }) }, // no providerRefundRef
    });
    await service.refund(PAY_ID, admin, 700);
    expect(refundRows[0].providerRefundRef).toBeNull();
  });
});

describe('PaymentsService.listRefunds', () => {
  const paid = (overrides: Partial<Payment> = {}) =>
    payment({ status: PaymentStatus.SUCCEEDED, succeededAt: new Date(), ...overrides });

  it('admin reads the trail oldest-first through the repository contract', async () => {
    const { service, refundsRepo } = build({ payments: [paid()] });
    const res = await service.listRefunds(PAY_ID, admin);
    expect(res).toEqual([]);
    expect(refundsRepo.find).toHaveBeenCalledWith({
      where: { paymentId: PAY_ID },
      order: { createdAt: 'ASC' },
    });
  });

  it('the trail a refund writes is the trail listRefunds reads', async () => {
    const { service } = build({ payments: [paid()] });
    await service.refund(PAY_ID, { ...admin, email: 'admin@foodorder.app' }, 1000);
    await service.refund(PAY_ID, { ...admin, email: 'admin@foodorder.app' });
    const trail = await service.listRefunds(PAY_ID, admin);
    expect(trail).toHaveLength(2);
    expect(trail.map((t) => t.amountCents)).toEqual([1000, 3200]);
    expect(trail.every((t) => t.actingAdminEmail === 'admin@foodorder.app')).toBe(true);
  });

  it('rejects non-admin actors BEFORE touching the repository', async () => {
    const { service, paymentsRepo, refundsRepo } = build({ payments: [paid()] });
    let err: any;
    await service.listRefunds(PAY_ID, owner).catch((e) => (err = e));
    expect(err.getStatus()).toBe(403);
    expect(paymentsRepo.findOne).not.toHaveBeenCalled();
    expect(refundsRepo.find).not.toHaveBeenCalled();
  });

  it('malformed / unknown payment id → 404; the audit table is never queried', async () => {
    const { service, refundsRepo } = build({ payments: [] });
    await expectAppError(service.listRefunds('not-a-uuid', admin), 404);
    await expectAppError(service.listRefunds(PAY_ID, admin), 404);
    expect(refundsRepo.find).not.toHaveBeenCalled();
  });
});
