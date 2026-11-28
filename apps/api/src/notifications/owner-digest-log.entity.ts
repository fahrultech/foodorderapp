import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Owner-digest delivery ledger (docs/ROADMAP.md Phase 17, Product loop).
 *
 * One row per (owner, digest-date) CLAIMED by the `owner-digest` cron runner.
 * The UNIQUE pair is the exactly-once gate: a second run on the same date
 * finds the row and sends nothing, so a doubled timer tick can never spam
 * owners. `sentAt` NULL means claimed-but-not-yet-sent (a crashed run); the
 * runner treats claims older than DIGEST_CLAIM_STALE_MINUTES as take-over
 * candidates, and deletes its own claim when a send fails so the next tick
 * retries naturally.
 *
 * NOT NULL numeric columns with write-time CHECKs: the runner always knows
 * the aggregates before it claims, and "unknown" stats should never exist
 * (same NOT-NULL doctrine as AddUserNotificationSettings).
 */
@Entity('owner_digest_logs')
@Index('UQ_owner_digest_logs_owner_date', ['ownerId', 'digestDate'], {
  unique: true,
})
export class OwnerDigestLog {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_owner_digest_logs_id' })
  id: string;

  @Column({ type: 'uuid' })
  ownerId: string;

  /** The calendar day (local) the report covers, 'YYYY-MM-DD'. */
  @Column({ type: 'date' })
  digestDate: string;

  @Column({ type: 'int' })
  restaurantCount: number;

  /** Orders CREATED in the window across all owned restaurants (any status). */
  @Column({ type: 'int' })
  orderCount: number;

  /** COMPLETED-order revenue (cents) across all owned restaurants. */
  @Column({ type: 'int' })
  revenueCents: number;

  @Column({ type: 'timestamp with time zone' })
  claimedAt: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  sentAt: Date | null;
}
