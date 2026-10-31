import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Restaurant } from '../restaurants/restaurant.entity';

@Entity('cities')
export class City {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true, length: 80 })
  slug: string;

  @Column({ unique: true, length: 120 })
  name: string;

  @Column({ default: true })
  isActive: boolean;

  @OneToMany(() => Restaurant, (restaurant) => restaurant.cityEntity)
  restaurants: Restaurant[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
