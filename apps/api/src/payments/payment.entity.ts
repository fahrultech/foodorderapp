import {
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
 *   succeeded — gateway captured it; money "moved" (mock: simulated)
 *   failed    — intent or capture was rejected / errored; terminal for THIS row,
 *               a retry means a NEW payment row (see PaymentsService.pay)
 */
export enum PaymentStatus {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

/**
 * One payment attempt against one order. Amounts are integer cents snapshots
 * of order.totalCents taken at intent creation — never client input, so a
 * receipt cannot disagree with what was actually charged. A refunded payment
 * is not modelled yet (refund flow is a roadmap follow-up).
 */
@Index('IDX_payments_orderId_createdAt', ['orderId', 'createdAt'])
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

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
