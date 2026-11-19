import { Module } from '@nestjs/common';
import { BrowseCompressionService } from './browse-compression.service';
import { HttpCacheService } from './http-cache.service';

/**
 * Process-lifetime singleton by design: one store per Node instance,
 * consumed by the cache middleware wired LAST in main.ts (after metrics
 * and access logging, so served 304s stay visible to both). Specs read
 * the same instance, mirroring the MetricsModule precedent (session 80).
 */
@Module({
  providers: [HttpCacheService, BrowseCompressionService],
  exports: [HttpCacheService, BrowseCompressionService],
})
export class HttpCacheModule {}
