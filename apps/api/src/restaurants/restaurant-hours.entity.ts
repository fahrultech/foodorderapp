import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Restaurant } from './restaurant.entity';

/**
 * One weekly open-hours window (Phase 5 "Restaurant open hours").
 * Row shape mirrors the migration's CHECK domains EXACTLY:
 *  - dayOfWeek 0..6 (JS convention, 0 = Sunday)
 *  - opensAt / closesAt "HH:MM" 24h; window is [opensAt, closesAt) and
 *    closesAt <= opensAt means the window wraps past midnight.
 * ABSENCE of a day's row = the restaurant is closed that weekday.
 * A restaurant with NO rows at all falls back to the manual `isOpen` column.
 */
@Entity('restaurant_hours')
@Unique('UQ_restaurant_hours_restaurant_day', ['restaurantId', 'dayOfWeek'])
export class RestaurantHours {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  restaurantId: string;

  @ManyToOne(() => Restaurant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'restaurantId' })
  restaurant: Restaurant;

  @Column({ type: 'int' })
  dayOfWeek: number;

  @Column({ length: 5 })
  opensAt: string;

  @Column({ length: 5 })
  closesAt: string;
}
