/**
 * Rate-limit buckets and their env-tunable rules.
 *
 * Buckets group endpoints that should share a counter: a brute-forcer
 * cycling login→register→refresh still drains one `auth` allowance. Limits
 * are deliberately generous for humans and tight for scripted abuse; ops
 * overrides via env without a redeploy.
 */

export const RATE_LIMIT_BUCKETS = ['auth', 'orders'] as const;
export type RateLimitBucket = (typeof RATE_LIMIT_BUCKETS)[number];

export interface RateLimitRule {
  /** Max requests per identity per window. */
  limit: number;
  /** Window length in ms (sliding). */
  windowMs: number;
}

export interface RateLimitConfig {
  rules: Record<RateLimitBucket, RateLimitRule>;
  /**
   * When true, client identity = first X-Forwarded-For hop (only safe when
   * the API sits behind a proxy that *overwrites* the header — enabling it
   * on a public listener lets attackers mint unlimited buckets by
   * spoofing XFF). When false (default), identity = the socket IP.
   */
  trustProxy: boolean;
}

export const RATE_LIMIT_CONFIG = 'RATE_LIMIT_CONFIG' as const;

const DEFAULTS: Record<RateLimitBucket, { max: number; windowSec: number }> = {
  // Password guessing / account farming: 10 credential attempts / minute / IP.
  auth: { max: 10, windowSec: 60 },
  // Order spam (guest checkout is open by design): 30 orders / minute / IP.
  orders: { max: 30, windowSec: 60 },
};

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function truthy(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

export function loadRateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  return {
    rules: {
      auth: {
        limit: positiveInt(env.RATE_LIMIT_AUTH_MAX, DEFAULTS.auth.max),
        windowMs: positiveInt(env.RATE_LIMIT_AUTH_WINDOW_SEC, DEFAULTS.auth.windowSec) * 1000,
      },
      orders: {
        limit: positiveInt(env.RATE_LIMIT_ORDERS_MAX, DEFAULTS.orders.max),
        windowMs: positiveInt(env.RATE_LIMIT_ORDERS_WINDOW_SEC, DEFAULTS.orders.windowSec) * 1000,
      },
    },
    trustProxy: truthy(env.RATE_LIMIT_TRUST_PROXY),
  };
}
