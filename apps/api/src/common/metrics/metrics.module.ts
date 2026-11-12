import { Module } from '@nestjs/common';
import { RequestMetricsService } from './request-metrics.service';

/**
 * Process-lifetime singleton by design: one registry per Node instance,
 * shared between the capture middleware (wired in main.ts) and the ADMIN
 * metrics route (imported by AdminModule).
 */
@Module({
  providers: [RequestMetricsService],
  exports: [RequestMetricsService],
})
export class MetricsModule {}
