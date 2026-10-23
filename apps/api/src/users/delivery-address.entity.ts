import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * One saved delivery address in a customer's address book (Phase 3).
 * Rows belong to exactly one user (FK cascades on user deletion — the book
 * must never outlive its owner) and the address itself is stored as a TEXT
 * snapshot, not a live pointer: `orders` copies from it at create time, so
 * editing the book later never rewrites where past food was delivered.
 *
 * Invariant the service maintains: while a user has at least one address,
 * exactly one of them has `isDefault = true` (first address forced default;
 * deleting the default promotes the oldest survivor; promoting one demotes
 * the rest). Checkout pre-selects the default row from this guarantee.
 */
@Entity('delivery_addresses')
@Index('IDX_delivery_addresses_userId', ['userId'])
export class DeliveryAddress {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  user: User;

  @Column({ type: 'uuid' })
  userId: string;

  /** Short memory-hook label ("Home", "Office") — shown in the picker. */
  @Column({ type: 'varchar', length: 40 })
  label: string;

  /** Who physically receives the delivery; copied onto the order. */
  @Column({ type: 'varchar', length: 120 })
  recipientName: string;

  /** Contact number for THIS address (differs from the profile phone). */
  @Column({ type: 'varchar', length: 32 })
  phone: string;

  /** Free-form street/city/landmarks text — same shape as order.deliveryAddress. */
  @Column({ type: 'text' })
  address: string;

  @Column({ type: 'boolean', default: false })
  isDefault: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
