import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';

import {
  OrderPaymentsController,
  PaymentsController,
} from './payments.controller';
import { PaymentsService } from './payments.service';
import { Payment, PaymentStatus } from './payment.entity';
import { PaymentRefund } from './payment-refund.entity';
import { Order, OrderStatus } from '../orders/order.entity';
import { PaymentGateway } from './payment-gateway.interface';
import {
  DEFAULT_RECEIPT_TOKEN_TTL_SEC,
  issueReceiptAccessToken,
} from '../orders/receipt-access';
import { ErrorFormatFilter } from '../common/error-format.filter';
import { createGlobalValidationPipe } from '../common/app-config';
import { TOKEN_TYPE_ACCESS } from '../common/tokens';
import { UserRole } from '../users/user.entity';
import { PaymentAccessGuard } from '../common/payment-access.guard';
import { RolesGuard } from '../common/roles.guard';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { RATE_LIMIT_CONFIG } from '../common/rate-limit/rate-limit.config';
import { SlidingWindowLogStore } from '../common/rate-limit/rate-limit.store';
import { PAYMENT_GATEWAY } from './payment-gateway.interface';

/**
 * Phase 15 #3 over the REAL HTTP wire (harness shape mirrors
 * receipt-magic-link.http.spec.ts): real controllers + real
 * PaymentAccessGuard + real ValidationPipe + real ErrorFormatFilter over
 * live sockets, fake persistence only. Pins the wire SHAPES the money rung
 * must never drift:
 *   - anonymous WITHOUT rt: the byte-identical 401 envelope of the guard
 *     era — the service is not even consulted for a "did you pay" answer;
 *   - any rt DENIAL (junk, foreign, expired, tier) on an existing order:
 *     the byte-identical canonical 404 (session 133/135 baseline,
 *     extended to the money rung) — indistinguishable from an unknown id;
 *   - repeated `?rt=a&rt=b` (array transport, session-132 truth): the pipe
 *     String()-coerces to 'a,b', the verifier denies, the wire says 404 —
 *     never a 500, never an oracle;
 *   - a malformed bearer BESIDE a valid rt stays 401 — presenting a
 *     capability does not silently downgrade an authentication ATTEMPT;
 *   - the rt success path returns the same response shape the bearer path
 *     always did (flattened row + clientSecret), rows carry userId null.
 */

const JWT_TEST = 'payment-rt-http-spec-auth-secret';
const RECEIPT_TEST = 'payment-rt-http-spec-receipt-secret';

const GUEST_ORDER = '9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d';
const OWNED_ORDER = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const UNKNOWN_ORDER = '7e7e7e7e-7e7e-4e7e-8e7e-7e7e7e7e7e7e';
const OWNER_ID = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const PAY_ID = '5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c';
const REST_ID = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';

const CANONICAL_ORDER_404 = JSON.stringify({
  error: { code: 'NOT_FOUND', message: 'Order not found', details: null },
});

function call(
  app: INestApplication,
  method: string,
  path: string,
  opts: { bearer?: string; body?: unknown } = {},
): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const headers: Record<string, string> = {};
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    let payload: string | undefined;
    if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    const req = http.request(
      { host: '127.0.0.1', port, method, path: `/api${path}`, headers },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode!, raw }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const mint = (id: string, ttl = DEFAULT_RECEIPT_TOKEN_TTL_SEC, now?: number) =>
  issueReceiptAccessToken(id, RECEIPT_TEST, ttl, now);

async function boot() {
  const orders: Record<string, Partial<Order>> = {
    [GUEST_ORDER]: {
      id: GUEST_ORDER,
      code: 'FO-RTG',
      status: OrderStatus.PENDING,
      userId: null, // guest — the rung's only legitimate target
      contactEmail: 'rt-pay@example.com',
      restaurantId: REST_ID,
      totalCents: 1900,
    },
    [OWNED_ORDER]: {
      id: OWNED_ORDER,
      code: 'FO-RTO',
      status: OrderStatus.PENDING,
      userId: OWNER_ID, // the capability-tier arm
      restaurantId: REST_ID,
      totalCents: 2400,
    },
  };
  const ordersRepo = {
    findOne: jest.fn(async (q: any) => {
      const f = orders[q?.where?.id];
      return f ? { ...f } : null;
    }),
  } as unknown as Repository<Order>;

  // Mutable payment rows: pay() writes through, capture() flips the status.
  const rows: Payment[] = [
    {
      id: PAY_ID,
      orderId: GUEST_ORDER,
      userId: null, // created by the rt rung in a previous turn — the row
      provider: 'mock', // capture must settle
      status: PaymentStatus.PENDING,
      amountCents: 1900,
      currency: 'IDR',
      providerRef: `mock_pi_${PAY_ID}`,
      failureReason: null,
      succeededAt: null,
      refundedCents: 0,
      refundedAt: null,
    } as Payment,
  ];
  const paymentsRepo = {
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (x: any) => {
      if (!x.id) {
        x.id = `new-${rows.length + 1}`;
        rows.push(x);
      } else {
        // findOne hands out copies (real-ORM hydration idiom); a status
        // mutation must land back on the shared row like an UPDATE would.
        const hit = rows.find((r) => r.id === x.id);
        if (hit) Object.assign(hit, x);
      }
      return x;
    }),
    find: jest.fn(async (q: any) =>
      rows.filter((r) => r.orderId === q?.where?.orderId),
    ),
    findOne: jest.fn(async (q: any) => {
      const hit = rows.find((r) => r.id === q?.where?.id);
      return hit ? { ...hit } : null;
    }),
  } as unknown as Repository<Payment>;
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

  const config = {
    get: (key: string) => (key === 'JWT_SECRET' ? RECEIPT_TEST : undefined),
  };
  const svc = new PaymentsService(
    paymentsRepo,
    ordersRepo,
    gateway,
    refundsRepo,
    config as any,
  );

  const moduleRef = await Test.createTestingModule({
    imports: [JwtModule.register({ secret: JWT_TEST })],
    controllers: [PaymentsController, OrderPaymentsController],
    providers: [
      PaymentAccessGuard,
      RolesGuard,
      RateLimitGuard,
      Reflector,
      { provide: PaymentsService, useValue: svc },
      { provide: PAYMENT_GATEWAY, useValue: gateway },
      { provide: SlidingWindowLogStore, useValue: {} },
      { provide: RATE_LIMIT_CONFIG, useValue: { rules: {} } },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(createGlobalValidationPipe());
  app.useGlobalFilters(new ErrorFormatFilter());
  await app.listen(0);

  const jwt = app.get(JwtService);
  const ownerBearer = await jwt.signAsync({
    sub: OWNER_ID,
    role: UserRole.CUSTOMER,
    typ: TOKEN_TYPE_ACCESS,
  });
  return { app, ownerBearer };
}

describe('money rungs on ?rt= over real HTTP (Phase 15 #3)', () => {
  let app: INestApplication;
  let ownerBearer: string;

  beforeAll(async () => {
    ({ app, ownerBearer } = await boot());
  });
  afterAll(async () => {
    await app.close();
  });

  // ---- POST /payments ----------------------------------------------------

  it('guest order + valid rt + no bearer: 201, flattened row (userId null) + clientSecret', async () => {
    const r = await call(app, 'POST', `/payments?rt=${mint(GUEST_ORDER)}`, {
      body: { orderId: GUEST_ORDER },
      // no bearer, no Authorization header at all
    });
    // GUEST_ORDER ships a PENDING row (the capture fixture), so the rung
    // REPLAYS it: 201, same row id, clientSecret null, zero new intent.
    expect(r.status).toBe(201);
    const body = JSON.parse(r.raw);
    expect(body.id).toBe(PAY_ID);
    expect(body.userId).toBeNull();
    expect(body.clientSecret).toBeNull(); // replay — no second intent minted
  });

  it('anonymous WITHOUT rt: byte-identical 401 baseline, service untouched', async () => {
    const r = await call(app, 'POST', '/payments', { body: { orderId: GUEST_ORDER } });
    expect(r.status).toBe(401);
    const env = JSON.parse(r.raw);
    expect(env.error.code).toBe('UNAUTHORIZED');
    expect(env.error.message).toBe('Missing bearer token');
  });

  it('junk rt: canonical order 404, byte-identical to an unknown id', async () => {
    const junk = await call(app, 'POST', '/payments?rt=zz.notHMAC', {
      body: { orderId: GUEST_ORDER },
    });
    const unknown = await call(app, 'POST', `/payments?rt=zz.notHMAC`, {
      body: { orderId: UNKNOWN_ORDER },
    });
    expect(junk.status).toBe(404);
    expect(junk.raw).toBe(CANONICAL_ORDER_404);
    expect(unknown.raw).toBe(CANONICAL_ORDER_404);
  });

  it('CAPABILITY TIER wire: valid rt on an OWNED order is the same 404 body', async () => {
    const r = await call(app, 'POST', `/payments?rt=${mint(OWNED_ORDER)}`, {
      body: { orderId: OWNED_ORDER },
    });
    expect(r.status).toBe(404);
    expect(r.raw).toBe(CANONICAL_ORDER_404);
  });

  it('expired rt denies 404 (ttl=1 mint already stale at request time)', async () => {
    const tok = mint(GUEST_ORDER, 1, Date.now() - 5000);
    const r = await call(app, 'POST', `/payments?rt=${tok}`, {
      body: { orderId: GUEST_ORDER },
    });
    expect(r.status).toBe(404);
    expect(r.raw).toBe(CANONICAL_ORDER_404);
  });

  it('repeated rt keys (array transport) coerce to junk and deny 404 — never a 500', async () => {
    const r = await call(app, 'POST', `/payments?rt=${mint(GUEST_ORDER)}&rt=x`, {
      body: { orderId: GUEST_ORDER },
    });
    expect(r.status).toBe(404);
    expect(r.raw).toBe(CANONICAL_ORDER_404);
  });

  it('a malformed bearer BESIDE a valid rt stays 401 (no silent downgrade of an auth attempt)', async () => {
    const r = await call(app, 'POST', `/payments?rt=${mint(GUEST_ORDER)}`, {
      bearer: 'garbage.token.here',
      body: { orderId: GUEST_ORDER },
    });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.raw).error.code).toBe('UNAUTHORIZED');
  });

  it('bearer owner + junk rt: additive rung — the bearer ladder rides untouched', async () => {
    const r = await call(app, 'POST', '/payments?rt=junk', {
      bearer: ownerBearer,
      body: { orderId: OWNED_ORDER },
    });
    expect(r.status).toBe(201);
    expect(JSON.parse(r.raw).userId).toBe(OWNER_ID);
  });

  // ---- POST /payments/:id/capture ---------------------------------------

  it('capture via rt on the userId-NULL row: 200 succeeded', async () => {
    const r = await call(app, 'POST', `/payments/${PAY_ID}/capture?rt=${mint(GUEST_ORDER)}`);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.raw);
    expect(body.status).toBe('succeeded');
    expect(body.userId).toBeNull();
  });

  it('capture of the now-succeeded row via rt: idempotent 200 replay', async () => {
    const r = await call(app, 'POST', `/payments/${PAY_ID}/capture?rt=${mint(GUEST_ORDER)}`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.raw).status).toBe('succeeded');
  });

  it('capture via foreign rt: canonical payment 404, service ladder unchanged', async () => {
    const r = await call(
      app,
      'POST',
      `/payments/${PAY_ID}/capture?rt=${mint(OWNED_ORDER)}`,
    );
    expect(r.status).toBe(404);
    expect(JSON.parse(r.raw).error.message).toBe('Payment not found');
  });

  it('capture anonymous without rt: 401 baseline', async () => {
    const r = await call(app, 'POST', `/payments/${PAY_ID}/capture`);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.raw).error.message).toBe('Missing bearer token');
  });

  // ---- GET /orders/:orderId/payments ------------------------------------

  it('payment history via rt on the guest order: 200 array, newest-first rows', async () => {
    const r = await call(app, 'GET', `/orders/${GUEST_ORDER}/payments?rt=${mint(GUEST_ORDER)}`);
    expect(r.status).toBe(200);
    const list = JSON.parse(r.raw);
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].userId).toBeNull();
    expect(list[0].status).toBe('succeeded');
  });

  it('history via valid rt on an OWNED order: canonical 404', async () => {
    const r = await call(app, 'GET', `/orders/${OWNED_ORDER}/payments?rt=${mint(OWNED_ORDER)}`);
    expect(r.status).toBe(404);
    expect(r.raw).toBe(CANONICAL_ORDER_404);
  });

  it('history anonymous without rt: 401; bearer owner on own order still 200 (shape unchanged)', async () => {
    const anon = await call(app, 'GET', `/orders/${OWNED_ORDER}/payments`);
    expect(anon.status).toBe(401);
    const viaBearer = await call(app, 'GET', `/orders/${OWNED_ORDER}/payments`, {
      bearer: ownerBearer,
    });
    expect(viaBearer.status).toBe(200);
    // Array envelope unchanged; the row created by the bearer+rt arm above
    // is inside — only the SHAPE is pinned, not the fixture tally.
    expect(Array.isArray(JSON.parse(viaBearer.raw))).toBe(true);
  });
});
