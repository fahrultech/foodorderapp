import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MenuItem } from '../menu/menu-item.entity';

@Entity('restaurants')
export class Restaurant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

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

  @Column({ type: 'float', default: 4.5 })
  rating: number;

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
