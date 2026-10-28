import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Payment } from './payment.entity';
import { User } from '../users/user.entity';

/**
 * The refund AUDIT TRAIL: one append-only row per LANDED refund (Phase 5
 * follow-up "per-refund rows instead of a single accumulated refundedCents").
 * The Payment row keeps its cumulative `refundedCents` as the fast balance
 * check; THIS table is the ledger that explains every cent of it: how much
 * came back, under which provider refund id, and which admin pulled the
 * trigger.
 *
 * Written in the SAME transaction as the compare-and-set update of the
 * payment row — a landed refund without its trail row, or a trail row
 * without the money moving on our side, is never allowed to persist.
 *
 * A DECLINED or ERRORED refund attempt never appears here: the trail records
 * money that actually came back, matching the philosophy of payments rows
 * (history is never rewritten, failures of THIS attempt simply don't exist
 * as audit rows — they live in the error response the admin received).
 *
 * `providerRefundRef` is deliberately NOT unique: it is a snapshot of what
 * the adapter reported, and a schema constraint must never be able to reject
 * the transaction of a refund the provider has already executed. Adapters
 * that omit the ref (it is optional on `RefundResult`) store null.
 */
@Index('IDX_payment_refunds_paymentId_createdAt', ['paymentId', 'createdAt'])
@Check('CHK_payment_refunds_amount_positive', '"amountCents" > 0')
@Entity('payment_refunds')
export class PaymentRefund {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * The payment this refund came out of. CASCADE on delete matches the
   * payments→orders link: no payment rows are deleted in practice, and if
   * the whole money trail of a row is ever purged, its refunds go with it.
   */
  @ManyToOne(() => Payment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'paymentId' })
  payment: Payment;

  @Column()
  paymentId: string;

  /** Gateway adapter that executed the refund ('mock' today). Snapshot, like payment.provider. */
  @Column({ type: 'varchar', length: 16 })
  provider: string;

  /**
   * Provider-side refund id (mock: `mock_re_<paymentId>_<remaining>_<cents>`;
   * Stripe would put `re_…` here). varchar(128): a provider ref is opaque —
   * wider than our own `payments.providerRef` (64) so a future adapter's
   * id format can never overflow the audit column and reject the insert of
   * an already-executed refund. Null when the adapter returned no ref.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  providerRefundRef: string | null;

  /** THIS refund's amount in integer cents (partial refunds = multiple rows). Never client-supplied beyond the admin's validated request. */
  @Column({ type: 'int' })
  amountCents: number;

  /**
   * Payment.refundedCents AFTER this row landed — the running balance that
   * made this row current at write time. Sum of rows == payment.refundedCents
   * is the reconciliation invariant for future audits.
   */
  @Column({ type: 'int' })
  refundedAfterCents: number;

  /**
   * Who issued the refund. SET NULL on user delete so the ledger row — like
   * every money row here — survives account removal; the email snapshot below
   * keeps it attributable regardless.
   */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actingAdminId' })
  actingAdmin: User | null;

  @Column({ type: 'uuid', nullable: true })
  actingAdminId: string | null;

  /**
   * Admin's email SNAPSHOTTED from the verified JWT at refund time — attribution
   * outlives the account itself (deleted user: id goes null, this stays).
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  actingAdminEmail: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
