import { SetMetadata } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { RateLimitBucket } from './rate-limit.config';

export const RATE_LIMIT_META_KEY = 'foodorder:rate-limit-bucket';

/**
 * Opt a handler (or a whole controller) into the `RateLimitGuard` bucket.
 * Handlers *without* this metadata always pass the guard, so the guard can
 * sit on the controller class while only the sensitive routes are throttled.
 */
export const RateLimit = (bucket: RateLimitBucket) => SetMetadata(RATE_LIMIT_META_KEY, bucket);

/** Handler metadata wins over controller-level metadata. */
export function resolveBucket(context: ExecutionContext): RateLimitBucket | undefined {
  const handler = context.getHandler();
  const fromHandler = Reflect.getMetadata(RATE_LIMIT_META_KEY, handler);
  if (isBucket(fromHandler)) return fromHandler;
  const fromClass = Reflect.getMetadata(RATE_LIMIT_META_KEY, context.getClass());
  return isBucket(fromClass) ? fromClass : undefined;
}

function isBucket(value: unknown): value is RateLimitBucket {
  return value === 'auth' || value === 'orders';
}
