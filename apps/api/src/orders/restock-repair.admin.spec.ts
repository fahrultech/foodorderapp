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
 * Session-72 follow-up ("restock repair pass") — the ADMIN ops route
 * `POST /orders/ops/restock-repair`, exercised over real HTTP with the
 * PRODUCTION ValidationPipe + ErrorFormatFilter and the REAL JwtAuthGuard +
 * RolesGuard. OrdersService is mocked, so this proves the routing, the
 * auth/role gate, and DTO validation — not the repair itself (that has its
 * own unit spec + live smoke).
 */

const SECRET = 'unit-restock-repair-jwt';
const ADMIN_ID = 'a0000000-0000-4000-8000-00000000000a';
const OWNER_ID = 'b0000000-0000-4000-8000-00000000000b';

const SAMPLE_REPORT = {
  graceMinutes: 10,
  cutoff: '2026-11-09T11:30:00.000Z',
  scanned: 2,
  repaired: 1,
  skipped: 1,
  capped: false,
  orders: [{ id: 'x', code: 'FO-A', units: 3 }],
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

describe('POST /orders/ops/restock-repair — admin crashed-cancel repair', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let restockRepair: jest.Mock;

  beforeAll(async () => {
    restockRepair = jest.fn(async () => SAMPLE_REPORT);
    const mockedOrders = {
      restockRepair,
      // Stubs for the other controller routes so the app compiles; unused here.
      findOne: jest.fn(async (id: string) => ({ id })),
      nextStatuses: jest.fn(async () => [OrderStatus.CONFIRMED]),
      create: jest.fn(async () => ({})),
      findMine: jest.fn(async () => ({ items: [], total: 0 })),
      cancel: jest.fn(async (id: string) => ({ id })),
      updateStatus: jest.fn(async () => ({})),
      cancelStalePending: jest.fn(async () => SAMPLE_REPORT),
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

  const PATH = '/orders/ops/restock-repair';
  const token = (role: UserRole) =>
    jwt.signAsync({ sub: role === UserRole.ADMIN ? ADMIN_ID : OWNER_ID, role, typ: TOKEN_TYPE_ACCESS });

  beforeEach(() => restockRepair.mockClear());

  it('answers 401 in the standard envelope with no bearer token', async () => {
    const res = await request(app, 'POST', PATH, { body: {} });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('UNAUTHORIZED');
    expect(restockRepair).not.toHaveBeenCalled();
  });

  it('answers 401 on a token whose typ is not an access token', async () => {
    const tok = await jwt.signAsync({ sub: ADMIN_ID, role: UserRole.ADMIN, typ: 'refresh' });
    const res = await request(app, 'POST', PATH, { body: {}, token: tok });
    expect(res.status).toBe(401);
    expect(restockRepair).not.toHaveBeenCalled();
  });

  it('answers 403 for an authenticated non-admin (OWNER) and never runs the repair', async () => {
    const res = await request(app, 'POST', PATH, { body: {}, token: await token(UserRole.OWNER) });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('FORBIDDEN');
    expect(restockRepair).not.toHaveBeenCalled();
  });

  it('200 for ADMIN: passes the repair report through, called with no overrides on an empty body', async () => {
    const res = await request(app, 'POST', PATH, { body: {}, token: await token(UserRole.ADMIN) });
    // Command-style POST pinned to @HttpCode(200), matching ops/cancel-stale.
    expect(res.status).toBe(200);
    expect(res.json).toEqual(SAMPLE_REPORT);
    expect(res.json.capped).toBe(false); // boolean survives verbatim
    expect(res.json.orders[0].units).toBe(3); // integer units survive verbatim
    expect(restockRepair).toHaveBeenCalledTimes(1);
    expect(restockRepair.mock.calls[0][0]).toEqual({ graceMinutes: undefined, limit: undefined });
  });

  it('forwards valid overrides to the service', async () => {
    const res = await request(app, 'POST', PATH, {
      body: { graceMinutes: 2, limit: 20 },
      token: await token(UserRole.ADMIN),
    });
    expect(res.status).toBeLessThan(300);
    expect(restockRepair).toHaveBeenCalledWith({ graceMinutes: 2, limit: 20 });
  });

  it('coerces a string override to a number (query/body arrive as strings)', async () => {
    const res = await request(app, 'POST', PATH, {
      body: { graceMinutes: '1' },
      token: await token(UserRole.ADMIN),
    });
    expect(res.status).toBeLessThan(300);
    expect(restockRepair).toHaveBeenCalledWith({ graceMinutes: 1, limit: undefined });
  });

  it('400 when graceMinutes is 0 (below Min) — service never runs', async () => {
    const res = await request(app, 'POST', PATH, {
      body: { graceMinutes: 0 },
      token: await token(UserRole.ADMIN),
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('BAD_REQUEST');
    expect(restockRepair).not.toHaveBeenCalled();
  });

  it('400 when limit exceeds the batch ceiling', async () => {
    const res = await request(app, 'POST', PATH, {
      body: { limit: 501 },
      token: await token(UserRole.ADMIN),
    });
    expect(res.status).toBe(400);
    expect(restockRepair).not.toHaveBeenCalled();
  });

  it('400 when a non-integer override is sent', async () => {
    const res = await request(app, 'POST', PATH, {
      body: { graceMinutes: 'abc' },
      token: await token(UserRole.ADMIN),
    });
    expect(res.status).toBe(400);
    expect(restockRepair).not.toHaveBeenCalled();
  });

  it('whitelist: unknown keys are stripped and the run proceeds on defaults (200)', async () => {
    // Same documented behaviour as ops/cancel-stale: whitelist strips `bogus`,
    // the remaining `{}` is a valid all-optional body → env defaults.
    const res = await request(app, 'POST', PATH, {
      body: { bogus: 1 },
      token: await token(UserRole.ADMIN),
    });
    expect(res.status).toBe(200);
    expect(restockRepair).toHaveBeenCalledWith({ graceMinutes: undefined, limit: undefined });
  });

  it('dryRun is NOT exposed over HTTP — an unknown key, stripped like any other', async () => {
    // DRY_RUN is a script/env knob; sending it in a body must not make an
    // admin call report-only. After whitelisting, the repair RUNS on defaults.
    const res = await request(app, 'POST', PATH, {
      body: { dryRun: true },
      token: await token(UserRole.ADMIN),
    });
    expect(res.status).toBe(200);
    expect(restockRepair).toHaveBeenCalledWith({ graceMinutes: undefined, limit: undefined });
  });
});
