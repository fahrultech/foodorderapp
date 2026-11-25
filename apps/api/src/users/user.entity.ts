import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum UserRole {
  CUSTOMER = 'customer',
  OWNER = 'owner',
  ADMIN = 'admin',
  DRIVER = 'driver',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column()
  name: string;

  @Column()
  passwordHash: string;

  @Column({ nullable: true })
  phone: string;

  @Column({ nullable: true })
  address: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.CUSTOMER })
  role: UserRole;

  /**
   * Per-user notification channel opt-outs (Phase 14). Defaults TRUE:
   * every pre-existing account keeps exactly the behavior it had before
   * these columns existed. `orderEmailEnabled` gates the confirmation +
   * status-step emails for AUTHENTICATED orders only (guest orders have
   * no account to consult — their proof address keeps receiving them,
   * which is the receipt contract); `orderPushEnabled` gates the
   * browser-push fan-out. Consulted at fan-out time by
   * OrderNotificationsService with a strict `=== false` check so an
   * unwritten column (legacy/imported rows, fake fixtures) reads as ON.
   */
  @Column({ type: 'boolean', default: true })
  orderEmailEnabled: boolean;

  @Column({ type: 'boolean', default: true })
  orderPushEnabled: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
