import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Order } from '../orders/order.entity';
import { User } from '../users/user.entity';

/**
 * Payment lifecycle owned by the PAYMENT side only — deliberately NOT mixed
 * with OrderStatus. The order machine stays what it is; gating order
 * confirmation on a succeeded payment is a follow-up (docs/ROADMAP.md).
 *   pending   — row created, gateway intent in flight or created, not captured
 *   succeeded — gateway captured it; money "moved" (mock: simulated). May
 *               carry a partial refund (refundedCents > 0) and stay here
 *               while money is still refundable underneath the row.
 *   failed    — intent or capture was rejected / errored; terminal for THIS row,
 *               a retry means a NEW payment row (see PaymentsService.pay)
 *   refunded  — the FULL captured amount came back (refundedCents ===
 *               amountCents); terminal. A refund is never a new row — the
 *               money trail stays on the row that moved it.
 */
export enum PaymentStatus {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  REFUNDED = 'refunded',
}

/**
 * One payment attempt against one order. Amounts are integer cents snapshots
 * of order.totalCents taken at intent creation — never client input, so a
 * receipt cannot disagree with what was actually charged. Refunds accumulate
 * on the SAME row (`refundedCents`): partial → status stays succeeded,
 * full → status becomes refunded.
 */
@Index('IDX_payments_orderId_createdAt', ['orderId', 'createdAt'])
@Check(
  'CHK_payments_refund_bounds',
  '"refundedCents" >= 0 AND "refundedCents" <= "amountCents"',
)
@Entity('payments')
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'orderId' })
  order: Order;

  @Column()
  orderId: string;

  /**
   * Who paid. Always an authenticated actor (guest orders may be paid by any
   * signed-in payer — the receipt-link path). Nullable only so deleting the
   * user cannot erase the money trail (SET NULL); the audit row survives.
   */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ nullable: true })
  userId: string;

  /** Gateway adapter that handled this payment ('mock' today; 'stripe'/'xendit' later). */
  @Column({ type: 'varchar', length: 16 })
  provider: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  status: PaymentStatus;

  /** Server-copied snapshot of order.totalCents at intent creation. Integer cents. */
  @Column({ type: 'int' })
  amountCents: number;

  /** ISO 4217 code; single-currency deployment today (IDR). */
  @Column({ type: 'varchar', length: 3, default: 'IDR' })
  currency: string;

  /**
   * Provider-side id (mock: `mock_pi_<paymentId>`). Null ONLY on rows whose
   * gateway intent creation itself failed — no provider ref exists then.
   * Unique where present: refs are globally unique, and re-attaching one row
   * to another order's intent is exactly the bug a constraint prevents.
   */
  @Column({ type: 'varchar', length: 64, nullable: true, unique: true })
  providerRef: string | null;

  @Column({ type: 'text', nullable: true })
  failureReason: string | null;

  /** Set once, when the payment first succeeded. Write-once like order timestamps. */
  @Column({ type: 'timestamp', nullable: true })
  succeededAt: Date | null;

  /**
   * Cumulative cents refunded against this row (integer cents, always
   * 0 <= refundedCents <= amountCents, enforced by the service + a CHECK in
   * the migration). Partial refunds accumulate here; the status flips to
   * `refunded` only when this reaches `amountCents`.
   */
  @Column({ type: 'int', default: 0 })
  refundedCents: number;

  /** When the most recent refund landed (null while nothing was refunded). */
  @Column({ type: 'timestamp', nullable: true })
  refundedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
