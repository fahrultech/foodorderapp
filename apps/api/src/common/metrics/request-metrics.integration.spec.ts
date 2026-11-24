import * as http from 'http';
import { Writable } from 'node:stream';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { Controller, Get, HttpStatus, INestApplication, Module, NotFoundException, Param, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Logger as PinoInstance } from 'pino';
import { AppException } from '../app-exception';
import { ErrorFormatFilter } from '../error-format.filter';
import { createHttpLoggingMiddleware } from '../logging/http-logging';
import { createRootLogger, PinoLoggerService } from '../logging/pino-logger';
import { requestIdMiddleware } from '../logging/request-id.middleware';
import { markRateLimited } from '../rate-limit/rate-limit.marker';
import { attributeRequestRestaurant } from './restaurant-attribution';
import { RequestMetricsRegistry } from './request-metrics';
import { createRequestMetricsMiddleware } from './request-metrics.middleware';
import { RequestMetricsService } from './request-metrics.service';

/**
 * Production middleware chain over a real HTTP server:
 *   requestId -> metrics -> pino-http access logging
 * Pins the three contracts that unit tests CANNOT prove:
 *  1. req.route (the matched TEMPLATE incl. the /api global prefix) is
 *     already resolved when the 'finish' listener runs, so uuid paths
 *     collapse to ':id' keys even in the live app;
 *  2. the ORDER between our finish listener and pino-http's — the access
 *     line must carry the `metrics` summary (this is what would silently
 *     break if someone swaps the app.use() calls in main.ts);
 *  3. the periodic snapshot fold lands in the SAME pino stream.
 */

@Controller('probe')
class ProbeController {
  @Get('ok')
  ok(): { ok: boolean } {
    return { ok: true };
  }

  @Get('thing/:id')
  thing(): { thing: true } {
    return { thing: true };
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException('no such thing');
  }

  @Get('boom')
  boom(): never {
    throw new Error('kaboom');
  }

  @Get('throttled')
  throttled(@Req() req: ExpressRequest): never {
    // Exactly what RateLimitGuard does on a blocked request: stamp the
    // req with the bucket BEFORE throwing the 429 (session 123).
    markRateLimited(req, 'probe');
    throw new AppException(
      HttpStatus.TOO_MANY_REQUESTS,
      'RATE_LIMITED',
      'Too many requests — please retry shortly',
      { bucket: 'probe' },
    );
  }

  @Get('fake-429')
  fake429(@Res() res: ExpressResponse): void {
    // Same WIRE status, NO guard stamp: an unmarked 429 must never inflate
    // the limiter-pressure tally (session 123's both-halves rule).
    res.status(HttpStatus.TOO_MANY_REQUESTS).json({ error: { code: 'NOT_THE_GUARD' } });
  }
}

@Controller('health')
class HealthController {
  @Get()
  health(): { status: string } {
    return { status: 'ok' };
  }
}

/**
 * Session 98: restaurant-scoped routes under the REAL controller-prefix
 * shape (`@Controller('restaurants/:id')`), so attribution is proven over
 * genuine Express finish-time resolution — NOT against hand-built reqs.
 * `gone` 404s to prove probes cannot mint buckets.
 */
@Controller('restaurants/:id')
class RestaurantProbeController {
  @Get()
  one(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Get('wins')
  wins(): { ok: boolean } {
    // Session 125: a service on a restaurant-SCOPED template stamps a
    // DIFFERENT restaurant anyway (a buggy/hostile opt-in call). The
    // template match must win — attribution can only ever COVER routes
    // the template never resolves, never override one it does.
    attributeRequestRestaurant(ATTR_B);
    return { ok: true };
  }

  @Get('menu')
  menu(): { menu: true } {
    return { menu: true };
  }

  @Get('gone')
  gone(): never {
    throw new NotFoundException('not there');
  }

  @Get('metrics')
  metrics(): { totals: { requests: number } } {
    return { totals: { requests: 0 } };
  }

  @Get('throttled')
  throttled(@Req() req: ExpressRequest): never {
    markRateLimited(req, 'probe');
    throw new AppException(
      HttpStatus.TOO_MANY_REQUESTS,
      'RATE_LIMITED',
      'Too many requests — please retry shortly',
      { bucket: 'probe' },
    );
  }
}

/** Session 125 attribution probes: restaurant ids used by the explicit hook. */
const ATTR_A = 'ab12cd34-ef56-4789-8abc-def012345678';
const ATTR_B = 'cd34ef56-ab12-4899-9abc-def012345679';

/**
 * Session 125 "order-centric attribution": routes whose matched TEMPLATE
 * carries NO restaurant param — the exact POST /orders / payments / receipt-
 * read shape — driven purely through the explicit service-side opt-in hook,
 * over the REAL middleware chain (ALS captured at entry, read at finish).
 */
@Controller('attrib')
class AttributionProbeController {
  @Get('plain')
  plain(): { ok: boolean } {
    attributeRequestRestaurant(ATTR_A);
    return { ok: true };
  }

  @Get('fail-a')
  failA(): never {
    attributeRequestRestaurant(ATTR_A);
    throw AppException.conflict('ATTR_PROBE_CONFLICT', 'stamped failure', {});
  }

  @Get('fail-b')
  failB(): never {
    attributeRequestRestaurant(ATTR_B);
    throw AppException.conflict('ATTR_PROBE_CONFLICT', 'stamped failure', {});
  }

  @Get('junk')
  junk(): { ok: boolean } {
    // Hook contract: non-uuid stamps are inert, never a minted bucket.
    attributeRequestRestaurant('not-a-uuid-at-all');
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController, RestaurantProbeController, AttributionProbeController, HealthController] })
class ProbeModule {}

function request(app: INestApplication, method: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = app.getHttpServer() as http.Server;
    const port = (server.address() as { port: number }).port;
    const req = http.request({ host: '127.0.0.1', port, method, path }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('request metrics — live middleware chain', () => {
  let app: INestApplication;
  let root: PinoInstance;
  let registry: RequestMetricsRegistry;
  let metricsService: RequestMetricsService;
  let lines: Record<string, any>[];

  async function drain(): Promise<void> {
    await new Promise<void>((resolve) => root.flush(() => resolve()));
    await new Promise((resolve) => setImmediate(resolve));
  }

  function accessLines(): Record<string, any>[] {
    return lines.filter((l) => l.res !== undefined);
  }

  function routeRow(key: string) {
    return registry.snapshot().routes.find((r) => r.route === key);
  }

  beforeAll(async () => {
    lines = [];
    let buf = '';
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        buf += chunk.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.length > 0) lines.push(JSON.parse(line));
        }
        cb();
      },
    });
    root = createRootLogger({ level: 'debug', stream });

    // interval 0: no periodic timer in the test process; logSnapshot() is
    // exercised directly below. ALERT_* stay UNSET so the alert engine runs
    // on its shipped defaults (0.5% / 1000ms / min 50) in every fold test.
    metricsService = new RequestMetricsService({
      get: (key: string) => (key === 'METRICS_LOG_INTERVAL_SEC' ? '0' : undefined),
    } as unknown as ConfigService);
    registry = metricsService.registry;

    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
      providers: [{ provide: RequestMetricsService, useValue: metricsService }],
    }).compile();
    app = moduleRef.createNestApplication();
    // Exact production wiring + ORDER from src/main.ts.
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new ErrorFormatFilter());
    app.use(requestIdMiddleware);
    app.use(metricsService.middleware());
    app.use(createHttpLoggingMiddleware(root));
    app.useLogger(new PinoLoggerService(root));
    await app.listen(0);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    lines.length = 0;
    registry.reset();
  });

  it('matched routes key on the TEMPLATE at finish time — two ids, one row', async () => {
    await request(app, 'GET', '/api/probe/thing/5f0a1b2c-3d4e-4f50-9a8b-7c6d5e4f3a2b');
    await request(app, 'GET', '/api/probe/thing/00112233-4455-4667-8899-aabbccddeeff');
    await request(app, 'GET', '/api/probe/thing/42');
    await drain();

    const snap = registry.snapshot();
    expect(snap.totals.routeKeys).toBe(1);
    const row = routeRow('GET /api/probe/thing/:id')!;
    expect(row.requests).toBe(3);
    expect(row.byStatus['2xx']).toBe(3);
    // The raw paths never became keys:
    expect(snap.routes.some((r) => r.route.includes('5f0a1b2c'))).toBe(false);
  });

  it('access line carries the metrics summary (finish-listener ordering contract)', async () => {
    await request(app, 'GET', '/api/probe/ok');
    await drain();

    const access = accessLines();
    expect(access).toHaveLength(1);
    expect(access[0].msg).toBe('GET /api/probe/ok -> 200');
    expect(access[0].metrics).toBeDefined();
    expect(access[0].metrics.status_class).toBe('2xx');
    expect(typeof access[0].metrics.bucket).toBe('string');
    expect(access[0].metrics.bucket).toMatch(/^<=\d+ms$/);
    expect(registry.snapshot().totals.requests).toBe(1);
  });

  it('404 (envelope) records 4xx against its route/matched path key', async () => {
    await request(app, 'GET', '/api/probe/missing');
    await drain();
    expect(routeRow('GET /api/probe/missing')?.byStatus['4xx']).toBe(1);
    expect(accessLines()[0]).toMatchObject({ level: 40, metrics: { status_class: '4xx' } });
  });

  it('unmatched paths collapse (with dynamic-segment normalization) into one row', async () => {
    await request(app, 'GET', '/api/nope/nothing-here');
    await request(app, 'GET', '/api/nope/99999/deeper');
    await drain();
    const snap = registry.snapshot();
    expect(snap.totals.routeKeys).toBe(2);
    expect(routeRow('GET /api/nope/nothing-here')?.requests).toBe(1);
    expect(routeRow('GET /api/nope/:id/deeper')?.requests).toBe(1);
  });

  it('500 records 5xx — the alerting signal — on the same row', async () => {
    await request(app, 'GET', '/api/probe/boom');
    await drain();
    expect(routeRow('GET /api/probe/boom')?.byStatus['5xx']).toBe(1);
    expect(accessLines()[0]).toMatchObject({ level: 50, metrics: { status_class: '5xx' } });
  });

  it('health is invisible to BOTH the access log and the metrics registry', async () => {
    await request(app, 'GET', '/api/health');
    await drain();
    expect(accessLines()).toHaveLength(0);
    expect(registry.snapshot().totals.requests).toBe(0);
  });

  it('logSnapshot() folds ONE aggregate line into the same pino stream', async () => {
    await request(app, 'GET', '/api/probe/ok');
    await drain();
    lines.length = 0;

    metricsService.logSnapshot();
    await drain();

    expect(lines).toHaveLength(1);
    const fold = lines[0];
    expect(fold).toMatchObject({
      level: 30,
      msg: 'request metrics snapshot',
      context: 'RequestMetricsService',
      event: 'request_metrics',
    });
    expect(fold.metrics.totals.requests).toBe(1);
    expect(fold.metrics.boundsMs.length).toBeGreaterThan(0);
    expect(fold.metrics.routes[0].route).toBe('GET /api/probe/ok');
  });

  it('fold line carries the compact alert verdict from the SAME engine as /admin/alerts', async () => {
    // Healthy single request: budget below the min sample, p95 far under
    // 1000ms, no overflow → ok with an empty firing list.
    await request(app, 'GET', '/api/probe/ok');
    await drain();
    lines.length = 0;
    expect(metricsService.alertThresholds).toEqual({
      fiveXxRatePctMax: 0.5,
      p95MsMax: 1000,
      minRequests: 50,
      rateLimitPctMax: 5,
      snapshotStaleAfterSec: null,
    });
    metricsService.logSnapshot();
    await drain();
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('request_metrics');
    expect(lines[0].alerts).toEqual({ status: 'ok', firing: [] });

    // Burn the budget on the SHARED registry: 1 x 500 in a 51-request
    // sample = 1.96% > 0.5%. The fold and service.alerts() must agree —
    // one engine, two consumers (GET /admin/alerts calls the same code).
    for (let i = 0; i < 50; i++) registry.record('GET /api/probe/ok', 200, 10);
    registry.record('GET /api/probe/boom', 500, 10);
    lines.length = 0;
    metricsService.logSnapshot();
    await drain();
    expect(lines[0].alerts).toEqual({ status: 'alerting', firing: ['error_budget'] });
    const report = metricsService.alerts();
    expect(report.status).toBe('alerting');
    expect(report.firingRules).toEqual(['error_budget']);
    const eb = report.rules.find((x) => x.id === 'error_budget')!;
    // 1/52 ≈ 1.92% — assert the band, not the exact rounding, so one
    // stray probe sample cannot false-fail the fold contract.
    expect(eb.observed!).toBeGreaterThan(0.5);
    expect(eb.observed!).toBeLessThan(10);
    expect(eb.detail).toContain('budget');
  });

  it('restaurant dimension: finish-time attribution on a REAL controller prefix', async () => {
    const RIDB = '00112233-4455-4667-8899-aabbccddeeff';
    const RIDA = '5f0a1b2c-3d4e-4f50-9a8b-7c6d5e4f3a2b';

    // 404 BEFORE any success: probes of unknown restaurants mint NO bucket...
    expect(await request(app, 'GET', `/api/restaurants/${RIDB}/gone`)).toBe(404);
    await drain();
    expect(registry.restaurantSnapshot(RIDB).totals.requests).toBe(0);
    // ...while the GLOBAL registry still tallies everything.
    expect(routeRow('GET /api/restaurants/:id/gone')?.byStatus['4xx']).toBe(1);

    // 2xx mints the bucket; later errors top it up; case normalizes.
    expect(await request(app, 'GET', `/api/restaurants/${RIDB}`)).toBe(200);
    expect(await request(app, 'GET', `/api/restaurants/${RIDB}/gone`)).toBe(404);
    expect(await request(app, 'GET', `/api/restaurants/${RIDB.toUpperCase()}/menu`)).toBe(200);
    await drain();

    const b = registry.restaurantSnapshot(RIDB);
    expect(b.totals.requests).toBe(3);
    expect(b.totals.byStatus).toEqual({ '2xx': 2, '3xx': 0, '4xx': 1, '5xx': 0 });
    expect(b.routes.map((r) => r.route)).toEqual([
      'GET /api/restaurants/:id',
      'GET /api/restaurants/:id/gone',
      'GET /api/restaurants/:id/menu',
    ]);
    // A foreign restaurant never sees these samples:
    expect(registry.restaurantSnapshot(RIDA).totals.requests).toBe(0);

    // The metrics read is EXEMPT: globally tracked, never attributed.
    expect(await request(app, 'GET', `/api/restaurants/${RIDB}/metrics`)).toBe(200);
    await drain();
    expect(routeRow('GET /api/restaurants/:id/metrics')?.requests).toBe(1);
    expect(registry.restaurantSnapshot(RIDB).totals.requests).toBe(3); // UNCHANGED

    // Unmatched junk shaped like a restaurant path mints nothing either:
    expect(await request(app, 'GET', `/api/restaurants/${RIDB}/nothing-here`)).toBe(404);
    await drain();
    expect(registry.snapshot().totals.restaurantKeys).toBe(1);
    expect(routeRow('GET /api/restaurants/:id/metrics')?.requests).toBe(1); // still exempt
  });

  it('order-centric attribution: the explicit service stamp folds NO-param routes into the bucket (session 125)', async () => {
    // 409 AFTER a stamp CANNOT MINT: bucket B stays a zero, no keys exist.
    expect(await request(app, 'GET', '/api/attrib/fail-b')).toBe(409);
    await drain();
    expect(registry.restaurantSnapshot(ATTR_B).totals.requests).toBe(0);
    expect(registry.snapshot().totals.restaurantKeys).toBe(0);

    // A junk (non-uuid) stamp is inert even through the real chain.
    expect(await request(app, 'GET', '/api/attrib/junk')).toBe(200);
    await drain();
    expect(registry.snapshot().totals.restaurantKeys).toBe(0);

    // A fresh 2xx MINTS A on the ORDER-CENTRIC route key...
    expect(await request(app, 'GET', '/api/attrib/plain')).toBe(200);
    await drain();
    const a = registry.restaurantSnapshot(ATTR_A);
    expect(a.totals.requests).toBe(1);
    expect(a.routes.map((r) => r.route)).toEqual(['GET /api/attrib/plain']);

    // ...and the next stamped 409 TOPS UP the existing bucket — owners see
    // failures on their surfaces, same rule as the template channel.
    expect(await request(app, 'GET', '/api/attrib/fail-a')).toBe(409);
    await drain();
    const a2 = registry.restaurantSnapshot(ATTR_A);
    expect(a2.totals.requests).toBe(2);
    expect(a2.totals.byStatus['4xx']).toBe(1);
    expect(a2.routes.map((r) => r.route)).toEqual(['GET /api/attrib/fail-a', 'GET /api/attrib/plain']);
    // GLOBAL rows are untouched by the fold — attribution is ADDITIVE.
    expect(routeRow('GET /api/attrib/plain')?.requests).toBe(1);
    expect(routeRow('GET /api/attrib/fail-a')?.byStatus['4xx']).toBe(1);
  });

  it('a matched template BEATS a service stamp — attribution can never override (session 125)', async () => {
    expect(await request(app, 'GET', `/api/restaurants/${ATTR_A}/wins`)).toBe(200);
    await drain();
    const a = registry.restaurantSnapshot(ATTR_A);
    expect(a.totals.requests).toBe(1);
    expect(a.routes.map((r) => r.route)).toEqual(['GET /api/restaurants/:id/wins']);
    // The foreign stamp never minted B: one bucket, the honest one.
    expect(registry.restaurantSnapshot(ATTR_B).totals.requests).toBe(0);
    expect(registry.snapshot().totals.restaurantKeys).toBe(1);
  });

  it('throttle tally: guard-marked 429s count, UNMARKED 429s never do (session 123)', async () => {
    expect(await request(app, 'GET', '/api/probe/throttled')).toBe(429);
    expect(await request(app, 'GET', '/api/probe/throttled')).toBe(429);
    expect(await request(app, 'GET', '/api/probe/fake-429')).toBe(429);
    await drain();

    const marked = routeRow('GET /api/probe/throttled');
    expect(marked?.requests).toBe(2);
    expect(marked?.throttled).toBe(2);
    // The envelope + status class keep behaving exactly as before: 429 is
    // still plain 4xx for the error budget, throttled is a SUBSET tally.
    expect(marked?.byStatus['4xx']).toBe(2);
    const unmarked = routeRow('GET /api/probe/fake-429');
    expect(unmarked?.requests).toBe(1);
    expect(unmarked?.throttled).toBe(0);
    expect(unmarked?.byStatus['4xx']).toBe(1);
    expect(registry.snapshot().totals.throttled).toBe(2);
  });

  it('restaurant dimension never carries the throttle field (OWNER rung contract, session 123)', async () => {
    const RID = '00aa11bb-22cc-44dd-55ee-66ff77889900';
    // Mint the bucket with a real 2xx, then throttle onto the existing row.
    expect(await request(app, 'GET', `/api/restaurants/${RID}`)).toBe(200);
    expect(await request(app, 'GET', `/api/restaurants/${RID}/throttled`)).toBe(429);
    await drain();

    // GLOBAL: the sample counts as guard-throttled...
    expect(routeRow('GET /api/restaurants/:id/throttled')?.throttled).toBe(1);
    // ...the OWNER rung tops up the request/4xx tallies but exposes NO
    // throttled key anywhere — rows and totals keep the session-98 shape.
    const b = registry.restaurantSnapshot(RID);
    expect(b.totals.requests).toBe(2);
    expect(b.totals.byStatus['4xx']).toBe(1);
    expect(Object.keys(b.totals)).not.toContain('throttled');
    for (const row of b.routes) expect(Object.keys(row)).not.toContain('throttled');
  });

  it('service ctor honours the interval knob: 0 = no timer, 5 = 5s', () => {
    const off = new RequestMetricsService({ get: () => '0' } as unknown as ConfigService);
    expect(off.intervalSec).toBe(0);
    expect((off as unknown as { timer: unknown }).timer).toBeNull();
    const on = new RequestMetricsService({ get: () => 'garbage' } as unknown as ConfigService);
    expect(on.intervalSec).toBe(60); // garbage -> default, never a crash
    expect((on as unknown as { timer: unknown }).timer).not.toBeNull();
    on.onModuleDestroy(); // clean up the real interval
    expect((on as unknown as { timer: unknown }).timer).toBeNull();
  });
});
