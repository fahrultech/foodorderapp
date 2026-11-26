import { HttpException, UnauthorizedException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PaymentsService, PaymentActor } from './payments.service';
import { Payment, PaymentStatus } from './payment.entity';
import { PaymentRefund } from './payment-refund.entity';
import { Order, OrderStatus } from '../orders/order.entity';
import { PaymentGateway } from './payment-gateway.interface';
import {
  DEFAULT_RECEIPT_TOKEN_TTL_SEC,
  issueReceiptAccessToken,
} from '../orders/receipt-access';
import { UserRole } from '../users/user.entity';

/**
 * Phase 15 #3 — "one-click pay from the magic link": the `rt` capability
 * rung on the money ladder, pinned at the SERVICE level (the wire shape
 * rides payment-rt-access.http.spec.ts; the crypto itself is owned by
 * receipt-access.spec.ts).
 *
 * Decision being pinned (see ARCHITECTURE.md + docs/DEVLOG.md):
 * - rt pays GUEST orders only (order.userId IS NULL). The token is
 *   strictly narrower than the existing "any signed-in user may pay a
 *   guest order" rung, so it ADDS nothing the account-less flow lacks.
 * - Owned orders: rt never transacts — the SAME 404 as a stranger
 *   (capability tier: mailbox access must not become money access on an
 *   account).
 * - capture via rt settles only rows with userId IS NULL (what the rt
 *   rung itself created) — a signed-in payer's row is capture-locked.
 * - Every ladder denial answers the byte-identical canonical error
 *   (session 135 baseline preserved on the money rung); anonymous with
 *   NO rt stays the untouched 401 'Missing bearer token'.
 * - Bearer arms are UNCHANGED and rt is ADDITIVE: a valid bearer beside
 *   a junk rt rides the bearer ladder untouched.
 */

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORDER_ID = '22222222-2222-4222-8222-222222222222';
const PAY_ID = '33333333-3333-4333-8333-333333333333';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAYER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const SECRET = 'unit-payment-rt-secret';

const owner: PaymentActor = { sub: OWNER, role: UserRole.CUSTOMER };
const payer: PaymentActor = { sub: PAYER, role: UserRole.CUSTOMER };

const order = (o: Partial<Order> = {}): Order =>
  ({
    id: ORDER_ID,
    code: 'FO-RT',
    userId: null, // guest order by default — the rung under test
    restaurantId: '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d',
    status: OrderStatus.PENDING,
    totalCents: 2500,
    ...o,
  }) as Order;

const payment = (p: Partial<Payment> = {}): Payment =>
  ({
    id: PAY_ID,
    orderId: ORDER_ID,
    userId: null, // magic-link-created row by default
    provider: 'mock',
    status: PaymentStatus.PENDING,
    amountCents: 2500,
    currency: 'IDR',
    providerRef: `mock_pi_${PAY_ID}`,
    failureReason: null,
    succeededAt: null,
    refundedCents: 0,
    refundedAt: null,
    ...p,
  }) as Payment;

function build(opts: {
  orderRow?: Order | null;
  payments?: Payment[];
  secret?: string | undefined;
} = {}) {
  const rows = opts.payments ?? [];
  const orderRow = 'orderRow' in opts ? opts.orderRow : order();
  const savedWrites: any[] = [];
  let insertSeq = 0;

  const paymentsRepo = {
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (x: any) => {
      const row = x.id ? x : { ...x, id: `new-${++insertSeq}` };
      savedWrites.push(row);
      return row;
    }),
    find: jest.fn(async () => rows),
    findOne: jest.fn(async (q: any) => {
      const hit = q?.where?.id ? rows.find((r) => r.id === q.where.id) : undefined;
      return hit ? { ...hit } : null;
    }),
  } as unknown as Repository<Payment>;

  const ordersRepo = {
    findOne: jest.fn(async () => orderRow),
  } as unknown as Repository<Order>;

  const refundsRepo = {
    find: jest.fn(async () => []),
  } as unknown as Repository<PaymentRefund>;

  const gateway = {
    id: 'mock',
    createIntent: jest.fn(async () => ({
      providerRef: 'mock_pi_new',
      clientSecret: 'mock_secret_new',
    })),
    capture: jest.fn(async () => ({ succeeded: true })),
  } as unknown as PaymentGateway & {
    createIntent: jest.Mock;
    capture: jest.Mock;
  };

  // secret === undefined -> NO config slot at all (inert rung, like every
  // pre-133 unit harness); secret === '' -> config present but unusable.
  const config =
    opts.secret === undefined
      ? undefined
      : { get: (key: string) => (key === 'JWT' + '_SECRET' ? opts.secret : undefined) };

  const service = new PaymentsService(
    paymentsRepo,
    ordersRepo,
    gateway,
    refundsRepo,
    config as any,
  );
  return { service, paymentsRepo, ordersRepo, gateway, savedWrites };
}

const mint = (id: string = ORDER_ID, ttl = DEFAULT_RECEIPT_TOKEN_TTL_SEC, now?: number) =>
  issueReceiptAccessToken(id, SECRET, ttl, now);

async function grab(promise: Promise<unknown>): Promise<HttpException> {
  let err: any;
  await promise.catch((e) => (err = e));
  expect(err).toBeInstanceOf(HttpException);
  return err;
}

const statusOf = (e: HttpException) => e.getStatus();
const bodyOf = (e: HttpException) => JSON.stringify(e.getResponse());

describe('pay() — the magic-link rung (guest orders only)', () => {
  it('valid rt + guest order + no bearer: intent created, row carries NO payer', async () => {
    const { service, gateway, savedWrites } = build({ secret: SECRET });
    const res = await service.pay(ORDER_ID, null, mint());
    expect(res.clientSecret).toBe('mock_secret_new');
    expect(gateway.createIntent).toHaveBeenCalledTimes(1);
    const draft = savedWrites[0];
    expect(draft.userId).toBeNull();
    // customerRef on the gateway input: no account behind this attempt.
    expect((gateway.createIntent.mock.calls[0][0] as any).customerRef).toBeNull();
    // Amount stays the SERVER snapshot — no client money input exists.
    expect(draft.amountCents).toBe(2500);
  });

  it('anonymous with NO rt keeps the untouched 401 baseline (service-level twin of the guard)', async () => {
    const { service, gateway } = build({ secret: SECRET });
    const err = await grab(service.pay(ORDER_ID, null));
    expect(statusOf(err)).toBe(401);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(bodyOf(err)).toContain('Missing bearer token');
    expect(gateway.createIntent).not.toHaveBeenCalled();
  });

  it('junk rt on a guest order is the SAME body as an unknown order id (canonical 404)', async () => {
    const { service } = build({ secret: SECRET });
    const junk = await grab(service.pay(ORDER_ID, null, 'not-a-token'));
    const gone = await grab(service.pay(OTHER_ORDER_ID, null, 'not-a-token'));
    expect(statusOf(junk)).toBe(404);
    expect(bodyOf(junk)).toBe(bodyOf(gone));
  });

  it('expired rt denies 404 (clock-bound, minted in the past)', async () => {
    const { service } = build({ secret: SECRET });
    const past = Date.now() - 100 * 60 * 60 * 1000;
    const err = await grab(service.pay(ORDER_ID, null, mint(ORDER_ID, 60, past)));
    expect(statusOf(err)).toBe(404);
  });

  it('rt minted for ANOTHER order denies 404 on this one', async () => {
    const { service } = build({ secret: SECRET });
    const err = await grab(service.pay(ORDER_ID, null, mint(OTHER_ORDER_ID)));
    expect(statusOf(err)).toBe(404);
  });

  it('CAPABILITY TIER: valid rt on an OWNED order denies with the canonical 404', async () => {
    const { service, gateway } = build({ secret: SECRET, orderRow: order({ userId: OWNER }) });
    const err = await grab(service.pay(ORDER_ID, null, mint()));
    expect(statusOf(err)).toBe(404);
    expect(gateway.createIntent).not.toHaveBeenCalled();
    // byte-identical to the junk-token denial (no oracle drift between
    // "wrong token" and "right token, wrong tier").
    const { service: s2 } = build({ secret: SECRET });
    const junk = await grab(s2.pay(ORDER_ID, null, 'not-a-token'));
    expect(bodyOf(err)).toBe(bodyOf(junk));
  });

  it('inert config (no readable secret): every token is just junk query data', async () => {
    const { service } = build(); // no config slot at all
    const err = await grab(service.pay(ORDER_ID, null, mint()));
    expect(statusOf(err)).toBe(404);
  });

  it('empty-string rt (presented, empty) is a DENIAL (404), not the no-proof 401', async () => {
    const { service } = build({ secret: SECRET });
    const err = await grab(service.pay(ORDER_ID, null, ''));
    expect(statusOf(err)).toBe(404);
  });

  it('rt is ADDITIVE: a valid bearer beside a junk rt rides the bearer ladder', async () => {
    const { service } = build({ secret: SECRET, orderRow: order({ userId: OWNER }) });
    const res = await service.pay(ORDER_ID, owner, 'junk.rt');
    expect(res.payment.orderId).toBe(ORDER_ID);
  });

  it('bearer rungs unchanged: stranger still 404s on an owned order even WITH a valid rt', async () => {
    // The rt belongs to the order, but the caller authenticated as someone
    // else — bearer ladder decides, exactly as before Phase 15 #3.
    const { service } = build({ secret: SECRET, orderRow: order({ userId: OWNER }) });
    const err = await grab(service.pay(ORDER_ID, payer, mint()));
    expect(statusOf(err)).toBe(404);
  });

  it('replay + terminal states ride the rt rung unchanged', async () => {
    const pending = payment({ status: PaymentStatus.PENDING });
    const { service, gateway } = build({ secret: SECRET, payments: [pending] });
    const replay = await service.pay(ORDER_ID, null, mint());
    expect(replay.payment.id).toBe(PAY_ID);
    expect(replay.clientSecret).toBeNull();
    expect(gateway.createIntent).not.toHaveBeenCalled();

    const paid = build({
      secret: SECRET,
      payments: [payment({ status: PaymentStatus.SUCCEEDED })],
    });
    const err = await grab(paid.service.pay(ORDER_ID, null, mint()));
    expect(statusOf(err)).toBe(409);
  });
});

describe('capture() — the rt settles only what rt paid for', () => {
  it('valid rt + userId-NULL row (the rung created): captures', async () => {
    const { service, gateway } = build({
      secret: SECRET,
      orderRow: order(),
      payments: [payment({ status: PaymentStatus.PENDING })],
    });
    const res = await service.capture(PAY_ID, null, mint());
    expect(res.status).toBe(PaymentStatus.SUCCEEDED);
    expect(gateway.capture).toHaveBeenCalledTimes(1);
  });

  it('CAPABILITY TIER: rt can never capture a row a signed-in payer created', async () => {
    const { service, gateway } = build({
      secret: SECRET,
      payments: [payment({ userId: PAYER })],
    });
    const err = await grab(service.capture(PAY_ID, null, mint()));
    expect(statusOf(err)).toBe(404);
    expect(gateway.capture).not.toHaveBeenCalled();
  });

  it('rt bound to a DIFFERENT order than the payment row denies 404', async () => {
    const { service } = build({ secret: SECRET, payments: [payment()] });
    const err = await grab(service.capture(PAY_ID, null, mint(OTHER_ORDER_ID)));
    expect(statusOf(err)).toBe(404);
  });

  it('junk / empty rt deny 404; nothing presented stays 401', async () => {
    const { service } = build({ secret: SECRET, payments: [payment()] });
    const junk = await grab(service.capture(PAY_ID, null, 'zzz'));
    expect(statusOf(junk)).toBe(404);
    const empty = await grab(service.capture(PAY_ID, null, ''));
    expect(statusOf(empty)).toBe(404);
    const anon = await grab(service.capture(PAY_ID, null));
    expect(statusOf(anon)).toBe(401);
  });

  it('bearer payer ladder unchanged (rt irrelevant beside a bearer)', async () => {
    const { service } = build({
      secret: SECRET,
      payments: [payment({ userId: PAYER })],
    });
    const res = await service.capture(PAY_ID, payer, 'junk');
    expect(res.status).toBe(PaymentStatus.SUCCEEDED);
    const strangerErr = await grab(
      build({ secret: SECRET, payments: [payment({ userId: PAYER })] }).service.capture(
        PAY_ID,
        owner,
      ),
    );
    expect(statusOf(strangerErr)).toBe(404);
  });

  it('cancelled order still refuses rt capture 409 (status gates ride the rung)', async () => {
    const { service } = build({
      secret: SECRET,
      orderRow: order({ status: OrderStatus.CANCELLED }),
      payments: [payment()],
    });
    const err = await grab(service.capture(PAY_ID, null, mint()));
    expect(statusOf(err)).toBe(409);
  });
});

describe('listForOrder() — the read sibling of the pay ladder', () => {
  it('valid rt + guest order lists the attempts with no bearer', async () => {
    const { service } = build({
      secret: SECRET,
      payments: [payment({ status: PaymentStatus.SUCCEEDED })],
    });
    const rows = await service.listForOrder(ORDER_ID, null, mint());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(PaymentStatus.SUCCEEDED);
  });

  it('owned order: valid rt denies 404 (view rung stays VIEW there)', async () => {
    const { service } = build({ secret: SECRET, orderRow: order({ userId: OWNER }) });
    const err = await grab(service.listForOrder(ORDER_ID, null, mint()));
    expect(statusOf(err)).toBe(404);
  });

  it('anonymous without any rt keeps the 401; junk rt denies 404', async () => {
    const { service } = build({ secret: SECRET });
    expect(statusOf(await grab(service.listForOrder(ORDER_ID, null)))).toBe(401);
    expect(statusOf(await grab(service.listForOrder(ORDER_ID, null, 'x')))).toBe(404);
  });

  it('bearer rungs unchanged', async () => {
    const { service } = build({ secret: SECRET, orderRow: order({ userId: OWNER }) });
    expect(Array.isArray(await service.listForOrder(ORDER_ID, owner))).toBe(true);
    const err = await grab(service.listForOrder(ORDER_ID, payer));
    expect(statusOf(err)).toBe(404);
  });
});
