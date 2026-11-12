import * as http from 'http';
import { Writable } from 'node:stream';
import { Controller, Get, INestApplication, Module, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Logger as PinoInstance } from 'pino';
import { ErrorFormatFilter } from '../error-format.filter';
import { createHttpLoggingMiddleware } from '../logging/http-logging';
import { createRootLogger, PinoLoggerService } from '../logging/pino-logger';
import { requestIdMiddleware } from '../logging/request-id.middleware';
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
}

@Controller('health')
class HealthController {
  @Get()
  health(): { status: string } {
    return { status: 'ok' };
  }
}

@Module({ controllers: [ProbeController, HealthController] })
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
    // exercised directly below.
    metricsService = new RequestMetricsService({ get: () => '0' } as unknown as ConfigService);
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
