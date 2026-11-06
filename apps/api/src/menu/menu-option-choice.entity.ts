import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { MenuOptionGroup } from './menu-option-group.entity';

/**
 * One selectable variant inside an option group ("Large", "Extra egg").
 * Ordering validates selections against the group's min/max and folds
 * `priceDeltaCents` into the server-computed unit price (integer cents,
 * never trusted from the client). Deltas are >= 0 by CHECK: the dish's
 * base price always represents its cheapest variant; free "no X" requests
 * stay in the order note.
 */
@Index('IDX_menu_option_choices_groupId', ['groupId'])
@Entity('menu_option_choices')
export class MenuOptionChoice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Choice label ("Regular"). Non-blank, <= 80 chars. */
  @Column()
  name: string;

  /** Extra cents on top of the dish base price when this choice is picked. */
  @Column({ type: 'int', default: 0 })
  priceDeltaCents: number;

  /** Display order inside the group (ASC). */
  @Column({ type: 'int', default: 0 })
  position: number;

  @ManyToOne(() => MenuOptionGroup, (group) => group.choices, {
    onDelete: 'CASCADE',
  })
  group: MenuOptionGroup;

  @Column()
  groupId: string;
}
