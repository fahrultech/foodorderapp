import { ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import { AppException } from '../app-exception';
import { currentReqId } from '../logging/request-context';
import { RATE_LIMIT_CONFIG, type RateLimitConfig } from './rate-limit.config';
import { resolveBucket } from './rate-limit.decorator';
import { SlidingWindowLogStore } from './rate-limit.store';

/**
 * Sliding-window rate limit as a guard (not middleware) so it sees route
 * metadata: `@RateLimit('auth'|'orders')` opts handlers in, everything else
 * passes untouched. List it FIRST in `@UseGuards` chains so throttled routes
 * shed load before JWT verification or validation do any work.
 *
 * Verdict contract (asserted by the guard + integration specs):
 * - every throttled response carries `X-RateLimit-Limit/Remaining/Reset`;
 * - a blocked request gets `Retry-After` (integer seconds) and the standard
 *   error envelope `{ error: { code: "RATE_LIMITED", details: { …, req_id } } }`
 *   — `req_id` matches the echoed `X-Request-Id` so support can trace a 429.
 *
 * Identity = client IP (socket address, or the first XFF hop when
 * RATE_LIMIT_TRUST_PROXY=1 behind a header-overwriting proxy). Per-user
 * keying was deliberately NOT used for the credential endpoints: attackers
 * have no users yet, and mixing key spaces would let account rotation
 * launder the limit.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly store: SlidingWindowLogStore,
    @Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const bucket = resolveBucket(context);
    if (!bucket) return true;
    const rule = this.config.rules[bucket];
    if (!rule) return true; // unknown bucket → fail open (typed decorator prevents this)

    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    const key = `${bucket}:${this.identity(req)}`;
    const verdict = this.store.check(key, rule.limit, rule.windowMs);

    this.setHeader(res, 'X-RateLimit-Limit', String(verdict.limit));
    this.setHeader(res, 'X-RateLimit-Remaining', String(verdict.remaining));
    this.setHeader(res, 'X-RateLimit-Reset', String(Math.ceil(verdict.resetAtMs / 1000)));

    if (!verdict.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
      this.setHeader(res, 'Retry-After', String(retryAfterSec));
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        'Too many requests — please retry shortly',
        {
          bucket,
          retry_after_sec: retryAfterSec,
          window_sec: Math.round(rule.windowMs / 1000),
          req_id: currentReqId() ?? null,
        },
      );
    }
    return true;
  }

  private identity(req: any): string {
    if (this.config.trustProxy) {
      const xff = req.headers?.['x-forwarded-for'];
      const first = Array.isArray(xff) ? xff[0] : xff;
      const hop = typeof first === 'string' ? first.split(',')[0]!.trim() : '';
      if (hop) return hop;
    }
    return req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
  }

  private setHeader(res: any, name: string, value: string): void {
    // Optional call: keeps the guard usable with minimal response stubs in
    // unit tests; Express always provides setHeader.
    res.setHeader?.(name, value);
  }
}
