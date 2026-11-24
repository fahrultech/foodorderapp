import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlertVerdictRow } from './alert-verdict.entity';
import { AlertVerdictsService } from './alert-verdicts.service';
import { MetricsPersistenceService } from './metrics-persistence.service';
import { MetricsSnapshotRow } from './metrics-snapshot.entity';
import { RequestMetricsService } from './request-metrics.service';
import { RestockBacklogObserver } from './restock-backlog.observer';

/**
 * Process-lifetime singleton by design: one registry per Node instance,
 * shared between the capture middleware (wired in main.ts) and the ADMIN
 * metrics route (imported by AdminModule). MetricsPersistenceService adds
 * the durability layer (session 89): periodic full-snapshot rows in
 * `metrics_snapshots` + the window/durability fields on GET /admin/metrics.
 * AlertVerdictsService (Phase 11) rides the SAME tick knobs to append the
 * alert-verdict time series to `alert_verdicts` and serve the windowed
 * history + consecutive-alerting streak behind GET /admin/alerts/history.
 */
@Module({
  imports: [TypeOrmModule.forFeature([MetricsSnapshotRow, AlertVerdictRow])],
  providers: [RequestMetricsService, MetricsPersistenceService, AlertVerdictsService, RestockBacklogObserver],
  exports: [RequestMetricsService, MetricsPersistenceService, AlertVerdictsService, RestockBacklogObserver],
})
export class MetricsModule {}
