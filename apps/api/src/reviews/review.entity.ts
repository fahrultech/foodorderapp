import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Order } from '../orders/order.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { User } from '../users/user.entity';

/**
 * One review, written by the customer of ONE completed order (Phase 3).
 * `orderId` is unique — a second review of the same order is a 409, enforced
 * by the DB, not just a pre-check. All three FKs cascade so deleting a user,
 * an order or a restaurant never leaves dangling reviews. `restaurantId` and
 * `userId` are denormalized from the order at insert time: the public
 * restaurant list and "my reviews" query their own column directly instead
 * of joining through orders.
 */
@Entity('reviews')
@Unique('UQ_reviews_orderId', ['orderId'])
export class Review {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  order: Order;

  @Column({ type: 'uuid' })
  orderId: string;

  @Index('IDX_reviews_restaurantId')
  @ManyToOne(() => Restaurant, { onDelete: 'CASCADE' })
  restaurant: Restaurant;

  @Column({ type: 'uuid' })
  restaurantId: string;

  @Index('IDX_reviews_userId')
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  user: User;

  @Column({ type: 'uuid' })
  userId: string;

  /** 1..5 stars. Bounds are enforced by the DTO; the column just stores ints. */
  @Column({ type: 'int' })
  rating: number;

  @Column({ type: 'text', nullable: true })
  comment: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
