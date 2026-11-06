import {
  Column,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { MenuItem } from './menu-item.entity';
import { MenuOptionChoice } from './menu-option-choice.entity';

/**
 * A named question attached to a dish — "Size", "Spice level", "Add-ons"
 * (Phase 5 menu options/variants). Owners manage them under
 * `/menu/items/:itemId/options/groups`; customers pick choice ids on
 * checkout order lines. Money-affecting rules live with the choices.
 */
@Index('IDX_menu_option_groups_menuItemId', ['menuItemId'])
@Entity('menu_option_groups')
export class MenuOptionGroup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Group label shown at checkout ("Size"). Non-blank, <= 80 chars. */
  @Column()
  name: string;

  /**
   * How many of this group's choices an order line MUST select (0 = the
   * group is optional). DB CHECK keeps it in 0..20.
   */
  @Column({ type: 'int', default: 0 })
  minChoices: number;

  /**
   * Upper bound of selections per order line (1 = radio-style "pick one
   * size"; N = checkbox "add-ons"). DB CHECK keeps it in 1..20 and >= min.
   */
  @Column({ type: 'int', default: 1 })
  maxChoices: number;

  /** Display order on the dish (ASC; ties are stable by fetch order). */
  @Column({ type: 'int', default: 0 })
  position: number;

  /** Property name is `menuItem` so TypeORM's default FK column
   *  (`menuItemId`) matches the explicit @Column below — a `item` relation
   *  would look for an `itemId` column the migration does not have. */
  @ManyToOne(() => MenuItem, (item) => item.optionGroups, {
    onDelete: 'CASCADE',
  })
  menuItem: MenuItem;

  @Column()
  menuItemId: string;

  @OneToMany(() => MenuOptionChoice, (choice) => choice.group, {
    cascade: true,
  })
  choices: MenuOptionChoice[];
}
