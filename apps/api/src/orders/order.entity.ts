import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../users/user.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { OrderItem } from './order-item.entity';
import { StockDecrementEntry } from './stock-restock';

export enum OrderStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  PREPARING = 'preparing',
  DELIVERING = 'delivering',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

/**
 * Query-shape indexes (roadmap Phase 4, session 32):
 * - (userId, createdAt)         — /orders/my: WHERE userId ORDER BY createdAt DESC
 * - (restaurantId, createdAt)   — portal inbox: WHERE restaurantId ORDER BY createdAt DESC
 * - (restaurantId, status)      — portal inbox per-status tab counts
 * restaurants.slug needs no new index: its UNIQUE constraint already ships a
 * btree index (verified via pg_constraint, DEVLOG session 32).
 */
@Index('IDX_orders_userId_createdAt', ['userId', 'createdAt'])
@Index('IDX_orders_restaurantId_createdAt', ['restaurantId', 'createdAt'])
@Index('IDX_orders_restaurantId_status', ['restaurantId', 'status'])
@Index('IDX_orders_driverId', ['driverId'])
@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Short human-readable code, e.g. #FO-8F3K */
  @Column({ unique: true })
  code: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  user: User;

  @Column({ nullable: true })
  userId: string;

  @ManyToOne(() => Restaurant, { onDelete: 'CASCADE' })
  restaurant: Restaurant;

  @Column()
  restaurantId: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'driverId',
    foreignKeyConstraintName: 'FK_orders_driverId_users_id',
  })
  driver: User | null;

  @Column({ nullable: true })
  driverId: string | null;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status: OrderStatus;

  /**
   * Status-step timestamps for the customer tracking timeline (Phase 3).
   * Set once, when the order first enters that step — never overwritten, so
   * a cancelled-then-replayed transition can't corrupt the history. The
   * `pending` step is `createdAt`; these cover the rest of STATUS_FLOW.
   */
  @Column({ type: 'timestamp', nullable: true })
  confirmedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  preparingAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  deliveringAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'int', default: 0 })
  subtotalCents: number;

  /**
   * Promo discount actually applied at order creation, integer cents, always
   * relative to subtotalCents (never the delivery fee). 0 when no promo was
   * used. The code itself is stored as a TEXT snapshot, not an FK: promos may
   * later be renamed/removed, but the receipt must keep what was really applied.
   */
  @Column({ type: 'int', default: 0 })
  discountCents: number;

  /** Normalized (uppercase) promo code snapshot; null when no promo applied. */
  @Column({ type: 'varchar', length: 24, nullable: true })
  promoCode: string | null;

  /**
   * Stock ledger snapshot (restock-on-cancel): the units this order ACTUALLY
   * decremented at creation — [{ menuItemId, quantity }, ...] aggregated per
   * dish, written inside the create transaction. NULL = this order decremented
   * nothing (all lines unlimited, or a legacy row from before the stock column
   * existed), so cancelling it must return nothing. The DB CHECK pins the
   * shape to a jsonb array.
   */
  @Column({ type: 'jsonb', nullable: true })
  stockDecrements: StockDecrementEntry[] | null;

  /**
   * Exactly-once restock marker. Flipped NULL -> timestamp by the CAS inside
   * `restockCancelledOrder`; a second concurrent cancel sees it and skips.
   */
  @Column({ type: 'timestamp', nullable: true })
  stockRestockedAt: Date | null;

  @Column({ type: 'int', default: 0 })
  deliveryFeeCents: number;

  @Column({ type: 'int', default: 0 })
  totalCents: number;

  @Column()
  customerName: string;

  @Column()
  contactPhone: string;

  /**
   * Normalized (trimmed+lowercased) contact email collected at checkout —
   * the GUEST RECEIPT PROOF. `GET /orders/:id` unlocks for a bearer-less
   * viewer only when they present this exact value (owner token and ADMIN
   * bypass it). NULL on legacy rows and API orders that omitted the field:
   * such orders have no guest-view path, by design (no existence oracle).
   */
  @Column({ type: 'varchar', length: 254, nullable: true })
  contactEmail: string | null;

  @Column({ type: 'text' })
  deliveryAddress: string;

  @Column({ type: 'text', nullable: true })
  note: string;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true, eager: true })
  items: OrderItem[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
