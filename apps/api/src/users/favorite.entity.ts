import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from './user.entity';
import { MenuItem } from '../menu/menu-item.entity';

/**
 * One "heart" a customer put on one dish. The composite unique keeps a dish
 * from being favorited twice; both FKs cascade, so deleting a user or a dish
 * cleans the row up automatically (owner menu deletes must not leave
 * dangling hearts).
 */
@Entity('user_favorites')
@Unique('UQ_user_favorites_userId_menuItemId', ['userId', 'menuItemId'])
export class Favorite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  user: User;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => MenuItem, { onDelete: 'CASCADE' })
  menuItem: MenuItem;

  @Column({ type: 'uuid' })
  menuItemId: string;

  @CreateDateColumn()
  createdAt: Date;
}
