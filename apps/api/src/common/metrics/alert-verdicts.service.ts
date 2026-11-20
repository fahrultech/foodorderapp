import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { AlertVerdictRow } from './alert-verdict.entity';
import {
  MetricsPersistenceService,
  resolveSnapshotIntervalSec,
  resolveSnapshotRetentionSec,
} from './metrics-persistence.service';
import { RequestMetricsService } from './request-metrics.service';
import { blankToUndefined, clampToIntRange } from '../int-range';
import { AlertReport } from '../../ops/alerts';

/**
 * Alert-verdict time series (Phase 11 Ops): one `alert_verdicts` row per
 * metrics-snapshot tick, capturing the SAME engine output that
 * `GET /admin/alerts` answers live (verdict, firing rule ids, full report
 * incl. observed/threshold/detail per rule). Reuses the session-89 writer
 * pattern AND its knobs (METRICS_SNAPSHOT_INTERVAL_SEC / _RETENTION_SEC) —
 * "alongside the metrics snapshots" is literal here: one shared durability
 * switch, one shared cadence, one shared prune window. Disabling metrics
 * durability disables verdict persistence with it; there is no second
 * half-on state to reason about.
 *
 * Reads NEVER write (session 98's observer-exemption doctrine): the series
 * is minted by the tick, not by polling, so an admin dashboard or the
 * alert-scan hammering the routes cannot change the history.
 *
 * Failure posture is the session-86 contract again: a persistence error is
 * caught + warned and NEVER throws (a broken smoke detector must not take
 * the metrics heartbeat down with it), and a history read error degrades
 * the payload (`error: true`, empty items) instead of 5xx-ing.
 */

// History window/limit bounds. The window default equals the retention
// default (a full day at the shipped cadence = 288 small rows); the limit
// cap (2000) bounds one response generously even at a 1 s tick interval.
export const MIN_ALERT_HISTORY_WINDOW_SEC = 60;
export const MAX_ALERT_HISTORY_WINDOW_SEC = 30 * 86_400;
export const DEFAULT_ALERT_HISTORY_WINDOW_SEC = 86_400;
export const MIN_ALERT_HISTORY_LIMIT = 1;
export const MAX_ALERT_HISTORY_LIMIT = 2000;
export const DEFAULT_ALERT_HISTORY_LIMIT = 288;

export interface AlertVerdictRecord {
  capturedAt: string;
  status: string;
  firingRules: string[];
  report: AlertReport;
}

export interface AlertStreak {
  /** Run length of consecutive persisted 'alerting' rows, newest-first. */
  persistedTrailingAlerting: number;
  /** True when the trailing run was cut off by the limit (a LOWER BOUND). */
  trailingCapped: boolean;
  /** The LIVE engine verdict at read time (same evaluation as GET /admin/alerts). */
  currentStatus: string;
  /**
   * Consecutive alerting evaluations INCLUDING this read's live verdict:
   * the persisted trailing run + 1 (the live poll is always a fresh
   * evaluation strictly after the newest tick), or 0 when the live verdict
   * is ok. The alert-scan escalation gate works on this number.
   */
  alerting: number;
}

export interface AlertHistoryView {
  generatedAt: string;
  /** Durability writer state (shared METRICS_SNAPSHOT_INTERVAL_SEC knob). */
  enabled: boolean;
  snapshotIntervalSec: number;
  retentionSec: number;
  window: { windowSec: number; from: string; to: string };
  returned: number;
  /** True when the window holds more rows than `limit` allowed through. */
  truncated: boolean;
  /** Newest persisted verdict row (null = writer off / no rows / read error). */
  lastCapturedAt: string | null;
  /** The series read FAILED (table missing / DB down) — honesty flag. */
  error: boolean;
  items: AlertVerdictRecord[];
  streak: AlertStreak;
}

@Injectable()
export class AlertVerdictsService implements OnModuleDestroy {
  readonly snapshotIntervalSec: number;
  readonly retentionSec: number;
  private readonly logger = new Logger(AlertVerdictsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    config: ConfigService,
    private readonly metrics: RequestMetricsService,
    private readonly persistence: MetricsPersistenceService,
    @InjectRepository(AlertVerdictRow)
    private readonly repo: Repository<AlertVerdictRow>,
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
      // Never keep the event loop alive for a durability heartbeat.
      this.timer.unref();
    }
  }

  get enabled(): boolean {
    return this.snapshotIntervalSec > 0;
  }

  /**
   * One scheduler tick: evaluate the rule engine over the LIVE snapshot
   * (with the DB-backed freshness observation, exactly like the
   * GET /admin/alerts route does) and append the verdict row. The fresh
   * `metrics_snapshots` write of the sibling tick makes snapshot_stale
   * read age ~0 here, so a healthy chain records `ok` honestly while a
   * dead metrics writer records its own firing in the series. ANY error is
   * caught + warned; the tick never throws.
   */
  async persistNow(): Promise<'written' | 'failed' | 'disabled'> {
    if (!this.enabled) return 'disabled';
    try {
      const capturedAt = new Date();
      const report = this.metrics.alerts(await this.persistence.freshnessInput());
      await this.repo.save(
        this.repo.create({
          capturedAt,
          status: report.status,
          firingRules: report.firingRules,
          report,
        }),
      );
      const cutoff = new Date(capturedAt.getTime() - this.retentionSec * 1000);
      // NB: the RAW quoted column, never 'verdict.capturedAt' — this
      // TypeORM version's DeleteQueryBuilder keeps the alias in WHERE while
      // dropping it from FROM (Postgres 42P01, live-probe caught it in
      // session 89 for the sibling table).
      await this.repo
        .createQueryBuilder('verdict')
        .delete()
        .where('"capturedAt" < :cutoff', { cutoff })
        .execute();
      return 'written';
    } catch (err) {
      this.logger.warn(
        `alert verdict persistence failed: ${(err as Error)?.message ?? 'unknown error'}`,
      );
      return 'failed';
    }
  }

  /**
   * Windowed history read (GET /admin/alerts/history). Params go through
   * the shared closed-range clamp (the DTO validates the wire shape; this
   * guards direct callers too). Items are returned OLDEST-FIRST so a
   * consumer can chart the series directly. Never throws: a store read
   * failure lands as `error: true` with an empty item list, while the
   * streak's live half still reports honestly (the engine itself is
   * in-process).
   */
  async history(query: { windowSec?: number; limit?: number } = {}): Promise<AlertHistoryView> {
    const windowSec = clampToIntRange(
      blankToUndefined(query.windowSec),
      MIN_ALERT_HISTORY_WINDOW_SEC,
      MAX_ALERT_HISTORY_WINDOW_SEC,
      DEFAULT_ALERT_HISTORY_WINDOW_SEC,
    );
    const limit = clampToIntRange(
      blankToUndefined(query.limit),
      MIN_ALERT_HISTORY_LIMIT,
      MAX_ALERT_HISTORY_LIMIT,
      DEFAULT_ALERT_HISTORY_LIMIT,
    );
    const to = new Date();
    const from = new Date(to.getTime() - windowSec * 1000);

    const view: AlertHistoryView = {
      generatedAt: to.toISOString(),
      enabled: this.enabled,
      snapshotIntervalSec: this.snapshotIntervalSec,
      retentionSec: this.retentionSec,
      window: { windowSec, from: from.toISOString(), to: to.toISOString() },
      returned: 0,
      truncated: false,
      lastCapturedAt: null,
      error: false,
      items: [],
      streak: {
        persistedTrailingAlerting: 0,
        trailingCapped: false,
        currentStatus: 'ok',
        alerting: 0,
      },
    };

    // The live verdict rides the SAME engine + freshness observation as
    // GET /admin/alerts — one implementation, every consumer agrees.
    const live = this.metrics.alerts(await this.persistence.freshnessInput());
    view.streak.currentStatus = live.status;

    if (!this.enabled) {
      // Durability is opted out: the live evaluation is all we can honestly
      // claim (a firing verdict is streak 1 by itself, no persisted tail).
      view.streak.alerting = live.status === 'alerting' ? 1 : 0;
      return view;
    }

    let rows: AlertVerdictRow[] = [];
    try {
      // find({ where, order, take }) — never order-only findOne (session 89).
      rows = await this.repo.find({
        where: { capturedAt: MoreThanOrEqual(from) },
        order: { capturedAt: 'DESC' },
        take: limit,
      });
    } catch (err) {
      this.logger.warn(
        `alert verdict history read failed: ${(err as Error)?.message ?? 'unknown error'}`,
      );
      view.error = true;
      view.streak.alerting = live.status === 'alerting' ? 1 : 0;
      return view;
    }

    let trailing = 0;
    for (const row of rows) {
      if (row.status === 'alerting') trailing += 1;
      else break;
    }
    view.returned = rows.length;
    view.truncated = rows.length === limit;
    view.lastCapturedAt = rows.length > 0 ? rows[0].capturedAt.toISOString() : null;
    view.items = rows
      .map((row) => ({
        capturedAt: row.capturedAt.toISOString(),
        status: row.status,
        firingRules: row.firingRules,
        report: row.report,
      }))
      .reverse();
    view.streak.persistedTrailingAlerting = trailing;
    // The run may continue BEFORE the window/limit start — then it is a
    // lower bound, reported honestly instead of a false exact count.
    view.streak.trailingCapped = trailing === rows.length && rows.length === limit;
    view.streak.alerting = live.status === 'alerting' ? trailing + 1 : 0;
    return view;
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
