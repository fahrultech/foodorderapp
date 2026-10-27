import { ExecutionContext, HttpException } from '@nestjs/common';
import { AppException } from '../app-exception';
import { runWithRequestContext } from '../logging/request-context';
import { loadRateLimitConfig, type RateLimitConfig } from './rate-limit.config';
import { RateLimit } from './rate-limit.decorator';
import { RateLimitGuard } from './rate-limit.guard';
import { SlidingWindowLogStore } from './rate-limit.store';

const META_KEY = 'foodorder:rate-limit-bucket';

interface FakeReq {
  ip?: string;
  headers: Record<string, string | string[]>;
  socket?: { remoteAddress?: string };
}

function makeRes() {
  const headers: Record<string, string> = {};
  return { headers, setHeader(name: string, value: unknown) { headers[name] = String(value); } };
}

function makeContext(req: FakeReq, res: ReturnType<typeof makeRes>, handler = () => ({}), cls = class {}): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
      getNext: () => () => undefined,
    }),
  } as unknown as ExecutionContext;
}

/** Apply the real decorator to a throwaway handler (descriptor form). */
function decoratedHandler(bucket: 'auth' | 'orders') {
  const fn = () => ({});
  RateLimit(bucket)(undefined as never, 'h', { value: fn } as never);
  return fn;
}

describe('RateLimitGuard (unit)', () => {
  let store: SlidingWindowLogStore;
  let config: RateLimitConfig;
  let guard: RateLimitGuard;

  beforeEach(() => {
    store = new SlidingWindowLogStore();
    config = loadRateLimitConfig({}); // production defaults
    guard = new RateLimitGuard(store, config);
  });

  it('passes requests on handlers without @RateLimit and records nothing', () => {
    const spy = jest.spyOn(store, 'check');
    const res = makeRes();
    const ctx = makeContext({ ip: '1.2.3.4', headers: {} }, res);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(res.headers).toEqual({});
  });

  it('valid bucket metadata that is not in config fails open', () => {
    const guard2 = new RateLimitGuard(store, { rules: { auth: undefined as never, orders: undefined as never, payments: undefined as never }, trustProxy: false });
    const ctx = makeContext({ ip: '1.2.3.4', headers: {} }, makeRes(), decoratedHandler('auth'));
    expect(guard2.canActivate(ctx)).toBe(true);
  });

  it('records the hit under "<bucket>:<ip>" with the configured rule', () => {
    const spy = jest.spyOn(store, 'check');
    const ctx = makeContext({ ip: '203.0.113.7', headers: {} }, makeRes(), decoratedHandler('auth'));
    expect(guard.canActivate(ctx)).toBe(true);
    expect(spy).toHaveBeenCalledWith('auth:203.0.113.7', 10, 60_000);
  });

  it('sets X-RateLimit-* headers on allowed requests', () => {
    const res = makeRes();
    const ctx = makeContext({ ip: '9.9.9.9', headers: {} }, res, decoratedHandler('auth'));
    guard.canActivate(ctx);
    expect(res.headers['X-RateLimit-Limit']).toBe('10');
    expect(res.headers['X-RateLimit-Remaining']).toBe('9');
    const reset = Number(res.headers['X-RateLimit-Reset']);
    expect(reset).toBeGreaterThanOrEqual(Math.ceil(Date.now() / 1000));
    expect(reset).toBeLessThanOrEqual(Math.ceil((Date.now() + 60_000) / 1000));
  });

  it('blocks the request that exhausts the bucket with RATE_LIMITED 429', () => {
    const res = makeRes();
    // Drain the bucket through the real store first (10/min default).
    for (let i = 0; i < 10; i++) store.check('auth:8.8.8.8', 10, 60_000);
    const ctx = makeContext({ ip: '8.8.8.8', headers: {} }, res, decoratedHandler('auth'));
    let thrown: unknown;
    try {
      guard.canActivate(ctx);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppException);
    const http = thrown as HttpException;
    expect(http.getStatus()).toBe(429);
    const body = http.getResponse() as Record<string, any>;
    expect(body.code).toBe('RATE_LIMITED');
    expect(typeof body.message).toBe('string');
    expect(body.details.bucket).toBe('auth');
    expect(body.details.retry_after_sec).toBeGreaterThanOrEqual(1);
    expect(body.details.retry_after_sec).toBeLessThanOrEqual(60);
    expect(body.details.window_sec).toBe(60);
    expect(res.headers['Retry-After']).toBe(String(body.details.retry_after_sec));
    expect(res.headers['X-RateLimit-Remaining']).toBe('0');
  });

  it('attaches the active reqId to the 429 details for support tracing', () => {
    for (let i = 0; i < 10; i++) store.check('auth:7.7.7.7', 10, 60_000);
    const ctx = makeContext({ ip: '7.7.7.7', headers: {} }, makeRes(), decoratedHandler('auth'));
    const run = () => {
      try {
        guard.canActivate(ctx);
        return null;
      } catch (e) {
        return e as AppException;
      }
    };
    const inside = runWithRequestContext({ reqId: 'trace-42' }, run);
    expect(inside).toBeInstanceOf(AppException);
    expect((inside!.getResponse() as any).details.req_id).toBe('trace-42');
    // Outside any request context: still a valid envelope, null id.
    const outside = run();
    expect((outside!.getResponse() as any).details.req_id).toBeNull();
  });

  it('falls back to controller-level metadata when the handler has none', () => {
    class Ctrl {}
    RateLimit('orders')(Ctrl as never);
    const spy = jest.spyOn(store, 'check');
    const ctx = makeContext({ ip: '5.5.5.5', headers: {} }, makeRes(), () => ({}), Ctrl);
    guard.canActivate(ctx);
    expect(spy).toHaveBeenCalledWith('orders:5.5.5.5', 30, 60_000);
  });

  it('handler metadata wins over controller metadata', () => {
    class Ctrl {}
    RateLimit('orders')(Ctrl as never);
    const spy = jest.spyOn(store, 'check');
    const ctx = makeContext({ ip: '5.5.5.5', headers: {} }, makeRes(), decoratedHandler('auth'), Ctrl);
    guard.canActivate(ctx);
    expect(spy).toHaveBeenCalledWith('auth:5.5.5.5', 10, 60_000);
  });

  it('ignores spoofed X-Forwarded-For when trustProxy is off (default)', () => {
    const spy = jest.spyOn(store, 'check');
    const ctx = makeContext(
      { ip: '1.1.1.1', headers: { 'x-forwarded-for': '203.0.113.99, 10.0.0.1' } },
      makeRes(),
      decoratedHandler('auth'),
    );
    guard.canActivate(ctx);
    expect(spy).toHaveBeenCalledWith('auth:1.1.1.1', 10, 60_000);
  });

  it('uses the first XFF hop as identity when trustProxy is on', () => {
    const trusting = new RateLimitGuard(store, { ...config, trustProxy: true });
    const spy = jest.spyOn(store, 'check');
    trusting.canActivate(makeContext({ ip: '10.0.0.9', headers: { 'x-forwarded-for': ' 198.51.100.4, 203.0.113.9' } }, makeRes(), decoratedHandler('auth')));
    expect(spy).toHaveBeenCalledWith('auth:198.51.100.4', 10, 60_000);
  });

  it('handles array-valued XFF headers (duplicate hop) when trusting', () => {
    const trusting = new RateLimitGuard(store, { ...config, trustProxy: true });
    const spy = jest.spyOn(store, 'check');
    trusting.canActivate(makeContext({ ip: '10.0.0.9', headers: { 'x-forwarded-for': ['198.51.100.5', '203.0.113.9'] } }, makeRes(), decoratedHandler('auth')));
    expect(spy).toHaveBeenCalledWith('auth:198.51.100.5', 10, 60_000);
  });

  it('falls back to the socket address when trustProxy is on but no XFF arrived', () => {
    const trusting = new RateLimitGuard(store, { ...config, trustProxy: true });
    const spy = jest.spyOn(store, 'check');
    trusting.canActivate(makeContext({ headers: {}, socket: { remoteAddress: '127.0.0.2' } }, makeRes(), decoratedHandler('auth')));
    expect(spy).toHaveBeenCalledWith('auth:127.0.0.2', 10, 60_000);
  });

  it('rejects unknown bucket metadata values (not a real opt-in)', () => {
    const handler = () => ({});
    Reflect.defineMetadata(META_KEY, 'sms', handler);
    const spy = jest.spyOn(store, 'check');
    expect(guard.canActivate(makeContext({ ip: '4.4.4.4', headers: {} }, makeRes(), handler))).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
