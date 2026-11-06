import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order } from './order.entity';
import { MenuItem } from '../menu/menu-item.entity';
import { OrderOptionSnapshot } from '../menu/order-option-snapshot';

@Index('IDX_order_items_orderId', ['orderId'])
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

  /**
   * Menu-option receipt (Phase 5): [{ groupId, groupName, choiceId,
   * choiceName, priceDeltaCents }] frozen at order time — same snapshot
   * philosophy as `name`/`unitPriceCents`: later menu edits never rewrite
   * history. null for every pre-options row AND for lines with no picks.
   * The deltas are already folded into `unitPriceCents` server-side.
   */
  @Column({ type: 'jsonb', nullable: true })
  optionSelections: OrderOptionSnapshot[] | null;
}
