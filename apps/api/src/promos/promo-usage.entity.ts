import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { PromoCode } from './promo-code.entity';
import { Order } from '../orders/order.entity';
import { User } from '../users/user.entity';

/**
 * Append-only redemption ledger (Phase 5 "Coupons expiry + usage caps").
 * One row per order that ACTUALLY consumed a promo's discount — the caps on
 * `promo_codes` are evaluated by counting THIS table, never a mutable
 * counter that can drift. `orderId` is unique: one order redeems at most one
 * code exactly once.
 *
 * Retention semantics:
 *  - promo deleted → its history goes with it (CASCADE; counts are only
 *    meaningful per code).
 *  - order deleted → the redemption never happened either (CASCADE).
 *  - user deleted (GDPR erasure) → the row STAYS with a null `userId`:
 *    total-cap arithmetic is not personal data and must keep counting after
 *    an erasure; only the per-user link is forgotten.
 *
 * `discountCents` snapshots the exact amount granted, so operators can
 * reconstruct savings per code without joining the order rows.
 */
@Entity('promo_usages')
@Index('IDX_promo_usages_promoId', ['promoId'])
@Index('IDX_promo_usages_promoId_userId', ['promoId', 'userId'])
@Index('UQ_promo_usages_orderId', ['orderId'], { unique: true })
export class PromoUsage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => PromoCode, { onDelete: 'CASCADE' })
  promo: PromoCode;

  @Column({ type: 'uuid' })
  promoId: string;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  order: Order;

  @Column({ type: 'uuid' })
  orderId: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  user: User | null;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  /** Integer cents of discount actually granted by this redemption. */
  @Column({ type: 'int' })
  discountCents: number;

  @CreateDateColumn()
  createdAt: Date;
}
