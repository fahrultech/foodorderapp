import * as http from 'http';
import { Writable } from 'node:stream';
import { Controller, Get, INestApplication, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Logger as PinoInstance } from 'pino';
import { createGlobalValidationPipe } from '../app-config';
import { ErrorFormatFilter } from '../error-format.filter';
import { currentReqId } from './request-context';
import { createHttpLoggingMiddleware } from './http-logging';
import { createRootLogger, PinoLoggerService } from './pino-logger';
import { REQUEST_ID_HEADER, requestIdMiddleware } from './request-id.middleware';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Deliberately calls Nest's static `Logger` (not an injected service): it
 * must route through the same pino facade as everything else and pick up
 * the request context from AsyncLocalStorage — including after an await.
 */
@Controller('probe')
class ProbeController {
  private readonly logger = new Logger(ProbeController.name);

  @Get('ok')
  ok(): { ok: boolean; reqIdFromContext: string | undefined } {
    this.logger.log('handler running');
    return { ok: true, reqIdFromContext: currentReqId() };
  }

  @Get('deferred')
  async deferred(): Promise<{ afterAwait: string | undefined }> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.logger.log('after await');
    return { afterAwait: currentReqId() };
  }

  @Get('boom')
  boom(): never {
    this.logger.warn('about to explode');
    throw new Error('kaboom: SELECT failed on orders');
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

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: any;
}

function request(
  app: INestApplication,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const server = app.getHttpServer() as http.Server;
    const port = (server.address() as any).port;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        let json: any;
        try {
          json = JSON.parse(raw);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode!, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('pino logging + request-id — live HTTP integration (production middleware chain)', () => {
  let app: INestApplication;
  let root: PinoInstance;
  let lines: Record<string, any>[];

  /** Access lines are written when the response finishes — flush and settle. */
  async function drain(): Promise<void> {
    await new Promise<void>((resolve) => root.flush(() => resolve()));
    await new Promise((resolve) => setImmediate(resolve));
  }

  function accessLines(): Record<string, any>[] {
    return lines.filter((l) => l.res !== undefined);
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

    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    // Exact production wiring from src/main.ts.
    app.setGlobalPrefix('api');
    app.useGlobalPipes(createGlobalValidationPipe());
    app.useGlobalFilters(new ErrorFormatFilter());
    app.use(requestIdMiddleware);
    app.use(createHttpLoggingMiddleware(root));
    app.useLogger(new PinoLoggerService(root));
    await app.listen(0);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    lines.length = 0;
  });

  it('200: echoes X-Request-Id, one access line, app line correlated by reqId', async () => {
    const { status, headers, json } = await request(app, 'GET', '/api/probe/ok');
    await drain();
    const reqId = headers[REQUEST_ID_HEADER.toLowerCase()] as string;

    expect(status).toBe(200);
    expect(reqId).toMatch(UUID_V4);
    expect(json).toEqual({ ok: true, reqIdFromContext: reqId });

    const access = accessLines();
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({
      level: 30,
      msg: 'GET /api/probe/ok -> 200',
      reqId,
      res: { statusCode: 200 },
    });
    expect(typeof access[0].responseTime).toBe('number');

    const appLine = lines.find((l) => l.msg === 'handler running');
    expect(appLine).toMatchObject({ level: 30, reqId, context: 'ProbeController' });
  });

  it('async handler after await still resolves the same reqId (ALS propagation)', async () => {
    const { headers, json } = await request(app, 'GET', '/api/probe/deferred');
    await drain();
    const reqId = headers[REQUEST_ID_HEADER.toLowerCase()] as string;
    expect(json.afterAwait).toBe(reqId);
    expect(lines.find((l) => l.msg === 'after await')?.reqId).toBe(reqId);
  });

  it('honours a safe inbound X-Request-Id verbatim', async () => {
    const { headers, json } = await request(app, 'GET', '/api/probe/ok', {
      'x-request-id': 'trace-abc_123',
    });
    await drain();
    expect(headers[REQUEST_ID_HEADER.toLowerCase()]).toBe('trace-abc_123');
    expect(json.reqIdFromContext).toBe('trace-abc_123');
    expect(accessLines()[0].reqId).toBe('trace-abc_123');
  });

  it('replaces an unsafe inbound X-Request-Id with a fresh UUID', async () => {
    const { headers } = await request(app, 'GET', '/api/probe/ok', {
      'x-request-id': 'injected":"{"evil":1',
    });
    await drain();
    expect(headers[REQUEST_ID_HEADER.toLowerCase()]).toMatch(UUID_V4);
  });

  it('404 envelope: warn-level access line carries the request id', async () => {
    const { status, headers, json } = await request(app, 'GET', '/api/probe/nope');
    await drain();
    expect(status).toBe(404);
    expect(json.error.code).toBe('NOT_FOUND');
    const access = accessLines();
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({
      level: 40,
      reqId: headers[REQUEST_ID_HEADER.toLowerCase()],
      res: { statusCode: 404 },
    });
  });

  it('500: filter log + access line share one reqId; internals stay server-side', async () => {
    const { status, headers, json } = await request(app, 'GET', '/api/probe/boom');
    await drain();
    const reqId = headers[REQUEST_ID_HEADER.toLowerCase()] as string;

    expect(status).toBe(500);
    expect(json).toEqual({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error', details: null },
    });

    const filterLine = lines.find((l) => typeof l.msg === 'string' && l.msg.startsWith('Unhandled exception'));
    expect(filterLine).toMatchObject({ level: 50, reqId, context: 'ErrorFormatFilter' });
    expect(filterLine.stack).toContain('kaboom');
    expect(accessLines()[0]).toMatchObject({ level: 50, reqId, res: { statusCode: 500 } });

    // The controller's pre-crash warn line is correlated too.
    expect(lines.find((l) => l.msg === 'about to explode')?.reqId).toBe(reqId);

    // Secret error text never reached the client.
    expect(JSON.stringify(json)).not.toContain('kaboom');
  });

  it('health check responses work but produce no access lines', async () => {
    const { status } = await request(app, 'GET', '/api/health');
    await drain();
    expect(status).toBe(200);
    expect(accessLines()).toHaveLength(0);
    expect(lines.filter((l) => JSON.stringify(l).includes('/api/health'))).toHaveLength(0);
  });
});
