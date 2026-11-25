import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';

import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderEventsService } from './order-events.service';
import {
  DEFAULT_RECEIPT_TOKEN_TTL_SEC,
  issueReceiptAccessToken,
} from './receipt-access';
import { ErrorFormatFilter } from '../common/error-format.filter';
import { createGlobalValidationPipe } from '../common/app-config';
import { TOKEN_TYPE_ACCESS } from '../common/tokens';
import { UserRole } from '../users/user.entity';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/optional-jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { RATE_LIMIT_CONFIG } from '../common/rate-limit/rate-limit.config';
import { SlidingWindowLogStore } from '../common/rate-limit/rate-limit.store';
import { Order, OrderStatus } from './order.entity';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Magic-link receipt rung (Phase 14 #5) pinned over the REAL HTTP ladder:
 * real OrdersController + real OrdersService.findOneForViewer + real
 * ValidationPipe + ErrorFormatFilter over live sockets (same harness shape
 * as receipt-proof-sweep.http.spec.ts). `?rt=` is rung 4:
 *   - a valid token unlocks a receipt with NO bearer and NO typed email —
 *     including the guest orders the emails actually go to;
 *   - the bearer rungs stay byte-identical (garbage rt beside a valid
 *     owner bearer still rides rung 2);
 *   - every denial (foreign, tampered, expired, structurally junk,
 *     repeated-key array transport, inert config) answers the byte-identical
 *     canonical 404 — no oracle drift, no 5xx (session 84/132 doctrine);
 *   - without a JWT_SECRET visible to the service the rung is INERT:
 *     the token is just junk query data.
 */

const JWT_TEST = 'magic-link-http-spec-auth-secret';
const RECEIPT_TEST = 'magic-link-http-spec-receipt-secret';

const ORDER_ID = '9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d';
const OTHER_ORDER_ID = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const UNKNOWN_ID = '7e7e7e7e-7e7e-4e7e-8e7e-7e7e7e7e7e7e';
const OWNER_ID = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const REST_ID = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';

const CANONICAL_404 = JSON.stringify({
  error: { code: 'NOT_FOUND', message: 'Order not found', details: null },
});

type Fixture = Partial<Order> | null;

const fixtures = (): Map<string, Fixture> =>
  new Map<string, Fixture>([
    [ORDER_ID, {
      id: ORDER_ID,
      code: 'FO-MAGIC',
      status: OrderStatus.PENDING,
      userId: OWNER_ID,
      contactEmail: 'guest+magic@example.com',
      restaurantId: REST_ID,
      items: [],
    }],
    [OTHER_ORDER_ID, {
      id: OTHER_ORDER_ID,
      code: 'FO-OTHER',
      status: OrderStatus.PENDING,
      userId: null, // the real guest-order shape the emails serve
      contactEmail: 'other@example.com',
      restaurantId: REST_ID,
      items: [],
    }],
  ]);

/**
 * `secrets` controls what the service can see through ConfigService —
 * the INERT-rung arm passes none, exactly like the bare unit harnesses.
 */
async function boot(opts: { receiptSecret?: string } = {}) {
  const initial = fixtures();
  const repo = {
    findOne: jest.fn(async (q: any) => {
      const f = initial.get(q?.where?.id);
      return f ? { ...f } : null;
    }),
  } as unknown as Repository<Order>;
  const config = opts.receiptSecret === undefined
    ? undefined
    : { get: (key: string) => (key === 'JWT_SECRET' ? opts.receiptSecret : undefined) };
  const svc = new OrdersService(
    repo,
    {} as any,
    {} as any,
    new OrderEventsService(),
    {} as any,
    {} as any,
    undefined, // payments repo (gate inert)
    config as any,
  );

  const moduleRef = await Test.createTestingModule({
    imports: [JwtModule.register({ secret: JWT_TEST })],
    controllers: [OrdersController],
    providers: [
      JwtAuthGuard,
      OptionalJwtAuthGuard,
      RolesGuard,
      RateLimitGuard,
      Reflector,
      { provide: OrdersService, useValue: svc },
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
  const tokens = {
    owner: await jwt.signAsync({ sub: OWNER_ID, role: UserRole.CUSTOMER, typ: TOKEN_TYPE_ACCESS }),
    admin: await jwt.signAsync({ sub: 'ffffffffff-4a4a-8a4a-8a4a-1a1a1a1a1a1a', role: UserRole.ADMIN, typ: TOKEN_TYPE_ACCESS }),
  };
  return { app, tokens };
}

function read(
  app: INestApplication,
  qs: string,
  opts: { bearer?: string; id?: string } = {},
): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const headers: Record<string, string> = {};
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    const path = `/api/orders/${opts.id ?? ORDER_ID}${qs ? `?${qs}` : ''}`;
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode!, raw }));
    });
    req.on('error', reject);
    req.end();
  });
}

const mint = (id: string, ttl: number = DEFAULT_RECEIPT_TOKEN_TTL_SEC) =>
  issueReceiptAccessToken(id, RECEIPT_TEST, ttl);

describe('GET /api/orders/:id?rt= — the magic-link rung over real HTTP', () => {
  let app: INestApplication;
  let tokens: { owner: string; admin: string };

  beforeAll(async () => {
    ({ app, tokens } = await boot({ receiptSecret: RECEIPT_TEST }));
  });
  afterAll(async () => { await app.close(); });

  it('valid token unlocks the receipt for a total stranger (no bearer, no email)', async () => {
    const r = await read(app, `rt=${mint(ORDER_ID)}`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.raw).code).toBe('FO-MAGIC');
  });
  it('valid token unlocks a GUEST order (userId NULL) — the email-recipient case', async () => {
    const r = await read(app, `rt=${mint(OTHER_ORDER_ID)}`, { id: OTHER_ORDER_ID });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.raw).code).toBe('FO-OTHER');
  });
  it('token minted for ANOTHER order denies with the canonical 404', async () => {
    const r = await read(app, `rt=${mint(OTHER_ORDER_ID)}`);
    expect(r.status).toBe(404);
    expect(r.raw).toBe(CANONICAL_404);
  });
  it('tampered token denies byte-identically', async () => {
    const tok = mint(ORDER_ID);
    const [p, s] = tok.split('.');
    const flip = (b: string) => (b[0] === 'A' ? 'B' + b.slice(1) : 'A' + b.slice(1));
    for (const bad of [`${flip(p)}.${s}`, `${p}.${flip(s)}`, tok.slice(0, -4), 'not-even-close']) {
      const r = await read(app, `rt=${bad}`);
      expect(r.status).toBe(404);
      expect(r.raw).toBe(CANONICAL_404);
    }
  });
  it('expired token denies (1s ttl, presented after it ages out)', async () => {
    const tok = mint(ORDER_ID, 1);
    expect((await read(app, `rt=${tok}`)).status).toBe(200);
    await sleep(1600);
    const r = await read(app, `rt=${tok}`);
    expect(r.status).toBe(404);
    expect(r.raw).toBe(CANONICAL_404);
  });
  it('junk rt shapes answer 404 never 5xx: empty, repeated keys, brackets, oversize', async () => {
    for (const qs of [
      'rt=',
      `rt=${mint(ORDER_ID)}&rt=${mint(OTHER_ORDER_ID)}`, // pipe String()-joins to 'a,b'
      'rt[a]=b',
      `rt=${'x'.repeat(5000)}`,
    ]) {
      const r = await read(app, qs);
      expect(r.status).toBe(404);
      expect(r.raw).toBe(CANONICAL_404);
    }
  });
  it('unknown id + valid-for-it token still 404s (the repo miss precedes the rung)', async () => {
    const r = await read(app, `rt=${mint(UNKNOWN_ID)}`, { id: UNKNOWN_ID });
    expect(r.status).toBe(404);
    expect(r.raw).toBe(CANONICAL_404);
  });

  it('bearer ladder unchanged: owner bearer + garbage rt rides rung 2', async () => {
    const r = await read(app, 'rt=garbage', { bearer: tokens.owner });
    expect(r.status).toBe(200);
  });
  it('typed contact-email proof keeps working untouched', async () => {
    const r = await read(app, 'contactEmail=guest%2Bmagic%40example.com');
    expect(r.status).toBe(200);
  });
  it('ADMIN bearer + expired rt still reads (rung order, not token order)', async () => {
    const tok = mint(ORDER_ID, 1);
    await sleep(1600);
    const r = await read(app, `rt=${tok}`, { bearer: tokens.admin });
    expect(r.status).toBe(200);
  });

  it('percent-encoded rt survives the wire (token is base64url: no special chars)', async () => {
    const tok = mint(ORDER_ID);
    const enc = encodeURIComponent(tok);
    expect(enc).toBe(tok); // URL-safe by construction — emails must not mangle it
    const r = await read(app, `rt=${enc}`);
    expect(r.status).toBe(200);
  });
});

describe('inert rung — no JWT_SECRET visible to the service', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await boot()); // config undefined: every bare unit harness
  });
  afterAll(async () => { await app.close(); });

  it('a would-be-valid token is just junk query data: 404 canonical', async () => {
    const r = await read(app, `rt=${mint(ORDER_ID)}`);
    expect(r.status).toBe(404);
    expect(r.raw).toBe(CANONICAL_404);
  });
  it('empty-string secret is also inert (never a self-verified capability)', async () => {
    const other = await boot({ receiptSecret: '' });
    try {
      const r = await read(other.app, `rt=${mint(ORDER_ID)}`);
      expect(r.status).toBe(404);
    } finally {
      await other.app.close();
    }
  });
});
