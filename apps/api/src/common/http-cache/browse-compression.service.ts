import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createBrowseCompressionMiddleware, resolveMinBytes } from './browse-compression';

/**
 * Nest wiring for the browse gzip layer: resolves
 * HTTP_COMPRESS_MIN_BYTES ONCE at boot (garbage -> default, 0 -> off),
 * mirroring HttpCacheService. The middleware it hands main.ts MUST be
 * registered BEFORE the cache middleware — the wrapper then owns
 * res.end while the cache serves from its store, so 200s answered
 * straight from the store are encoded too (session 108 contract).
 */
@Injectable()
export class BrowseCompressionService {
  readonly minBytes: number;

  constructor(config: ConfigService) {
    this.minBytes = resolveMinBytes(config.get<string>('HTTP_COMPRESS_MIN_BYTES'));
  }

  middleware(): (
    req: import('express').Request,
    res: import('express').Response,
    next: import('express').NextFunction,
  ) => void {
    return createBrowseCompressionMiddleware({ minBytes: this.minBytes });
  }
}
