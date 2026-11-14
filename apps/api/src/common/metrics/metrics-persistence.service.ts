import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetricsSnapshotRow } from './metrics-snapshot.entity';
import {
  computeWindowDelta,
  isSnapshotShape,
  MetricsDurability,
  MetricsWindowDelta,
} from './metrics-window';
import { MetricsSnapshot } from './request-metrics';
import { RequestMetricsService } from './request-metrics.service';

export const DEFAULT_METRICS_SNAPSHOT_INTERVAL_SEC = 300; // 5 min
export const DEFAULT_METRICS_SNAPSHOT_RETENTION_SEC = 86400; // 24 h — at the default
// interval that caps the table at 288 small jsonb rows, trivially bounded.

/**
 * METRICS_SNAPSHOT_INTERVAL_SEC parsing — same rules as the pino fold knob
 * (resolveIntervalSec): unset/empty/negative/garbage → default (an
 * observability typo must NEVER crash boot); `0` disables persistence
 * entirely (`GET /admin/metrics` then reports durability.enabled=false and
 * window=null and touches NO database).
 */
export function resolveSnapshotIntervalSec(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return DEFAULT_METRICS_SNAPSHOT_INTERVAL_SEC;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_METRICS_SNAPSHOT_INTERVAL_SEC;
  return Math.floor(n);
}

/**
 * METRICS_SNAPSHOT_RETENTION_SEC: unset/garbage/negative/0 → default.
 * `0` is treated as garbage on purpose — a zero-second retention would
 * prune every row including the one just written, silently killing the
 * window feature for a typo'd knob.
 */
export function resolveSnapshotRetentionSec(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return DEFAULT_METRICS_SNAPSHOT_RETENTION_SEC;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_METRICS_SNAPSHOT_RETENTION_SEC;
  return Math.floor(n);
}

/**
 * Persists the cumulative metrics registry to `metrics_snapshots` on a
 * timer and derives the durability + window fields `GET /admin/metrics`
 * adds to the snapshot (additive — the pre-existing snapshot shape is
 * untouched, so the admin TrafficPanel keeps working).
 *
 * Failure posture (session-86 doctrine: a dead smoke detector must never
 * page — or 5xx — like a fire): persistence errors are caught + warned, the
 * read path degrades to `durability.error=true, window=null`, and the route
 * still returns the live snapshot with 200.
 */
@Injectable()
export class MetricsPersistenceService implements OnModuleDestroy {
  readonly snapshotIntervalSec: number;
  readonly retentionSec: number;
  private readonly logger = new Logger(MetricsPersistenceService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    config: ConfigService,
    private readonly metrics: RequestMetricsService,
    @InjectRepository(MetricsSnapshotRow)
    private readonly repo: Repository<MetricsSnapshotRow>,
  ) {
    this.snapshotIntervalSec = resolveSnapshotIntervalSec(
      config.get<string>('METRICS_SNAPSHOT_INTERVAL_SEC'),
    );
    this.retentionSec = resolveSnapshotRetentionSec(
      config.get<string>('METRICS_SNAPSHOT_RETENTION_SEC'),
    );
    if (this.enabled) {
      this.timer = setInterval(() => {
        void this.persistNow();
      }, this.snapshotIntervalSec * 1000);
      // Never keep the event loop alive for a persistence heartbeat.
      this.timer.unref();
    }
  }

  get enabled(): boolean {
    return this.snapshotIntervalSec > 0;
  }

  /** Registry creation time (ms epoch) of the LIVE process — rows stamp this. */
  private get bootStartedAtMs(): number {
    return this.metrics.registry.bootStartedAtMs;
  }

  /**
   * One scheduler tick, exported for tests: write the current cumulative
   * snapshot, then prune rows older than the retention window. Idempotent
   * per call; ANY database error is swallowed with a warn (never throws —
   * a broken DB connection must not take down the metrics heartbeat or
   * surface as an unhandled rejection).
   */
  async persistNow(): Promise<'written' | 'failed' | 'disabled'> {
    if (!this.enabled) return 'disabled';
    try {
      const capturedAt = new Date();
      const payload = this.metrics.snapshot();
      const row = this.repo.create({
        capturedAt,
        bootStartedAt: new Date(this.bootStartedAtMs),
        payload,
      });
      await this.repo.save(row);
      const cutoff = new Date(capturedAt.getTime() - this.retentionSec * 1000);
      // NB: NOT 'snap.capturedAt' — this TypeORM version's DeleteQueryBuilder
      // emits `DELETE FROM "metrics_snapshots" WHERE snap.capturedAt < $1`
      // (alias dropped from FROM, left in WHERE) => Postgres "missing
      // FROM-clause entry", dead prune every tick (live-probe caught it,
      // session 89). The table is unaliased, so quote the raw column.
      await this.repo
        .createQueryBuilder('snap')
        .delete()
        .where('"capturedAt" < :cutoff', { cutoff })
        .execute();
      return 'written';
    } catch (err) {
      this.logger.warn(
        `metrics snapshot persistence failed: ${(err as Error)?.message ?? 'unknown error'}`,
      );
      return 'failed';
    }
  }

  /**
   * The additive `/admin/metrics` extras. Reads the newest row + the row
   * count on every call (indexed, table is retention-bounded by design).
   * Never throws: store errors land in `durability.error`.
   */
  async describe(live: MetricsSnapshot): Promise<{ durability: MetricsDurability; window: MetricsWindowDelta | null }> {
    const durability: MetricsDurability = {
      enabled: this.enabled,
      snapshotIntervalSec: this.snapshotIntervalSec,
      retentionSec: this.retentionSec,
      bootStartedAt: new Date(this.bootStartedAtMs).toISOString(),
      stored: null,
      lastCapturedAt: null,
      bootAligned: null,
      error: false,
    };
    if (!this.enabled) return { durability, window: null };

    try {
      // find({ order, take: 1 }) NOT findOne({ order }): this TypeORM
      // version refuses findOne without selection conditions ("You must
      // provide selection conditions in order to find a single row" —
      // live-smoke-caught, session 89; an order-only findOne would have
      // silently 100% errored the read path).
      const [rows, stored] = await Promise.all([
        this.repo.find({ order: { capturedAt: 'DESC' }, take: 1 }),
        this.repo.count(),
      ]);
      const last = rows[0];
      durability.stored = stored;
      if (!last) return { durability, window: null };
      durability.lastCapturedAt = last.capturedAt.toISOString();
      const aligned = last.bootStartedAt.getTime() === this.bootStartedAtMs;
      durability.bootAligned = aligned;
      if (!aligned || !isSnapshotShape(last.payload)) {
        // Previous-boot row (fresh restart) or operator-corrupted payload:
        // honest null window until THIS boot's first snapshot lands.
        return { durability, window: null };
      }
      return { durability, window: computeWindowDelta(last.payload, live) };
    } catch (err) {
      this.logger.warn(
        `metrics snapshot durability read failed: ${(err as Error)?.message ?? 'unknown error'}`,
      );
      durability.error = true;
      return { durability, window: null };
    }
  }

  /** Convenience for the route: live snapshot + durability merged in. */
  async decorate(live: MetricsSnapshot): Promise<MetricsSnapshot & { durability: MetricsDurability; window: MetricsWindowDelta | null }> {
    const { durability, window } = await this.describe(live);
    return { ...live, durability, window };
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
