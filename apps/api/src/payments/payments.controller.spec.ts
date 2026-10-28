import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';

import { OrderPaymentsController, PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { Payment, PaymentStatus } from './payment.entity';
import { AppException } from '../common/app-exception';
import { ErrorFormatFilter } from '../common/error-format.filter';
import { createGlobalValidationPipe } from '../common/app-config';
import { TOKEN_TYPE_ACCESS } from '../common/tokens';
import { UserRole } from '../users/user.entity';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { RolesGuard } from '../common/roles.guard';
import { SlidingWindowLogStore } from '../common/rate-limit/rate-limit.store';
import { RATE_LIMIT_CONFIG, loadRateLimitConfig } from '../common/rate-limit/rate-limit.config';

/**
 * `POST /payments`, `POST /payments/:id/capture` and
 * `GET /orders/:orderId/payments` over real HTTP with the PRODUCTION pipe +
 * error filter, the REAL JwtAuthGuard and the REAL RateLimitGuard (own store
 * per app). The service itself is unit-tested elsewhere; this proves routing,
 * auth-first ordering, DTO whitelist behaviour, uuid param rejection, status
 * pinning (@HttpCode 200 on capture) and that the `payments` bucket exists
 * and 429s with the standard envelope.
 */

const SECRET = 'unit-payment-secret';
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const PAY_ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const row: Payment = {
  id: PAY_ID,
  orderId: ORDER_ID,
  userId: CUSTOMER,
  provider: 'mock',
  status: PaymentStatus.PENDING,
  amountCents: 4200,
  currency: 'IDR',
  providerRef: `mock_pi_${PAY_ID}`,
  failureReason: null,
  succeededAt: null,
  refundedCents: 0,
  refundedAt: null,
  createdAt: new Date('2026-10-27T00:00:00Z'),
  updatedAt: new Date('2026-10-27T00:00:00Z'),
} as Payment;

function request(
  app: INestApplication,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json: any;
        try {
          json = JSON.parse(raw);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode!, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function boot(paymentsMax: string) {
  const svc = {
    pay: jest.fn(async () => ({ payment: row, clientSecret: 'mock_secret_new' })),
    capture: jest.fn(async () => row),
    listForOrder: jest.fn(async () => [row]),
    refund: jest.fn(async (id: string, _actor: unknown, amountCents?: number) => ({
      ...row,
      id,
      status: amountCents === undefined || amountCents === 4200 ? 'refunded' : 'succeeded',
      refundedCents: amountCents ?? 4200,
    })),
  } as unknown as PaymentsService & {
    pay: jest.Mock;
    capture: jest.Mock;
    listForOrder: jest.Mock;
    refund: jest.Mock;
  };
  const moduleRef = await Test.createTestingModule({
    imports: [JwtModule.register({ secret: SECRET })],
    controllers: [PaymentsController, OrderPaymentsController],
    providers: [
      RateLimitGuard,
      SlidingWindowLogStore,
      RolesGuard,
      Reflector,
      { provide: RATE_LIMIT_CONFIG, useValue: loadRateLimitConfig({ RATE_LIMIT_PAYMENTS_MAX: paymentsMax }) },
      { provide: PaymentsService, useValue: svc },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(createGlobalValidationPipe());
  app.useGlobalFilters(new ErrorFormatFilter());
  await app.listen(0);
  const jwt = app.get(JwtService);
  const token = await jwt.signAsync({ sub: CUSTOMER, role: UserRole.CUSTOMER, typ: TOKEN_TYPE_ACCESS });
  const adminToken = await jwt.signAsync({ sub: ADMIN_ID, role: UserRole.ADMIN, typ: TOKEN_TYPE_ACCESS });
  return { app, svc, token, adminToken };
}

describe('payments HTTP surface (real guards + pipes, mocked service)', () => {
  let app: INestApplication;
  let svc: { pay: jest.Mock; capture: jest.Mock; listForOrder: jest.Mock; refund: jest.Mock };
  let token: string;
  let adminToken: string;

  beforeAll(async () => {
    ({ app, svc, token, adminToken } = await boot('100'));
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    svc.pay.mockClear();
    svc.capture.mockClear();
    svc.listForOrder.mockClear();
    svc.refund.mockClear();
  });

  it('POST /payments: 401 envelope without a token, service untouched', async () => {
    const res = await request(app, 'POST', '/api/payments', { body: { orderId: ORDER_ID } });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('UNAUTHORIZED');
    expect(svc.pay).not.toHaveBeenCalled();
  });

  it('POST /payments: {} → 400 validation envelope (orderId required)', async () => {
    const res = await request(app, 'POST', '/api/payments', { body: {}, token });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('BAD_REQUEST');
    expect(Array.isArray(res.json.error.details)).toBe(true);
    expect(svc.pay).not.toHaveBeenCalled();
  });

  it('POST /payments: non-uuid orderId → 400 from the DTO validator', async () => {
    const res = await request(app, 'POST', '/api/payments', { body: { orderId: 'not-a-uuid' }, token });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('BAD_REQUEST');
    expect(svc.pay).not.toHaveBeenCalled();
  });

  it('POST /payments: valid uuid + token → 201 fresh-intent shape; extra body keys stripped', async () => {
    const res = await request(app, 'POST', '/api/payments', {
      body: { orderId: ORDER_ID, amountCents: 1, provider: 'stripe' }, // client tries to steer money + provider
      token,
    });
    expect(res.status).toBe(201);
    // actor came from the VERIFIED token, amount/provider are server-side.
    expect(svc.pay).toHaveBeenCalledWith(ORDER_ID, expect.objectContaining({ sub: CUSTOMER, role: UserRole.CUSTOMER }));
    expect(svc.pay.mock.calls[0][1]).not.toHaveProperty('amountCents');
    expect(res.json).toMatchObject({ id: PAY_ID, orderId: ORDER_ID, status: 'pending', clientSecret: 'mock_secret_new' });
    expect(res.json.amountCents).toBe(4200); // integer cents on the wire
  });

  it('POST /payments/:id/capture: 200 (pinned), passes the uuid + actor', async () => {
    const res = await request(app, 'POST', `/api/payments/${PAY_ID}/capture`, { token });
    expect(res.status).toBe(200);
    expect(svc.capture).toHaveBeenCalledWith(PAY_ID, expect.objectContaining({ sub: CUSTOMER }));
    expect(res.json).toMatchObject({ id: PAY_ID, status: 'pending' });
  });

  it('POST /payments/:id/capture: malformed uuid → 400 BEFORE the service (ParseUUIDPipe)', async () => {
    const res = await request(app, 'POST', '/api/payments/nope/capture', { token });
    expect(res.status).toBe(400);
    expect(res.json.error.message).toMatch(/uuid/i);
    expect(svc.capture).not.toHaveBeenCalled();
  });

  it('service NotFound surfaces as the standard 404 envelope', async () => {
    svc.capture.mockRejectedValueOnce(new NotFoundException('Payment not found'));
    const res = await request(app, 'POST', `/api/payments/${PAY_ID}/capture`, { token });
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('NOT_FOUND');
  });

  it('GET /orders/:orderId/payments: 200 array for a token, 400 malformed uuid, 401 anonymous', async () => {
    const ok = await request(app, 'GET', `/api/orders/${ORDER_ID}/payments`, { token });
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.json)).toBe(true);
    expect(ok.json[0]).toMatchObject({ id: PAY_ID, provider: 'mock' });

    const bad = await request(app, 'GET', '/api/orders/not-a-uuid/payments', { token });
    expect(bad.status).toBe(400);
    expect(svc.listForOrder).toHaveBeenCalledTimes(1); // only the valid one ran

    const anon = await request(app, 'GET', `/api/orders/${ORDER_ID}/payments`);
    expect(anon.status).toBe(401);
  });

  it('the order-payments list does NOT shadow GET /orders/:id (arity-separated route)', async () => {
    // Sanity that both patterns coexist under /api/orders — a plain order GET
    // here hits OrdersController in the real app; in this isolated app the
    // route simply doesn't exist (404 Cannot GET) while OUR route answers.
    const ours = await request(app, 'GET', `/api/orders/${ORDER_ID}/payments`, { token });
    expect(ours.status).toBe(200);
  });

  // ---- POST /payments/:id/refund ------------------------------------------

  it('refund: anonymous → 401, CUSTOMER role → 403 (RolesGuard), service untouched both ways', async () => {
    const anon = await request(app, 'POST', `/api/payments/${PAY_ID}/refund`, {
      body: { amountCents: 100 },
    });
    expect(anon.status).toBe(401);
    expect(svc.refund).not.toHaveBeenCalled();

    const notAdmin = await request(app, 'POST', `/api/payments/${PAY_ID}/refund`, {
      body: { amountCents: 100 },
      token, // the CUSTOMER token this suite is built on
    });
    expect(notAdmin.status).toBe(403);
    expect(notAdmin.json.error.code).toBe('FORBIDDEN');
    expect(svc.refund).not.toHaveBeenCalled();
  });

  it('refund: admin + explicit amount → 200 pinned, uuid + actor + cents passed through', async () => {
    const res = await request(app, 'POST', `/api/payments/${PAY_ID}/refund`, {
      body: { amountCents: 1500 },
      token: adminToken,
    });
    expect(res.status).toBe(200);
    expect(svc.refund).toHaveBeenCalledWith(
      PAY_ID,
      expect.objectContaining({ sub: ADMIN_ID, role: UserRole.ADMIN }),
      1500,
    );
    expect(res.json).toMatchObject({ id: PAY_ID, status: 'succeeded', refundedCents: 1500 });
  });

  it('refund: admin + empty body → full remainder (service receives undefined amount)', async () => {
    const res = await request(app, 'POST', `/api/payments/${PAY_ID}/refund`, {
      body: {},
      token: adminToken,
    });
    expect(res.status).toBe(200);
    expect(svc.refund).toHaveBeenCalledWith(PAY_ID, expect.anything(), undefined);
  });

  it('refund: malformed uuid → 400 BEFORE the service; non-integer/zero amounts → 400 from the DTO', async () => {
    const badId = await request(app, 'POST', '/api/payments/nope/refund', { token: adminToken });
    expect(badId.status).toBe(400);
    expect(badId.json.error.message).toMatch(/uuid/i);
    expect(svc.refund).not.toHaveBeenCalled();

    const zero = await request(app, 'POST', `/api/payments/${PAY_ID}/refund`, {
      body: { amountCents: 0 },
      token: adminToken,
    });
    expect(zero.status).toBe(400);
    const floaty = await request(app, 'POST', `/api/payments/${PAY_ID}/refund`, {
      body: { amountCents: 12.5 },
      token: adminToken,
    });
    expect(floaty.status).toBe(400);
    expect(svc.refund).not.toHaveBeenCalled(); // all three rejected upstream
  });

  it('refund: client cannot steer orderId/provider — extra body keys stripped before the service', async () => {
    const res = await request(app, 'POST', `/api/payments/${PAY_ID}/refund`, {
      body: { amountCents: 100, orderId: ORDER_ID, provider: 'stripe', userId: CUSTOMER },
      token: adminToken,
    });
    expect(res.status).toBe(200);
    expect(svc.refund).toHaveBeenCalledWith(PAY_ID, expect.anything(), 100);
    expect(svc.refund.mock.calls[0][1]).not.toHaveProperty('orderId');
  });

  it('refund: service REFUND_DECLINED (409) surfaces as the standard envelope', async () => {
    svc.refund.mockRejectedValueOnce(
      new AppException(409, 'REFUND_DECLINED', 'The payment provider declined the refund', { reason: 'x' }),
    );
    const res = await request(app, 'POST', `/api/payments/${PAY_ID}/refund`, { token: adminToken });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('REFUND_DECLINED');
  });
});

describe('payments rate-limit bucket', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    ({ app, token } = await boot('2'));
  });
  afterAll(async () => app.close());

  it('third POST /payments in the window → 429 RATE_LIMITED with Retry-After', async () => {
    const body = { orderId: ORDER_ID };
    const r1 = await request(app, 'POST', '/api/payments', { body, token });
    const r2 = await request(app, 'POST', '/api/payments', { body, token });
    expect([r1.status, r2.status]).toEqual([201, 201]);
    const r3 = await request(app, 'POST', '/api/payments', { body, token });
    expect(r3.status).toBe(429);
    expect(r3.json.error.code).toBe('RATE_LIMITED');
    expect(r3.json.error.details.bucket).toBe('payments');
    expect(Number(r3.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(r3.headers['x-ratelimit-limit']).toBe('2');
  });

  it('capture shares the SAME counter as pay (one bucket for money endpoints)', async () => {
    // Bucket is already drained by the previous test (2/2 used within the
    // window) — ANY throttled route in it must now shed, including capture.
    const res = await request(app, 'POST', `/api/payments/${PAY_ID}/capture`, { token });
    expect(res.status).toBe(429);
    expect(res.json.error.details.bucket).toBe('payments');
  });
});
