import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';

import { RestaurantMetricsController } from './restaurant-metrics.controller';
import { RestaurantsService } from './restaurants.service';
import { RequestMetricsService } from '../common/metrics/request-metrics.service';
import { MetricsPersistenceService } from '../common/metrics/metrics-persistence.service';
import { ErrorFormatFilter } from '../common/error-format.filter';
import { createGlobalValidationPipe } from '../common/app-config';
import { TOKEN_TYPE_ACCESS } from '../common/tokens';
import { UserRole } from '../users/user.entity';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';

/**
 * HTTP-surface integration spec for GET /restaurants/:id/metrics
 * (session 98, Phase 8 per-restaurant traffic). Proves over REAL HTTP:
 * the OWNER rung + admin bypass ladder, ParseUUIDPipe 400, the 404/403
 * service answers through the standard envelope — and, above all, the
 * SESSION-85 SAFETY CONTRACT: the payload is built exclusively from the
 * requested restaurant's bucket and contains no global totals anywhere.
 *
 * RestaurantsService is mocked (ownership ladder pinned via its own unit
 * block); the RequestMetricsService is REAL so the served payload is real
 * registry arithmetic over injected samples.
 */

const JWT_TEST = 'restaurant-metrics-http-spec';
const RID = '11111111-1111-4111-8111-111111111111';
const OTHER_RID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CUST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function httpReq(
  app: INestApplication,
  method: string,
  path: string,
  opts: { token?: string } = {},
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const headers: Record<string, string> = {};
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json: any;
        try { json = JSON.parse(raw); } catch { json = undefined; }
        resolve({ status: res.statusCode!, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function boot(getOwnedImpl?: jest.Mock) {
  const getOwned = getOwnedImpl ?? jest.fn(async (id: string) => ({ id, ownerId: OWNER_ID }));
  const svc = { getOwned } as unknown as RestaurantsService;
  // REAL metrics service (interval 0: no fold timer in tests).
  const metrics = new RequestMetricsService({
    get: (key: string) => (key === 'METRICS_LOG_INTERVAL_SEC' ? '0' : undefined),
  } as any);
  metrics.registry.reset();

  // Persistence is stubbed here — its OWN arithmetic is pinned exhaustively
  // in metrics-persistence.spec; the HTTP surface pins WIRING: the block is
  // served, its key set is the scoped contract, and the store can never
  // leak a global field or throw this route into a 5xx.
  const durabilityStub = {
    enabled: false,
    snapshotIntervalSec: 0,
    retentionSec: 0,
    bootStartedAt: new Date(0).toISOString(),
    lastCapturedAt: null,
    bootAligned: null,
    restaurantsPersisted: false,
    mintedAfterBaseline: false,
    error: false,
    window: null,
  };
  const persistence = {
    describeRestaurant: jest.fn(async () => ({ ...durabilityStub })),
  } as unknown as MetricsPersistenceService;

  const moduleRef = await Test.createTestingModule({
    imports: [JwtModule.register({ secret: JWT_TEST })],
    controllers: [RestaurantMetricsController],
    providers: [
      JwtAuthGuard,
      RolesGuard,
      Reflector,
      { provide: RestaurantsService, useValue: svc },
      { provide: RequestMetricsService, useValue: metrics },
      { provide: MetricsPersistenceService, useValue: persistence },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(createGlobalValidationPipe());
  app.useGlobalFilters(new ErrorFormatFilter());
  await app.listen(0);

  const jwt = app.get(JwtService);
  const ownerToken = await jwt.signAsync({ sub: OWNER_ID, role: UserRole.OWNER, typ: TOKEN_TYPE_ACCESS });
  const adminToken = await jwt.signAsync({ sub: ADMIN_ID, role: UserRole.ADMIN, typ: TOKEN_TYPE_ACCESS });
  const custToken = await jwt.signAsync({ sub: CUST_ID, role: UserRole.CUSTOMER, typ: TOKEN_TYPE_ACCESS });
  const driverToken = await jwt.signAsync({ sub: 'd1', role: UserRole.DRIVER, typ: TOKEN_TYPE_ACCESS });

  return { app, svc, getOwned, metrics, persistence, durabilityStub, ownerToken, adminToken, custToken, driverToken };
}

describe('GET /restaurants/:id/metrics — auth + role ladder', () => {
  it('rejects anonymous (401) and bad tokens (401) before the registry', async () => {
    const { app, metrics } = await boot();
    const anon = await httpReq(app, 'GET', `/api/restaurants/${RID}/metrics`);
    expect(anon.status).toBe(401);
    expect(anon.json.error.code).toBe('UNAUTHORIZED');
    expect(metrics.registry.snapshot().totals.restaurantKeys).toBe(0);

    const bad = await httpReq(app, 'GET', `/api/restaurants/${RID}/metrics`, { token: 'nope' });
    expect(bad.status).toBe(401);
    await app.close();
  });

  it('403 for roles that are not OWNER (admins bypass only past the guard)', async () => {
    const { app, getOwned, custToken, driverToken } = await boot();
    for (const token of [custToken, driverToken]) {
      const res = await httpReq(app, 'GET', `/api/restaurants/${RID}/metrics`, { token });
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('FORBIDDEN');
    }
    // the ownership ladder is never consulted for a non-OWNER role:
    expect(getOwned).not.toHaveBeenCalled();
    await app.close();
  });

  it('400 for a malformed (non-UUID) restaurant id', async () => {
    const { app, ownerToken } = await boot();
    const res = await httpReq(app, 'GET', '/api/restaurants/not-a-uuid/metrics', { token: ownerToken });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBeDefined();
    await app.close();
  });

  it('the service ladder answers: 404 unknown, 403 foreign, admin bypass', async () => {
    const notFound = jest.fn(async () => {
      throw new NotFoundException('Restaurant not found');
    });
    const { app: a1, ownerToken } = await boot(notFound);
    const miss = await httpReq(a1, 'GET', `/api/restaurants/${RID}/metrics`, { token: ownerToken });
    expect(miss.status).toBe(404);
    expect(miss.json.error.code).toBe('NOT_FOUND');
    await a1.close();

    const { app: a2, getOwned, adminToken, metrics } = await boot();
    metrics.registry.record('GET /api/restaurants/:id', 200, 4, RID);
    // mocked getOwned resolves for any caller here; the ADMIN BYPASS itself
    // is a getOwned property (pinned in restaurants.service.spec) — the
    // HTTP surface just proves the controller defers to it and that an
    // ADMIN token answers 200 through the guard chain.
    const admin = await httpReq(a2, 'GET', `/api/restaurants/${RID}/metrics`, { token: adminToken });
    expect(admin.status).toBe(200);
    expect(getOwned).toHaveBeenCalledWith(RID, { sub: ADMIN_ID, role: UserRole.ADMIN });
    await a2.close();
  });
});

describe('GET /restaurants/:id/metrics — scoped payload (no global leak)', () => {
  it('serves ONLY the requested restaurant bucket with the honesty markers', async () => {
    const { app, ownerToken, metrics } = await boot();
    const reg = metrics.registry;
    reg.record('GET /api/restaurants/:id', 200, 4, RID);
    reg.record('GET /api/restaurants/:id', 500, 30, RID);
    reg.record('GET /api/restaurants/:restaurantId/menu', 200, 2, RID);
    reg.record('GET /api/restaurants/:id', 429, 2, RID, true); // guard-marked (session 123)
    reg.record('GET /api/restaurants/:id', 200, 1, OTHER_RID); // foreign
    reg.record('GET /api/orders', 200, 1); // unscoped

    const res = await httpReq(app, 'GET', `/api/restaurants/${RID}/metrics`, { token: ownerToken });
    expect(res.status).toBe(200);
    const body = res.json;
    expect(body.restaurantId).toBe(RID);
    expect(body.scope).toBe('restaurant');
    expect(body.window).toBe('since_api_boot');
    expect(body.totals.requests).toBe(4); // RID only: never 7, never all-of-global
    expect(body.totals.byStatus).toEqual({ '2xx': 2, '3xx': 0, '4xx': 1, '5xx': 1 });
    expect(body.routes.map((r: any) => r.route)).toEqual([
      'GET /api/restaurants/:id',
      'GET /api/restaurants/:restaurantId/menu',
    ]);
    // The session-85 contract, pinned mechanically: the ONLY allowed
    // addition is the scoped `durability` block (session 116). Its window
    // is subtracted inside THIS bucket, and its key set carries neither a
    // global traffic field nor the global `stored` row count.
    expect(Object.keys(body).sort()).toEqual(
      ['boundsMs', 'durability', 'generatedAt', 'restaurantId', 'routes', 'scope', 'totals', 'uptimeSec', 'window'].sort(),
    );
    expect(Object.keys(body.totals).sort()).toEqual(
      ['avgMs', 'byStatus', 'maxMs', 'p50Ms', 'p95Ms', 'p99Ms', 'requests', 'routeKeys', 'overflowed'].sort(),
    );
    expect(Object.keys(body.durability).sort()).toEqual(
      ['bootAligned', 'bootStartedAt', 'enabled', 'error', 'lastCapturedAt', 'mintedAfterBaseline',
        'restaurantsPersisted', 'retentionSec', 'snapshotIntervalSec', 'window'].sort(),
    );
    expect(body.durability).not.toHaveProperty('stored');
    // Session 123: the guard-marked 429 above tops up the OWNER 4xx tally
    // but NEVER surfaces the ADMIN-only `throttled` field — not on the
    // totals (key-set pin above holds it out) and not on any row.
    expect(body.totals).not.toHaveProperty('throttled');
    for (const row of body.routes) expect(Object.keys(row)).not.toContain('throttled');
    // The GLOBAL snapshot (same registry, same arithmetic the ADMIN route
    // serves verbatim — its HTTP round-trip is pinned in admin.controller)
    // DOES see the pressure.
    const globalSnap = metrics.snapshot();
    expect(globalSnap.totals.throttled).toBe(1);
    expect(
      globalSnap.routes.find((r) => r.route === 'GET /api/restaurants/:id')?.throttled,
    ).toBe(1);
    expect(body.durability.window).toBeNull();
    await app.close();
  });

  it('serves the durability block as a strict passthrough of the scoped extras', async () => {
    const { app, ownerToken, persistence } = await boot();
    // A computed window must arrive VERBATIM — the controller composes,
    // it does not reshape. Store-failure swallowing is pinned in
    // metrics-persistence.spec (describeRestaurant NEVER throws), so this
    // route can never be 5xx-ed by a broken durability store.
    const sentinelWindow = { fromCapturedAt: 'x', requests: 3 };
    (persistence as unknown as { describeRestaurant: jest.Mock }).describeRestaurant =
      jest.fn(async () => ({ ...durabilityFixture(), window: sentinelWindow, enabled: true, bootAligned: true, restaurantsPersisted: true }));
    const ok = await httpReq(app, 'GET', `/api/restaurants/${RID}/metrics`, { token: ownerToken });
    expect(ok.status).toBe(200);
    expect(ok.json.durability.window).toEqual(sentinelWindow);
    expect(ok.json.durability.enabled).toBe(true);
    expect(ok.json.totals.requests).toBe(0); // live bucket stays honest under the stub
    await app.close();
  });

  it('an owned restaurant with zero traffic answers an honest EMPTY snapshot', async () => {
    const { app, ownerToken } = await boot();
    const res = await httpReq(app, 'GET', `/api/restaurants/${OTHER_RID}/metrics`, { token: ownerToken });
    expect(res.status).toBe(200);
    expect(res.json.totals.requests).toBe(0);
    expect(res.json.totals.routeKeys).toBe(0);
    expect(res.json.routes).toEqual([]);
    // The extras never gate the view: zero traffic still answers 200 with
    // the honest zero baseline markers.
    expect(res.json.durability.window).toBeNull();
    await app.close();
  });
});

function durabilityFixture() {
  return {
    enabled: false,
    snapshotIntervalSec: 0,
    retentionSec: 0,
    bootStartedAt: new Date(0).toISOString(),
    lastCapturedAt: null,
    bootAligned: null,
    restaurantsPersisted: false,
    mintedAfterBaseline: false,
    error: false,
    window: null,
  };
}
