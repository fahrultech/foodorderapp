import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { User, UserRole } from '../users/user.entity';

export enum OrderStatusAuditSource {
  OWNER = 'owner',
  ADMIN = 'admin',
  DRIVER = 'driver',
  CUSTOMER = 'customer',
  STALE_SWEEP = 'stale_sweep',
}

@Check('CHK_order_status_audits_from_status', `"fromStatus" IN ('pending','confirmed','preparing','delivering','completed','cancelled')`)
@Check('CHK_order_status_audits_to_status', `"toStatus" IN ('pending','confirmed','preparing','delivering','completed','cancelled')`)
@Check('CHK_order_status_audits_source', `"source" IN ('owner','admin','driver','customer','stale_sweep')`)
@Check('CHK_order_status_audits_actor_role', `"actorRole" IS NULL OR "actorRole" IN ('customer','owner','admin','driver')`)
@Index('IDX_order_status_audits_orderId_createdAt', ['orderId', 'createdAt'])
@Index('IDX_order_status_audits_actorUserId', ['actorUserId'])
@Entity('order_status_audits')
export class OrderStatusAudit {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_order_status_audits_id' })
  id: string;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'orderId', foreignKeyConstraintName: 'FK_order_status_audits_orderId' })
  order: Order;

  @Column('uuid')
  orderId: string;

  @Column({ type: 'varchar', length: 20 })
  fromStatus: OrderStatus;

  @Column({ type: 'varchar', length: 20 })
  toStatus: OrderStatus;

  @Column({ type: 'varchar', length: 24 })
  source: OrderStatusAuditSource;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actorUserId', foreignKeyConstraintName: 'FK_order_status_audits_actorUserId' })
  actorUser: User | null;

  @Column({ type: 'uuid', nullable: true })
  actorUserId: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  actorRole: UserRole | null;

  /** Snapshot survives actor deletion while the nullable FK is cleared. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  actorEmail: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
