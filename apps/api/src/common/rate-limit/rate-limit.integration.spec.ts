import * as http from 'http';
import { Body, Controller, HttpCode, Module, Post, Get, UseGuards } from '@nestjs/common';
import { IsString } from 'class-validator';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { createGlobalValidationPipe } from '../app-config';
import { ErrorFormatFilter } from '../error-format.filter';
import { REQUEST_ID_HEADER, requestIdMiddleware } from '../logging/request-id.middleware';
import { RateLimitModule } from './rate-limit.module';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimit } from './rate-limit.decorator';
import { SlidingWindowLogStore } from './rate-limit.store';

/**
 * Env for the default app: auth = 3/min-equivalent… seconds, orders = 2 hits
 * per 2 s window (short windows keep the sliding test honest and fast).
 */
const TEST_ENV: Record<string, string> = {
  RATE_LIMIT_AUTH_MAX: '3',
  RATE_LIMIT_AUTH_WINDOW_SEC: '1',
  RATE_LIMIT_ORDERS_MAX: '2',
  RATE_LIMIT_ORDERS_WINDOW_SEC: '2',
};

class LoginProbeDto {
  @IsString()
  username!: string;
}

@Controller('probe-auth')
@UseGuards(RateLimitGuard) // class-level: only @RateLimit handlers are throttled
class ProbeAuthController {
  @Post('login')
  @HttpCode(200)
  @RateLimit('auth')
  login(@Body() dto: LoginProbeDto) {
    return { ok: true, user: dto.username };
  }

  @Post('register')
  @HttpCode(201)
  @RateLimit('auth')
  register(@Body() dto: LoginProbeDto) {
    return { ok: true, created: dto.username };
  }

  @Get('me')
  me() {
    return { me: true };
  }
}

@Controller('probe-orders')
class ProbeOrdersController {
  @Post()
  @HttpCode(201)
  @RateLimit('orders')
  @UseGuards(RateLimitGuard)
  create() {
    return { id: 'order-1' };
  }
}

@Module({ imports: [RateLimitModule], controllers: [ProbeAuthController, ProbeOrdersController] })
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
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const server = app.getHttpServer() as http.Server;
    const port = (server.address() as any).port;
    const raw = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (raw !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode!, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (raw !== undefined) req.write(raw);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('rate limiting — live HTTP integration (production middleware chain)', () => {
  let app: INestApplication;
  let store: SlidingWindowLogStore;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [...Object.keys(TEST_ENV), 'RATE_LIMIT_TRUST_PROXY'];

  async function bootApp(): Promise<void> {
    const moduleRef = await Test.createTestingModule({ imports: [RateLimitModule, ProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(createGlobalValidationPipe());
    app.useGlobalFilters(new ErrorFormatFilter());
    app.use(requestIdMiddleware);
    await app.init();
    await app.listen(0);
    store = app.get(SlidingWindowLogStore);
  }

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    Object.assign(process.env, TEST_ENV);
    delete process.env.RATE_LIMIT_TRUST_PROXY;
    await bootApp();
  });

  afterAll(async () => {
    await app.close();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  beforeEach(() => {
    store.reset();
  });

  it('lets `limit` requests through with countdown headers, blocks the next with the standard envelope', async () => {
    const body = { username: 'ada' };
    const allowed = [];
    for (let i = 0; i < 3; i++) allowed.push(await request(app, 'POST', '/api/probe-auth/login', { body }));
    allowed.forEach((r, i) => {
      expect(r.status).toBe(200);
      expect(r.headers['x-ratelimit-limit']).toBe('3');
      expect(r.headers['x-ratelimit-remaining']).toBe(String(2 - i));
      expect(Number(r.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
    });

    const blocked = await request(app, 'POST', '/api/probe-auth/login', { body });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe('RATE_LIMITED');
    expect(typeof blocked.json.error.message).toBe('string');
    expect(blocked.json.error.details).toMatchObject({ bucket: 'auth', retry_after_sec: 1, window_sec: 1 });
    expect(blocked.headers['retry-after']).toBe(String(blocked.json.error.details.retry_after_sec));
    // req_id in the 429 payload matches the echoed correlation id (session 25 hook-up).
    expect(blocked.json.error.details.req_id).toBe(blocked.headers[REQUEST_ID_HEADER.toLowerCase()]);
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('shares the auth bucket across login and register (same attacker, same wallet)', async () => {
    await request(app, 'POST', '/api/probe-auth/login', { body: { username: 'a' } });
    await request(app, 'POST', '/api/probe-auth/register', { body: { username: 'b' } });
    await request(app, 'POST', '/api/probe-auth/login', { body: { username: 'c' } });
    const r = await request(app, 'POST', '/api/probe-auth/register', { body: { username: 'd' } });
    expect(r.status).toBe(429);
    expect(r.json.error.details.bucket).toBe('auth');
  });

  it('slides the window: the blocked caller is served again once the oldest hit expires', async () => {
    for (let i = 0; i < 3; i++) await request(app, 'POST', '/api/probe-auth/login', { body: { username: 'x' } });
    expect((await request(app, 'POST', '/api/probe-auth/login', { body: { username: 'x' } })).status).toBe(429);
    await sleep(1150); // auth window = 1 s
    const revived = await request(app, 'POST', '/api/probe-auth/login', { body: { username: 'x' } });
    expect(revived.status).toBe(200);
    expect(revived.headers['x-ratelimit-remaining']).toBe('2');
  }, 10_000);

  it('isolates buckets: an exhausted auth lane never touches orders or unthrottled routes', async () => {
    for (let i = 0; i < 4; i++) await request(app, 'POST', '/api/probe-auth/login', { body: { username: 'x' } });
    const orders = await request(app, 'POST', '/api/probe-orders');
    expect(orders.status).toBe(201);
    const me = await request(app, 'GET', '/api/probe-auth/me');
    expect(me.status).toBe(200); // class guard, no metadata → always allowed
  });

  it('counts guest order creation separately from auth, with its own limit', async () => {
    await request(app, 'POST', '/api/probe-orders');
    await request(app, 'POST', '/api/probe-orders');
    const r = await request(app, 'POST', '/api/probe-orders');
    expect(r.status).toBe(429);
    expect(r.json.error.details.bucket).toBe('orders');
    // auth lane untouched
    expect((await request(app, 'POST', '/api/probe-auth/login', { body: { username: 'x' } })).status).toBe(200);
  });

  it('runs before validation: an over-limit malformed body still gets 429, not 400', async () => {
    for (let i = 0; i < 3; i++) await request(app, 'POST', '/api/probe-auth/login', { body: { username: 'x' } });
    const malformed = await request(app, 'POST', '/api/probe-auth/login', { body: { nope: 42 } });
    expect(malformed.status).toBe(429);
    expect(malformed.json.error.code).toBe('RATE_LIMITED');
  });

  it('does not count blocked requests (retries cannot extend the window)', async () => {
    const body = { username: 'x' };
    for (let i = 0; i < 3; i++) await request(app, 'POST', '/api/probe-auth/login', { body });
    for (let i = 0; i < 5; i++) expect((await request(app, 'POST', '/api/probe-auth/login', { body })).status).toBe(429);
    await sleep(1150);
    // One fresh slot — not zero: the 5 futile retries never touched the bucket.
    expect((await request(app, 'POST', '/api/probe-auth/login', { body })).status).toBe(200);
  }, 10_000);

  it('ignores spoofed X-Forwarded-For on a direct listener (default): one shared bucket', async () => {
    const spoofHops = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'];
    const statuses: number[] = [];
    for (const hop of spoofHops) {
      const r = await request(app, 'POST', '/api/probe-auth/login', {
        body: { username: 'x' },
        headers: { 'x-forwarded-for': hop },
      });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]); // all counted on 127.0.0.1
  });
});

describe('rate limiting — trusted proxy mode (RATE_LIMIT_TRUST_PROXY=1)', () => {
  let app: INestApplication;
  let store: SlidingWindowLogStore;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['RATE_LIMIT_AUTH_MAX', 'RATE_LIMIT_AUTH_WINDOW_SEC', 'RATE_LIMIT_TRUST_PROXY'];

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.RATE_LIMIT_AUTH_MAX = '2';
    process.env.RATE_LIMIT_AUTH_WINDOW_SEC = '60';
    process.env.RATE_LIMIT_TRUST_PROXY = '1';
    const moduleRef = await Test.createTestingModule({ imports: [RateLimitModule, ProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new ErrorFormatFilter());
    await app.init();
    await app.listen(0);
    store = app.get(SlidingWindowLogStore);
  });

  afterAll(async () => {
    await app.close();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  beforeEach(() => {
    store.reset();
  });

  it('gives every distinct first-hop IP its own bucket', async () => {
    const body = { username: 'x' };
    for (const hop of ['203.0.113.1', '203.0.113.2']) {
      await request(app, 'POST', '/api/probe-auth/login', { body, headers: { 'x-forwarded-for': `${hop}, 10.0.0.1` } });
      await request(app, 'POST', '/api/probe-auth/login', { body, headers: { 'x-forwarded-for': `${hop}, 10.0.0.1` } });
    }
    // Both per-hop buckets now hold 2/2 hits.
    const a = await request(app, 'POST', '/api/probe-auth/login', { body, headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1' } });
    expect(a.status).toBe(429);
    const b = await request(app, 'POST', '/api/probe-auth/login', { body, headers: { 'x-forwarded-for': '203.0.113.2, 10.0.0.1' } });
    expect(b.status).toBe(429);
    // A third visitor is unaffected.
    const c = await request(app, 'POST', '/api/probe-auth/login', { body, headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' } });
    expect(c.status).toBe(200);
  });
});
