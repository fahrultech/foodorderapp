import { Global, Module } from '@nestjs/common';
import { RATE_LIMIT_CONFIG, loadRateLimitConfig } from './rate-limit.config';
import { RateLimitGuard } from './rate-limit.guard';
import { SlidingWindowLogStore } from './rate-limit.store';

/**
 * Global so feature modules can attach `RateLimitGuard` without importing
 * anything. Env is read at boot via `loadRateLimitConfig`; the store is
 * process-local (see rate-limit.store.ts for the multi-node seam).
 */
@Global()
@Module({
  providers: [
    { provide: RATE_LIMIT_CONFIG, useFactory: loadRateLimitConfig },
    SlidingWindowLogStore,
    RateLimitGuard,
  ],
  exports: [RateLimitGuard, SlidingWindowLogStore, RATE_LIMIT_CONFIG],
})
export class RateLimitModule {}
