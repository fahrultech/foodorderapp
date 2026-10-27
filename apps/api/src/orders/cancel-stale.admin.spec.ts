import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';

import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { ErrorFormatFilter } from '../common/error-format.filter';
import { createGlobalValidationPipe } from '../common/app-config';
import { TOKEN_TYPE_ACCESS } from '../common/tokens';
import { UserRole } from '../users/user.entity';
import { OrderStatus } from './order.entity';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { SlidingWindowLogStore } from '../common/rate-limit/rate-limit.store';
import { RATE_LIMIT_CONFIG, loadRateLimitConfig } from '../common/rate-limit/rate-limit.config';

/**
 * Phase 5 "auto-cancel stale pending orders" — the ADMIN ops route
 * `POST /orders/ops/cancel-stale`, exercised over real HTTP with the PRODUCTION
 * ValidationPipe + ErrorFormatFilter and the REAL JwtAuthGuard + RolesGuard.
 * OrdersService is mocked, so this proves the routing, the auth/role gate, and
 * DTO validation — not the sweep itself (that has its own unit spec).
 */

const SECRET = '***';
const ADMIN_ID = 'a0000000-0000-4000-8000-00000000000a';
const OWNER_ID = 'b0000000-0000-4000-8000-00000000000b';

const SAMPLE_REPORT = {
  staleMinutes: 45,
  cutoff: '2026-10-27T11:15:00.000Z',
  scanned: 2,
  cancelled: 2,
  capped: false,
  orders: [
    { id: 'x', code: 'FO-A' },
    { id: 'y', code: 'FO-B' },
  ],
};

function request(
  app: INestApplication,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: any }> {
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
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('POST /orders/ops/cancel-stale — admin stale-order sweep', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let cancelStalePending: jest.Mock;

  beforeAll(async () => {
    cancelStalePending = jest.fn(async () => SAMPLE_REPORT);
    const mockedOrders = {
      cancelStalePending,
      // Stubs for the other controller routes so the app compiles; unused here.
      findOne: jest.fn(async (id: string) => ({ id })),
      nextStatuses: jest.fn(async () => [OrderStatus.CONFIRMED]),
      create: jest.fn(async () => ({})),
      findMine: jest.fn(async () => ({ items: [], total: 0 })),
      cancel: jest.fn(async (id: string) => ({ id })),
      updateStatus: jest.fn(async () => ({})),
    } as unknown as OrdersService;

    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: SECRET })],
      controllers: [OrdersController],
      providers: [
        RolesGuard,
        Reflector,
        SlidingWindowLogStore,
        { provide: RATE_LIMIT_CONFIG, useValue: loadRateLimitConfig({}) },
        { provide: OrdersService, useValue: mockedOrders },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createGlobalValidationPipe());
    app.useGlobalFilters(new ErrorFormatFilter());
    await app.listen(0); // ephemeral port so address() is resolvable
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app?.close();
  });

  const PATH = '/orders/ops/cancel-stale';
  const token = (role: UserRole) =>
    jwt.signAsync({ sub: role === UserRole.ADMIN ? ADMIN_ID : OWNER_ID, role, typ: TOKEN_TYPE_ACCESS });

  beforeEach(() => cancelStalePending.mockClear());

  it('answers 401 in the standard envelope with no bearer token', async () => {
    const res = await request(app, 'POST', PATH, { body: {} });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('UNAUTHORIZED');
    expect(cancelStalePending).not.toHaveBeenCalled();
  });

  it('answers 401 on a token whose typ is not an access token', async () => {
    const tok = await jwt.signAsync({ sub: ADMIN_ID, role: UserRole.ADMIN, typ: 'refresh' });
    const res = await request(app, 'POST', PATH, { body: {}, token: tok });
    expect(res.status).toBe(401);
    expect(cancelStalePending).not.toHaveBeenCalled();
  });

  it('answers 403 for an authenticated non-admin (OWNER) and never runs the sweep', async () => {
    const res = await request(app, 'POST', PATH, { body: {}, token: await token(UserRole.OWNER) });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('FORBIDDEN');
    expect(cancelStalePending).not.toHaveBeenCalled();
  });

  it('200 for ADMIN: passes the sweep report through, called with no overrides on an empty body', async () => {
    const res = await request(app, 'POST', PATH, { body: {}, token: await token(UserRole.ADMIN) });
    // Command-style POST pinned to @HttpCode(200), matching /auth/refresh & /auth/logout.
    expect(res.status).toBe(200);
    expect(res.json).toEqual(SAMPLE_REPORT);
    expect(res.json.capped).toBe(false); // boolean survives verbatim
    expect(cancelStalePending).toHaveBeenCalledTimes(1);
    expect(cancelStalePending.mock.calls[0][0]).toEqual({ staleMinutes: undefined, limit: undefined });
  });

  it('forwards valid overrides to the service', async () => {
    const res = await request(app, 'POST', PATH, {
      body: { staleMinutes: 30, limit: 100 },
      token: await token(UserRole.ADMIN),
    });
    expect(res.status).toBeLessThan(300);
    expect(cancelStalePending).toHaveBeenCalledWith({ staleMinutes: 30, limit: 100 });
  });

  it('coerces a string override to a number (query/body arrive as strings)', async () => {
    const res = await request(app, 'POST', PATH, {
      body: { staleMinutes: '20' },
      token: await token(UserRole.ADMIN),
    });
    expect(res.status).toBeLessThan(300);
    expect(cancelStalePending).toHaveBeenCalledWith({ staleMinutes: 20, limit: undefined });
  });

  it('400 when staleMinutes is 0 (below Min) — service never runs', async () => {
    const res = await request(app, 'POST', PATH, {
      body: { staleMinutes: 0 },
      token: await token(UserRole.ADMIN),
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('BAD_REQUEST');
    expect(cancelStalePending).not.toHaveBeenCalled();
  });

  it('400 when limit exceeds the batch ceiling', async () => {
    const res = await request(app, 'POST', PATH, {
      body: { limit: 501 },
      token: await token(UserRole.ADMIN),
    });
    expect(res.status).toBe(400);
    expect(cancelStalePending).not.toHaveBeenCalled();
  });

  it('400 when a non-integer override is sent', async () => {
    const res = await request(app, 'POST', PATH, {
      body: { staleMinutes: 'abc' },
      token: await token(UserRole.ADMIN),
    });
    expect(res.status).toBe(400);
    expect(cancelStalePending).not.toHaveBeenCalled();
  });

  it('whitelist: unknown keys are stripped and the run proceeds on defaults (200)', async () => {
    // whitelist:true removes `bogus`; what remains is `{}`, which is a valid
    // all-optional body → the sweep runs with env defaults. This documents the
    // real behaviour (unknown keys do NOT 400 an all-optional body).
    const res = await request(app, 'POST', PATH, {
      body: { bogus: 1 },
      token: await token(UserRole.ADMIN),
    });
    expect(res.status).toBe(200);
    expect(cancelStalePending).toHaveBeenCalledWith({ staleMinutes: undefined, limit: undefined });
  });

  it('an unknown key alongside a valid override still validates the known one', async () => {
    const res = await request(app, 'POST', PATH, {
      body: { bogus: 1, staleMinutes: 30 },
      token: await token(UserRole.ADMIN),
    });
    expect(res.status).toBe(200);
    expect(cancelStalePending).toHaveBeenCalledWith({ staleMinutes: 30, limit: undefined });
  });

  // Route-collision safety: the literal 2-segment path `ops/cancel-stale` and
  // the parameterized `:id/cancel` are distinct registered routes (both listed
  // separately in swagger.spec). Non-admin already proved here (403); the
  // ParseUUIDPipe sweep spec covers the malformed-`:id` behaviour over HTTP.
});
