import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { AlertReport, AlertRuleId, AlertStatus } from '../../ops/alerts';

/**
 * Alert-verdict time series (docs/ROADMAP.md Phase 11, Ops loop): the
 * `ops/alerts` engine used to answer only the LIVE moment — after a restart
 * or a quiet log window there was no way to tell WHEN a rule started firing,
 * whether an alert is new or chronic, or how many consecutive evaluations
 * paged. The metrics registry got exactly this treatment in session 89
 * (`metrics_snapshots`); verdicts now ride alongside it: one small row per
 * snapshot tick, written by AlertVerdictsService on the SAME cadence and
 * retention knobs (METRICS_SNAPSHOT_INTERVAL_SEC / _RETENTION_SEC).
 *
 * `status` + `firingRules` are redundant with `report` ON PURPOSE: the
 * CHECK-constrained status column keeps the domain honest at the storage
 * layer (a row that is neither 'ok' nor 'alerting' cannot exist) and lets
 * the history reader compute the trailing alerting streak without touching
 * the jsonb payloads at all.
 */
@Entity('alert_verdicts')
@Index('IDX_alert_verdicts_capturedAt', ['capturedAt'])
export class AlertVerdictRow {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_alert_verdicts_id' })
  id: string;

  /** When the evaluation was captured — drives window reads + retention prune. */
  @Column({ type: 'timestamptz' })
  capturedAt: Date;

  /** Mirrors AlertStatus in src/ops/alerts.ts; the migration carries the CHECK. */
  @Column({ type: 'varchar', length: 16 })
  status: AlertStatus;

  /** Ids of the firing rules — empty array when status is 'ok'. */
  @Column({ type: 'jsonb' })
  firingRules: AlertRuleId[];

  /** The FULL AlertReport the engine returned — same shape GET /admin/alerts has. */
  @Column({ type: 'jsonb' })
  report: AlertReport;
}
