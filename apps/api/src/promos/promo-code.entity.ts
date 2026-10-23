import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Restaurant } from '../restaurants/restaurant.entity';

export enum PromoDiscountType {
  PERCENT = 'percent',
  FIXED = 'fixed',
}

/**
 * A discount promo code (Phase 3). Two shapes:
 *  - `percent`: valueCents is a 1..100 percentage of the cart SUBTOTAL,
 *    optionally capped by `maxDiscountCents` (so 90% off a huge cart still
 *    costs the platform a bounded amount).
 *  - `fixed`: valueCents is a flat amount off the subtotal, clamped to the
 *    subtotal itself — a discount never goes below zero and never eats the
 *    delivery fee.
 *
 * Scope & gates (all server-side, never client trust):
 *  - `restaurantId` null = platform-wide; set = only orders at that restaurant.
 *  - `minSubtotalCents` is checked against the SERVER-computed subtotal
 *    BEFORE the discount (and the restaurant's own min-order check runs on
 *    the same pre-discount subtotal — a promo can't bypass a minimum).
 *  - `isActive` false = rejects even if everything else matches (kill switch).
 *
 * Expiry dates and usage caps are deliberately OUT of scope here — they are
 * the separate Phase 5 roadmap item ("Coupons expiry + usage caps") and need
 * a usage-ledger table, not just columns on this row.
 */
@Entity('promo_codes')
export class PromoCode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Stored normalized (uppercase, trimmed). Lookup normalizes the input. */
  @Index('UQ_promo_codes_code', { unique: true })
  @Column({ length: 24 })
  code: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'enum', enum: PromoDiscountType })
  discountType: PromoDiscountType;

  /** percent: 1..100 of subtotal · fixed: cents off. Money = integer cents. */
  @Column({ type: 'int' })
  valueCents: number;

  /** Only meaningful for PERCENT discounts; null = no cap. */
  @Column({ type: 'int', nullable: true })
  maxDiscountCents: number | null;

  /** Cart subtotal (pre-discount, server-computed) required to qualify. */
  @Column({ type: 'int', default: 0 })
  minSubtotalCents: number;

  /** null = platform-wide; set = single-restaurant promo. */
  @ManyToOne(() => Restaurant, { onDelete: 'CASCADE', nullable: true })
  restaurant: Restaurant | null;

  @Index('IDX_promo_codes_restaurantId')
  @Column({ type: 'uuid', nullable: true })
  restaurantId: string | null;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
