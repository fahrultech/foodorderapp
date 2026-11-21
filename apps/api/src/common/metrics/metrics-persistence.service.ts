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
  STATUS_CLASSES,
} from './metrics-window';
import { MetricsSnapshot, PersistedMetricsSnapshot, RestaurantTrafficSnapshot } from './request-metrics';
import { RequestMetricsService } from './request-metrics.service';
import { SnapshotFreshnessInput } from '../../ops/alerts';

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
 * The OWNER-rung durability block (session-116 per-restaurant durability).
 * DELIBERATELY NOT the admin `MetricsDurability`: it carries NO global
 * traffic fields and NO global row count (`stored`) — the session-85 rule
 * that global telemetry is ADMIN-only extends to global-scale metadata.
 * Everything here is either shared boot/infrastructure config or derived
 * exclusively from THIS restaurant's bucket. The window delta lives nested
 * under `window` because the top-level `window: 'since_api_boot'` marker
 * of the restaurant view is taken (the additive-only contract: session
 * 98/99 e2e pins keep that string byte-identical).
 */
export interface RestaurantMetricsDurability {
  /** False when METRICS_SNAPSHOT_INTERVAL_SEC=0 — nothing written, nothing read. */
  enabled: boolean;
  snapshotIntervalSec: number;
  retentionSec: number;
  /** ISO timestamp of the LIVE registry boot — rows stamped differently can never form a window. */
  bootStartedAt: string;
  /** capturedAt of the newest stored row; null when none / disabled / store error. */
  lastCapturedAt: string | null;
  /** True = the newest row was written by THIS boot. False = it predates this boot. null = no rows / disabled / error. */
  bootAligned: boolean | null;
  /** False = the baseline row predates restaurant-dimension persistence (window stays null). */
  restaurantsPersisted: boolean;
  /** True = THIS restaurant's bucket was minted AFTER the baseline row: the window's bottom is a zero baseline anchored at the row's capture instant, so it honestly covers every sample the bucket ever took. */
  mintedAfterBaseline: boolean;
  /** The snapshot store could not be read on this call — the route STILL 200s with the live bucket (a dead smoke detector never 5xxs). */
  error: boolean;
  /** Window delta over this restaurant's bucket since the newest same-boot snapshot row; null when not computable. */
  window: MetricsWindowDelta | null;
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
      // Session-116: the restaurant dimension rides the SAME row, so a
      // restart preserves BOTH views from one capture instant — the global
      // window and any restaurant window always share one baseline timestamp.
      const payload: PersistedMetricsSnapshot = {
        ...this.metrics.snapshot(),
        restaurants: this.metrics.restaurantEntries(),
      };
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

  /**
   * The additive OWNER-rung extras for GET /restaurants/:id/metrics
   * (session-116). Same baseline selection + boot-alignment doctrine as
   * describe(), but subtraction happens STRICTLY inside the requested
   * bucket: the stored per-restaurant entry vs the live restaurant
   * snapshot. Honesty ladder:
   *  - disabled / no rows            -> window null (markers tell which);
   *  - newest row from a previous boot -> window null until THIS boot's
   *    first row lands (a restart can never inherit a false baseline);
   *  - row predates restaurant persistence (`restaurants` key absent or
   *    not an object) -> restaurantsPersisted=false, window null;
   *  - row has the map but NO entry for this id -> the bucket was minted
   *    AFTER that capture (every minted bucket rides every later row), so
   *    the window bottom is an honest zero baseline at the row instant —
   *    mintedAfterBaseline=true, never a silently-clamped subtraction;
   *  - stored entry shape-invalid (operator edited jsonb) -> window null;
   *  - ANY store read failure -> error=true, window null; the route still
   *    answers 200 with the live bucket.
   * NEVER throws.
   */
  async describeRestaurant(
    restaurantId: string,
    live: RestaurantTrafficSnapshot,
  ): Promise<RestaurantMetricsDurability> {
    const durability: RestaurantMetricsDurability = {
      enabled: this.enabled,
      snapshotIntervalSec: this.snapshotIntervalSec,
      retentionSec: this.retentionSec,
      bootStartedAt: new Date(this.bootStartedAtMs).toISOString(),
      lastCapturedAt: null,
      bootAligned: null,
      restaurantsPersisted: false,
      mintedAfterBaseline: false,
      error: false,
      window: null,
    };
    if (!this.enabled) return durability;

    try {
      // find({ order, take: 1 }) NOT findOne({ order }) — session 89 pin.
      const [row] = await this.repo.find({ order: { capturedAt: 'DESC' }, take: 1 });
      if (!row) return durability;
      durability.lastCapturedAt = row.capturedAt.toISOString();
      const aligned = row.bootStartedAt.getTime() === this.bootStartedAtMs;
      durability.bootAligned = aligned;
      if (!aligned || !isSnapshotShape(row.payload)) return durability;

      const restaurants = (row.payload as PersistedMetricsSnapshot).restaurants;
      if (!restaurants || typeof restaurants !== 'object' || Array.isArray(restaurants)) {
        return durability; // pre-session-116 row: honest null, never a zero-clamp
      }
      durability.restaurantsPersisted = true;

      const entry = restaurants[restaurantId.toLowerCase()] as unknown;
      if (entry === undefined) {
        durability.mintedAfterBaseline = true;
        const zeroByStatus = {} as Record<(typeof STATUS_CLASSES)[number], number>;
        for (const cls of STATUS_CLASSES) zeroByStatus[cls] = 0;
        // A persisted row ALWAYS carries every minted bucket, so absence
        // PROVES the bucket minted after this row's capture instant: the
        // entire bucket history falls inside the window. Zero baseline is
        // anchored at the ROW's generatedAt, so spanSec stays honest.
        durability.window = computeWindowDelta(
          {
            generatedAt: row.payload.generatedAt,
            boundsMs: live.boundsMs,
            totals: { requests: 0, byStatus: zeroByStatus },
            routes: [],
          },
          live,
        );
        return durability;
      }
      if (!isSnapshotShape(entry)) return durability; // operator-corrupted entry
      durability.window = computeWindowDelta(entry, live);
      return durability;
    } catch (err) {
      this.logger.warn(
        `restaurant metrics durability read failed: ${(err as Error)?.message ?? 'unknown error'}`,
      );
      durability.error = true;
      durability.window = null;
      return durability;
    }
  }

  /**
   * The DB-backed observation for the `snapshot_stale` alert rule
   * (session 109). ONE indexed read (the same newest-row idiom as
   * describe()). Never throws: a store read failure lands as
   * `lastCapturedAtMs: null + storeError: true` — an UNREADABLE durability
   * store is exactly what the rule exists to catch (a dead writer looks
   * identical from the age side), and the evaluator reports it honestly as
   * "unreadable", not as a fabricated "no rows".
   */
  async freshnessInput(): Promise<SnapshotFreshnessInput> {
    const base: SnapshotFreshnessInput = {
      enabled: this.enabled,
      intervalSec: this.snapshotIntervalSec,
      lastCapturedAtMs: null,
    };
    if (!this.enabled) return base;
    try {
      // find+take:1, never order-only findOne (session 89 TypeORM refusal).
      const [row] = await this.repo.find({ order: { capturedAt: 'DESC' }, take: 1 });
      return { ...base, lastCapturedAtMs: row ? row.capturedAt.getTime() : null };
    } catch (err) {
      this.logger.warn(
        `metrics snapshot freshness read failed: ${(err as Error)?.message ?? 'unknown error'}`,
      );
      return { ...base, storeError: true };
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
