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
import { Restaurant } from '../restaurants/restaurant.entity';
import { MenuOptionGroup } from './menu-option-group.entity';

@Index('IDX_menu_items_restaurantId', ['restaurantId'])
@Entity('menu_items')
export class MenuItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'int' })
  priceCents: number;

  @Column({ nullable: true })
  category: string;

  @Column({ nullable: true })
  imageUrl: string;

  @Column({ default: true })
  isAvailable: boolean;

  @Column({ type: 'int', default: 15 })
  prepMinutes: number;

  @ManyToOne(() => Restaurant, (restaurant) => restaurant.menuItems, {
    onDelete: 'CASCADE',
  })
  restaurant: Restaurant;

  @Column()
  restaurantId: string;

  /**
   * Option groups (size/spice/extras, Phase 5). Loaded explicitly on the
   * public menu read via a second IN-query (see MenuService.findByRestaurant)
   * — never blindly cascaded, so owner mutation responses stay slim.
   */
  @OneToMany(() => MenuOptionGroup, (group) => group.menuItem)
  optionGroups: MenuOptionGroup[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
