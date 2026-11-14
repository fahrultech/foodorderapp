import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MetricsSnapshot } from './request-metrics';

/**
 * Durability row for the in-process metrics registry (Phase 8): the registry
 * is cumulative-since-boot, so every restart silently zeroes the error
 * budget. A scheduler writes periodic copies of the FULL snapshot here, and
 * `GET /admin/metrics` computes window deltas from the newest row — history
 * survives restarts, and the boot stamp makes cross-boot subtraction
 * impossible (the window honestly reports `null` until the new boot's first
 * snapshot lands).
 */
@Entity('metrics_snapshots')
@Index('IDX_metrics_snapshots_capturedAt', ['capturedAt'])
export class MetricsSnapshotRow {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_metrics_snapshots_id' })
  id: string;

  /** When the payload was captured — drives window baselines + retention pruning. */
  @Column({ type: 'timestamptz' })
  capturedAt: Date;

  /**
   * Timestamp of the registry that produced the payload (process boot).
   * A row whose stamp differs from the LIVE registry's boot belongs to a
   * previous process and can NEVER be subtracted from it.
   */
  @Column({ type: 'timestamptz' })
  bootStartedAt: Date;

  /** The full MetricsSnapshot — same shape GET /admin/metrics has always returned. */
  @Column({ type: 'jsonb' })
  payload: MetricsSnapshot;
}
