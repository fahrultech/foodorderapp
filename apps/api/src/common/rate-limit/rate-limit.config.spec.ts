import { loadRateLimitConfig } from './rate-limit.config';

describe('loadRateLimitConfig', () => {
  const base = {
    RATE_LIMIT_AUTH_MAX: undefined,
    RATE_LIMIT_AUTH_WINDOW_SEC: undefined,
    RATE_LIMIT_ORDERS_MAX: undefined,
    RATE_LIMIT_ORDERS_WINDOW_SEC: undefined,
    RATE_LIMIT_PAYMENTS_MAX: undefined,
    RATE_LIMIT_PAYMENTS_WINDOW_SEC: undefined,
    RATE_LIMIT_TRUST_PROXY: undefined,
  };

  it('falls back to documented defaults (auth 10/min, orders 30/min, payments 10/min, socket IP)', () => {
    const cfg = loadRateLimitConfig({ ...base } as NodeJS.ProcessEnv);
    expect(cfg.rules.auth).toEqual({ limit: 10, windowMs: 60_000 });
    expect(cfg.rules.orders).toEqual({ limit: 30, windowMs: 60_000 });
    expect(cfg.rules.payments).toEqual({ limit: 10, windowMs: 60_000 });
    expect(cfg.trustProxy).toBe(false);
  });

  it('honours env overrides', () => {
    const cfg = loadRateLimitConfig(
      { ...base, RATE_LIMIT_AUTH_MAX: '5', RATE_LIMIT_ORDERS_WINDOW_SEC: '120', RATE_LIMIT_PAYMENTS_MAX: '3' } as NodeJS.ProcessEnv,
    );
    expect(cfg.rules.auth.limit).toBe(5);
    expect(cfg.rules.orders.windowMs).toBe(120_000);
    expect(cfg.rules.payments.limit).toBe(3);
  });

  it('reads RATE_LIMIT_TRUST_PROXY only on explicit 1/true', () => {
    expect(loadRateLimitConfig({ ...base, RATE_LIMIT_TRUST_PROXY: '1' } as NodeJS.ProcessEnv).trustProxy).toBe(true);
    expect(loadRateLimitConfig({ ...base, RATE_LIMIT_TRUST_PROXY: 'true' } as NodeJS.ProcessEnv).trustProxy).toBe(true);
    expect(loadRateLimitConfig({ ...base, RATE_LIMIT_TRUST_PROXY: 'yes' } as NodeJS.ProcessEnv).trustProxy).toBe(false);
    expect(loadRateLimitConfig({ ...base, RATE_LIMIT_TRUST_PROXY: '' } as NodeJS.ProcessEnv).trustProxy).toBe(false);
  });

  it.each(['0', '-3', '1.5', 'abc', '', '  ', 'NaN', 'Infinity'])(
    'rejects garbage override %j and keeps the default',
    (value) => {
      const cfg = loadRateLimitConfig({ ...base, RATE_LIMIT_AUTH_MAX: value } as NodeJS.ProcessEnv);
      expect(cfg.rules.auth.limit).toBe(10);
    },
  );

  it('defaults are safe for humans: a normal session never hits them by accident', () => {
    const cfg = loadRateLimitConfig({ ...base } as NodeJS.ProcessEnv);
    // Login burst of 8 (user fumbling a password) stays under the auth limit.
    expect(8).toBeLessThan(cfg.rules.auth.limit);
    // 20 orders/min (heavy fuzzing of one account) stays under the orders limit.
    expect(20).toBeLessThan(cfg.rules.orders.limit);
  });
});
