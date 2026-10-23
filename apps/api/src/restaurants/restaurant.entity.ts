import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MenuItem } from '../menu/menu-item.entity';
import { User } from '../users/user.entity';

@Entity('restaurants')
export class Restaurant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Owner (restaurants.ownerId); null for platform-seeded restaurants. */
  @Index('IDX_restaurants_ownerId')
  @Column({ type: 'uuid', nullable: true })
  ownerId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  owner: User;

  @Column({ unique: true })
  slug: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ nullable: true })
  cuisine: string;

  @Column({ nullable: true })
  city: string;

  @Column({ nullable: true })
  address: string;

  @Column({ nullable: true })
  imageUrl: string;

  /**
   * Display rating: the seed/curated value until the FIRST review lands, then
   * the recomputed average of `reviews.rating` (2 decimals) — the ONLY writer
   * is `ReviewsService.recomputeRating`, never a client. `ratingCount === 0`
   * means "no reviews yet" (UI shows this as the platform-level score).
   */
  @Column({ type: 'float', default: 4.5 })
  rating: number;

  /** How many reviews currently feed `rating`. Recomputed on every review write. */
  @Column({ type: 'int', default: 0 })
  ratingCount: number;

  @Column({ type: 'int', default: 0 })
  deliveryFeeCents: number;

  @Column({ type: 'int', default: 0 })
  minOrderCents: number;

  @Column({ type: 'int', default: 30 })
  avgPrepMinutes: number;

  @Column({ default: true })
  isOpen: boolean;

  @OneToMany(() => MenuItem, (item) => item.restaurant)
  menuItems: MenuItem[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
