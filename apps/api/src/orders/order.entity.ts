import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../users/user.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { OrderItem } from './order-item.entity';

export enum OrderStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  PREPARING = 'preparing',
  DELIVERING = 'delivering',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

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

  @Column({ type: 'int', default: 0 })
  deliveryFeeCents: number;

  @Column({ type: 'int', default: 0 })
  totalCents: number;

  @Column()
  customerName: string;

  @Column()
  contactPhone: string;

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
