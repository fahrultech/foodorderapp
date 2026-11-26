import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestMetricsService } from '../metrics/request-metrics.service';
import {
  HttpCacheStore,
  MAX_HTTP_CACHE_ENTRIES,
  resolveTtlSec,
} from './http-cache';
import { createHttpCacheMiddleware } from './http-cache.middleware';

/**
 * Nest wiring around the DI-free cache store: owns the single in-process
 * store the middleware serves from, resolves HTTP_CACHE_TTL_SEC ONCE at
 * boot (same doctrine as every other ops knob: garbage → default, 0 →
 * feature off, an observability/perf typo must never crash boot).
 *
 * Cache telemetry (session 138): EVERY event class has exactly ONE
 * producer into the shared metrics registry — hits/stores/revalidations
 * come from the middleware's onCacheEvent branches, evictions from the
 * store's onEvict (only the store knows when a cap drop actually happens).
 * With ttlSec=0 the middleware passes requests through and records
 * nothing, so a disabled feature reports honest zeros.
 */
@Injectable()
export class HttpCacheService {
  readonly ttlSec: number;
  readonly store: HttpCacheStore;

  constructor(
    config: ConfigService,
    private readonly metrics: RequestMetricsService,
  ) {
    this.ttlSec = resolveTtlSec(config.get<string>('HTTP_CACHE_TTL_SEC'));
    this.store = new HttpCacheStore(MAX_HTTP_CACHE_ENTRIES, () =>
      this.metrics.recordCache('evictions'),
    );
  }

  middleware(): (
    req: import('express').Request,
    res: import('express').Response,
    next: import('express').NextFunction,
  ) => void {
    return createHttpCacheMiddleware({
      ttlSec: this.ttlSec,
      store: this.store,
      onCacheEvent: (counter) => this.metrics.recordCache(counter),
    });
  }
}
