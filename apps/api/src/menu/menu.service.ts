import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MenuItem } from './menu-item.entity';
import { MenuOptionGroup } from './menu-option-group.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { UserRole } from '../users/user.entity';
import { isUuid } from '../common/uuid';
import {
  CreateMenuImageUploadDto,
  CreateMenuItemDto,
  UpdateMenuItemDto,
} from './dto/menu-item.dto';
import { MenuImageService } from './menu-image.service';

/** Authenticated actor (from the JWT claims) attempting a menu write. */
export interface Actor {
  sub: string;
  role: UserRole;
}

@Injectable()
export class MenuService {
  constructor(
    @InjectRepository(MenuItem) private readonly repo: Repository<MenuItem>,
    @InjectRepository(Restaurant)
    private readonly restaurants: Repository<Restaurant>,
    private readonly imageUploads: MenuImageService,
    // Optional so every pre-options construction (unit harnesses) keeps
    // working; the app module always registers both option entities.
    @Optional()
    @InjectRepository(MenuOptionGroup)
    private readonly optionGroups?: Repository<MenuOptionGroup>,
  ) {}

  /**
   * Public menu of one restaurant, WITH option groups + choices attached
   * (Phase 5). Two flat queries — items, then all groups for those ids in
   * one IN — deliberately avoiding a per-dish N+1; choices come with the
   * group relation load. An owner-created dish with no groups serializes
   * `optionGroups: []` so the web cart can branch without null-checks.
   */
  async findByRestaurant(restaurantId: string): Promise<MenuItem[]> {
    if (!isUuid(restaurantId)) throw new NotFoundException('Restaurant not found');
    const items = await this.repo.find({
      where: { restaurantId },
      order: { category: 'ASC', name: 'ASC' },
    });
    if (!items.length) return items;
    if (!this.optionGroups) {
      return items.map((i) => ({ ...i, optionGroups: [] }));
    }
    const groups = await this.optionGroups.find({
      where: { menuItemId: In(items.map((i) => i.id)) },
      relations: { choices: true },
    });
    const byItem = new Map<string, MenuOptionGroup[]>();
    for (const g of groups) {
      g.choices = (g.choices ?? []).sort(
        (a, b) => a.position - b.position || a.name.localeCompare(b.name),
      );
      const list = byItem.get(g.menuItemId) ?? [];
      list.push(g);
      byItem.set(g.menuItemId, list);
    }
    for (const list of byItem.values()) {
      list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    }
    return items.map((i) => ({ ...i, optionGroups: byItem.get(i.id) ?? [] }));
  }

  /** Fetch items by ids — used when pricing an order server-side. */
  async findByIds(ids: string[]) {
    const items = await this.repo.find({ where: { id: In(ids) } });
    if (items.length !== new Set(ids).size) {
      throw new NotFoundException('One or more menu items no longer exist');
    }
    return items;
  }

  /**
   * Owner-or-admin check against the restaurant that owns the dish.
   * Platform-seeded restaurants (ownerId null) are admin-only.
   */
  private async assertCanManage(restaurantId: string, actor: Actor) {
    if (!isUuid(restaurantId)) throw new NotFoundException('Restaurant not found');
    const restaurant = await this.restaurants.findOne({
      where: { id: restaurantId },
      select: { id: true, ownerId: true },
    });
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    if (actor.role !== UserRole.ADMIN && restaurant.ownerId !== actor.sub) {
      throw new ForbiddenException('You do not own this restaurant');
    }
  }

  async createForRestaurant(
    restaurantId: string,
    actor: Actor,
    dto: CreateMenuItemDto,
  ): Promise<MenuItem> {
    await this.assertCanManage(restaurantId, actor);
    const item = this.repo.create({
      restaurantId,
      name: dto.name,
      priceCents: dto.priceCents,
      description: dto.description ?? null as any,
      category: dto.category ?? null as any,
      imageUrl: dto.imageUrl ?? null as any,
      prepMinutes: dto.prepMinutes ?? 15,
      isAvailable: dto.isAvailable ?? true,
    });
    return this.repo.save(item);
  }

  /**
   * Load a dish and verify the actor may manage its parent restaurant.
   * PUBLIC because MenuOptionService reuses the exact same ownership
   * resolution for option-group routes (session 14 lesson: foreign/unknown
   * ids both answer 404, no existence leak).
   */
  async loadManagedItem(id: string, actor: Actor): Promise<MenuItem> {
    if (!isUuid(id)) throw new NotFoundException('Menu item not found');
    const item = await this.repo.findOne({ where: { id } });
    if (!item) throw new NotFoundException('Menu item not found');
    await this.assertCanManage(item.restaurantId, actor);
    return item;
  }

  async updateItem(id: string, actor: Actor, dto: UpdateMenuItemDto): Promise<MenuItem> {
    const item = await this.loadManagedItem(id, actor);
    const patch: Partial<MenuItem> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.priceCents !== undefined) patch.priceCents = dto.priceCents;
    if (dto.description !== undefined) patch.description = dto.description as any;
    if (dto.category !== undefined) patch.category = dto.category as any;
    if (dto.imageUrl !== undefined) patch.imageUrl = dto.imageUrl as any;
    if (dto.prepMinutes !== undefined) patch.prepMinutes = dto.prepMinutes;
    Object.assign(item, patch);
    return this.repo.save(item);
  }

  async setAvailability(id: string, actor: Actor, isAvailable: boolean): Promise<MenuItem> {
    const item = await this.loadManagedItem(id, actor);
    item.isAvailable = isAvailable;
    return this.repo.save(item);
  }

  async createImageUpload(id: string, actor: Actor, dto: CreateMenuImageUploadDto) {
    const item = await this.loadManagedItem(id, actor);
    return this.imageUploads.createUpload(item.id, dto);
  }

  /**
   * Hard delete. Safe for history: order_items keeps name/price snapshots and
   * its menuItemId FK is ON DELETE SET NULL, so past orders stay readable.
   * Returns a PRE-DELETE snapshot: TypeORM's `remove()` nulls the primary
   * column on the entity it disposes, so returning `item` directly would
   * serialize JSON WITHOUT `id` (found by runtime smoke, session 14).
   */
  async remove(id: string, actor: Actor): Promise<MenuItem> {
    const item = await this.loadManagedItem(id, actor);
    const removed = { ...item };
    await this.repo.remove(item);
    return removed;
  }
}
