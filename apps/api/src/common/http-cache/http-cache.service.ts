import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
 */
@Injectable()
export class HttpCacheService {
  readonly ttlSec: number;
  readonly store: HttpCacheStore;

  constructor(config: ConfigService) {
    this.ttlSec = resolveTtlSec(config.get<string>('HTTP_CACHE_TTL_SEC'));
    this.store = new HttpCacheStore(MAX_HTTP_CACHE_ENTRIES);
  }

  middleware(): (
    req: import('express').Request,
    res: import('express').Response,
    next: import('express').NextFunction,
  ) => void {
    return createHttpCacheMiddleware({ ttlSec: this.ttlSec, store: this.store });
  }
}
