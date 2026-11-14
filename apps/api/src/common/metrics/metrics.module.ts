import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MetricsPersistenceService } from './metrics-persistence.service';
import { MetricsSnapshotRow } from './metrics-snapshot.entity';
import { RequestMetricsService } from './request-metrics.service';

/**
 * Process-lifetime singleton by design: one registry per Node instance,
 * shared between the capture middleware (wired in main.ts) and the ADMIN
 * metrics route (imported by AdminModule). MetricsPersistenceService adds
 * the durability layer (session 89): periodic full-snapshot rows in
 * `metrics_snapshots` + the window/durability fields on GET /admin/metrics.
 */
@Module({
  imports: [TypeOrmModule.forFeature([MetricsSnapshotRow])],
  providers: [RequestMetricsService, MetricsPersistenceService],
  exports: [RequestMetricsService, MetricsPersistenceService],
})
export class MetricsModule {}
