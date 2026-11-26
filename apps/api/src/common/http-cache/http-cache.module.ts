import { Module } from '@nestjs/common';
import { MetricsModule } from '../metrics/metrics.module';
import { BrowseCompressionService } from './browse-compression.service';
import { HttpCacheService } from './http-cache.service';

/**
 * Process-lifetime singleton by design: one store per Node instance,
 * consumed by the cache middleware wired LAST in main.ts (after metrics
 * and access logging, so served 304s stay visible to both). Specs read
 * the same instance, mirroring the MetricsModule precedent (session 80).
 * Imports MetricsModule for the session-138 cache-dimension fold: every
 * hit/store/revalidation/eviction event lands in the SAME shared registry
 * the ADMIN snapshot reads — one stream, never a second tally source.
 */
@Module({
  imports: [MetricsModule],
  providers: [HttpCacheService, BrowseCompressionService],
  exports: [HttpCacheService, BrowseCompressionService],
})
export class HttpCacheModule {}
