import {
  Column,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order } from './order.entity';
import { MenuItem } from '../menu/menu-item.entity';

@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  order: Order;

  @Column()
  orderId: string;

  @ManyToOne(() => MenuItem, { nullable: true, onDelete: 'SET NULL' })
  menuItem: MenuItem;

  @Column({ nullable: true })
  menuItemId: string;

  /** Snapshot fields so the order stays readable even if the menu changes */
  @Column()
  name: string;

  @Column({ type: 'int' })
  quantity: number;

  @Column({ type: 'int' })
  unitPriceCents: number;
}
