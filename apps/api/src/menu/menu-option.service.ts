import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MenuOptionGroup } from './menu-option-group.entity';
import { MenuOptionChoice } from './menu-option-choice.entity';
import { MenuService, Actor } from './menu.service';
import { isUuid } from '../common/uuid';
import {
  CreateOptionGroupDto,
  CreateOptionChoiceDto,
  UpdateOptionGroupDto,
  UpdateOptionChoiceDto,
} from './dto/menu-option.dto';
import {
  OrderOptionSnapshot,
  ResolvedOptionLine,
} from './order-option-snapshot';

/** Hard cap per group — mirrors the DTO ArrayMaxSize and owner sanity. */
const MAX_CHOICES_PER_GROUP = 20;

/**
 * Menu options/variants (Phase 5): owner CRUD over option groups/choices
 * plus the one read-only job the order path needs — validating a cart
 * line's selected choice ids and turning them into a server-side price
 * delta + receipt snapshot. Selection rules enforced HERE (never client):
 * existence, belongs-to-this-dish, no duplicates, per-group min/max.
 */
@Injectable()
export class MenuOptionService {
  constructor(
    @InjectRepository(MenuOptionGroup)
    private readonly groups: Repository<MenuOptionGroup>,
    @InjectRepository(MenuOptionChoice)
    private readonly choices: Repository<MenuOptionChoice>,
    // Reuses MenuService's dish+restaurant ownership resolution verbatim —
    // one source of truth for "may this actor manage this dish".
    private readonly menu: MenuService,
  ) {}

  // ---------------------------------------------------------------- owner CRUD

  async createGroup(
    itemId: string,
    actor: Actor,
    dto: CreateOptionGroupDto,
  ): Promise<MenuOptionGroup> {
    const item = await this.menu.loadManagedItem(itemId, actor);
    const minChoices = dto.minChoices ?? 0;
    const maxChoices = dto.maxChoices ?? 1;
    this.assertRange(minChoices, maxChoices);
    if (minChoices > dto.choices.length) {
      throw new BadRequestException(
        `"${dto.name}" requires ${minChoices} selection(s) but only ${dto.choices.length} choice(s) were provided`,
      );
    }
    const group = this.groups.create({
      menuItemId: item.id,
      name: dto.name,
      minChoices,
      maxChoices,
      position: dto.position ?? 0,
      choices: dto.choices.map(
        (c, idx) =>
          this.choices.create({
            name: c.name,
            priceDeltaCents: c.priceDeltaCents ?? 0,
            position: c.position ?? idx,
          }),
      ),
    });
    return this.groups.save(group); // cascade inserts the choices
  }

  async updateGroup(
    itemId: string,
    groupId: string,
    actor: Actor,
    dto: UpdateOptionGroupDto,
  ): Promise<MenuOptionGroup> {
    const group = await this.loadManagedGroup(itemId, groupId, actor);
    const minChoices = dto.minChoices ?? group.minChoices;
    const maxChoices = dto.maxChoices ?? group.maxChoices;
    this.assertRange(minChoices, maxChoices);
    if (minChoices > (group.choices?.length ?? 0)) {
      throw new BadRequestException(
        `"${group.name}" has only ${group.choices?.length ?? 0} choice(s) — it cannot require ${minChoices}`,
      );
    }
    if (dto.name !== undefined) group.name = dto.name;
    if (dto.minChoices !== undefined) group.minChoices = dto.minChoices;
    if (dto.maxChoices !== undefined) group.maxChoices = dto.maxChoices;
    if (dto.position !== undefined) group.position = dto.position;
    return this.groups.save(group);
  }

  /**
   * Removes a group with ALL its choices (DB FK CASCADE too). Returns the
   * PRE-DELETE snapshot — same dispose-nulls-id trap as dish delete
   * (session 14). Past order lines are untouched: their receipt lives in
   * the jsonb snapshot, not in these rows.
   */
  async removeGroup(
    itemId: string,
    groupId: string,
    actor: Actor,
  ): Promise<MenuOptionGroup> {
    const group = await this.loadManagedGroup(itemId, groupId, actor);
    const removed = { ...group };
    await this.groups.remove(group);
    return removed;
  }

  async addChoice(
    itemId: string,
    groupId: string,
    actor: Actor,
    dto: CreateOptionChoiceDto,
  ): Promise<MenuOptionChoice> {
    const group = await this.loadManagedGroup(itemId, groupId, actor);
    const current = group.choices ?? [];
    if (current.length >= MAX_CHOICES_PER_GROUP) {
      throw new BadRequestException(
        `"${group.name}" already has the maximum of ${MAX_CHOICES_PER_GROUP} choices`,
      );
    }
    const choice = this.choices.create({
      groupId: group.id,
      name: dto.name,
      priceDeltaCents: dto.priceDeltaCents ?? 0,
      position: dto.position ?? current.length,
    });
    return this.choices.save(choice);
  }

  async updateChoice(
    itemId: string,
    groupId: string,
    choiceId: string,
    actor: Actor,
    dto: UpdateOptionChoiceDto,
  ): Promise<MenuOptionChoice> {
    await this.loadManagedGroup(itemId, groupId, actor); // ownership + membership
    const choice = await this.findChoiceInGroup(groupId, choiceId);
    if (dto.name !== undefined) choice.name = dto.name;
    if (dto.priceDeltaCents !== undefined) {
      choice.priceDeltaCents = dto.priceDeltaCents;
    }
    if (dto.position !== undefined) choice.position = dto.position;
    return this.choices.save(choice);
  }

  /**
   * A group that MANDATES n selections cannot be starved below n choices —
   * the owner must lower minChoices first (clear error, no silent
   * unorderable dishes).
   */
  async removeChoice(
    itemId: string,
    groupId: string,
    choiceId: string,
    actor: Actor,
  ): Promise<MenuOptionChoice> {
    const group = await this.loadManagedGroup(itemId, groupId, actor);
    const choice = await this.findChoiceInGroup(groupId, choiceId);
    if ((group.choices?.length ?? 0) - 1 < group.minChoices) {
      throw new BadRequestException(
        `"${group.name}" requires ${group.minChoices} selection(s) and would have only ${(group.choices?.length ?? 0) - 1} choice(s) left — lower minChoices first`,
      );
    }
    const removed = { ...choice };
    await this.choices.remove(choice);
    return removed;
  }

  private assertRange(minChoices: number, maxChoices: number): void {
    if (minChoices > maxChoices) {
      throw new BadRequestException(
        `minChoices (${minChoices}) cannot exceed maxChoices (${maxChoices})`,
      );
    }
  }

  /** Group under the (already ownership-checked) dish; unknown => 404. */
  private async loadManagedGroup(
    itemId: string,
    groupId: string,
    actor: Actor,
  ): Promise<MenuOptionGroup> {
    await this.menu.loadManagedItem(itemId, actor);
    if (!isUuid(groupId)) throw new NotFoundException('Option group not found');
    const group = await this.groups.findOne({
      where: { id: groupId, menuItemId: itemId },
      relations: { choices: true },
    });
    if (!group) throw new NotFoundException('Option group not found');
    return group;
  }

  /** Choice under the group; foreign id => 404 (no existence leak). */
  private async findChoiceInGroup(
    groupId: string,
    choiceId: string,
  ): Promise<MenuOptionChoice> {
    if (!isUuid(choiceId)) throw new NotFoundException('Option choice not found');
    const choice = await this.choices.findOne({
      where: { id: choiceId, groupId },
    });
    if (!choice) throw new NotFoundException('Option choice not found');
    return choice;
  }

  // ----------------------------------------------------------- order pricing

  /**
   * Validate every cart line's selected choice ids against the dishes'
   * option groups and return the per-line price delta + ordered receipt
   * snapshots. Rules (all 400, the client's numbers are NEVER consulted):
   * duplicate id on one line; unknown id / id belonging to another dish —
   * indistinguishable by design; a group's min not met; its max exceeded.
   * Lines are resolved IN ORDER so the caller can zip results with dto
   * items by index.
   */
  async resolveSelections(
    lines: { menuItemId: string; optionChoiceIds?: string[] }[],
  ): Promise<ResolvedOptionLine[]> {
    const itemIds = [...new Set(lines.map((l) => l.menuItemId))];
    const groups = itemIds.length
      ? await this.groups.find({
          where: { menuItemId: In(itemIds) },
          relations: { choices: true },
        })
      : [];

    // itemId -> ordered groups; each group -> choiceId -> choice.
    const groupsByItem = new Map<string, MenuOptionGroup[]>();
    const choiceIndex = new Map<
      string,
      Map<string, { group: MenuOptionGroup; choice: MenuOptionChoice }>
    >();
    for (const g of groups) {
      const list = groupsByItem.get(g.menuItemId) ?? [];
      list.push(g);
      groupsByItem.set(g.menuItemId, list);
      const index = choiceIndex.get(g.menuItemId) ?? new Map();
      for (const c of g.choices ?? []) {
        index.set(c.id, { group: g, choice: c });
      }
      choiceIndex.set(g.menuItemId, index);
    }
    for (const list of groupsByItem.values()) {
      list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    }

    const out: ResolvedOptionLine[] = [];
    for (const line of lines) {
      const itemGroups = groupsByItem.get(line.menuItemId) ?? [];
      const picked = line.optionChoiceIds ?? [];
      if (!itemGroups.length && !picked.length) {
        out.push({ extraCents: 0, selections: [] });
        continue;
      }
      if (!itemGroups.length) {
        throw new BadRequestException(
          'One or more selected options do not belong to this dish',
        );
      }
      if (new Set(picked).size !== picked.length) {
        throw new BadRequestException(
          'Duplicate option selection on one order line',
        );
      }
      const index = choiceIndex.get(line.menuItemId) ?? new Map();
      const perGroup = new Map<string, MenuOptionChoice[]>();
      for (const choiceId of picked) {
        const entry = index.get(choiceId);
        if (!entry) {
          // Unknown id OR another dish's id — same answer either way.
          throw new BadRequestException(
            'One or more selected options do not belong to this dish',
          );
        }
        const list = perGroup.get(entry.group.id) ?? [];
        list.push(entry.choice);
        perGroup.set(entry.group.id, list);
      }
      let extraCents = 0;
      const selections: OrderOptionSnapshot[] = [];
      for (const g of itemGroups) {
        const sel = (perGroup.get(g.id) ?? []).sort(
          (a, b) => a.position - b.position || a.name.localeCompare(b.name),
        );
        if (sel.length < g.minChoices) {
          throw new BadRequestException(
            `"${g.name}" requires at least ${g.minChoices} selection(s) on this dish`,
          );
        }
        if (sel.length > g.maxChoices) {
          throw new BadRequestException(
            `"${g.name}" allows at most ${g.maxChoices} selection(s) on this dish`,
          );
        }
        for (const c of sel) {
          extraCents += c.priceDeltaCents;
          selections.push({
            groupId: g.id,
            groupName: g.name,
            choiceId: c.id,
            choiceName: c.name,
            priceDeltaCents: c.priceDeltaCents,
          });
        }
      }
      out.push({ extraCents, selections });
    }
    return out;
  }
}
