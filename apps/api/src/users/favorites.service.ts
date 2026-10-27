import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Favorite } from './favorite.entity';
import { MenuItem } from '../menu/menu-item.entity';
import { isUuid } from '../common/uuid';

/** Flat client-facing favorite row: dish fields + restaurant identity + when it was hearted. */
export interface FavoriteDish {
  menuItemId: string;
  name: string;
  description: string | null;
  priceCents: number;
  category: string | null;
  imageUrl: string | null;
  isAvailable: boolean;
  prepMinutes: number;
  restaurantId: string;
  restaurantName: string;
  restaurantSlug: string;
  restaurantIsOpen: boolean;
  favoritedAt: Date;
}

/** Postgres unique-violation discriminator for the concurrent-double-add race. */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as any)?.code ?? (err as any)?.driverError?.code;
  return code === '23505';
}

function toFavoriteDish(fav: Favorite): FavoriteDish {
  const dish = fav.menuItem;
  const rest = dish.restaurant;
  return {
    menuItemId: dish.id,
    name: dish.name,
    description: dish.description ?? null,
    priceCents: dish.priceCents,
    category: dish.category ?? null,
    imageUrl: dish.imageUrl ?? null,
    isAvailable: dish.isAvailable,
    prepMinutes: dish.prepMinutes,
    restaurantId: dish.restaurantId,
    restaurantName: rest?.name ?? 'Restaurant',
    restaurantSlug: rest?.slug ?? '',
    restaurantIsOpen: rest?.isOpen ?? false,
    favoritedAt: fav.createdAt,
  };
}

/**
 * `GET/POST/DELETE /users/me/favorites` — hearts on dishes, scoped strictly to
 * the JWT subject (no `:userId` in any route, same construction as the rest of
 * UsersController). Add is idempotent (client retries can't duplicate a heart,
 * and the unique index plus its catch covers the concurrent race), remove is
 * idempotent too, so the web heart button can fire optimistically and simply
 * refetch on any mismatch.
 */
@Injectable()
export class FavoritesService {
  constructor(
    @InjectRepository(Favorite) private readonly favRepo: Repository<Favorite>,
    @InjectRepository(MenuItem) private readonly dishRepo: Repository<MenuItem>,
  ) {}

  /** Full list for the caller, newest heart first. */
  async list(userId: string): Promise<{ items: FavoriteDish[]; total: number }> {
    const rows = await this.favRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      relations: { menuItem: { restaurant: true } },
    });
    // Defensive: a cascade-deleted dish should never appear, but don't render
    // half-rows if the DB ever disagrees with the FK story.
    const items = rows.filter((r) => !!r.menuItem).map(toFavoriteDish);
    return { items, total: items.length };
  }

  /**
   * Heart a dish. 404s when the dish id is unknown; returns `created:false`
   * (HTTP 200) when it was already favorited — deliberate idempotency, not a
   * silent failure, the flag tells the client whether the DB row changed.
   */
  async add(userId: string, menuItemId: string): Promise<{ created: boolean; item: FavoriteDish }> {
    if (!isUuid(menuItemId)) throw new NotFoundException('Dish not found');
    const dish = await this.dishRepo.findOne({
      where: { id: menuItemId },
      relations: { restaurant: true },
    });
    if (!dish) throw new NotFoundException('Dish not found');

    const existing = await this.favRepo.findOne({ where: { userId, menuItemId } });
    if (existing) {
      return { created: false, item: toFavoriteDish(await this.withRelations(existing)) };
    }

    try {
      await this.favRepo.insert({ userId, menuItemId });
    } catch (err) {
      // Lost a race against an identical concurrent add — that's "already there".
      if (!isUniqueViolation(err)) throw err;
      const row = await this.favRepo.findOne({ where: { userId, menuItemId } });
      if (!row) throw err;
      return { created: false, item: toFavoriteDish(await this.withRelations(row)) };
    }
    const row = await this.favRepo.findOne({ where: { userId, menuItemId } });
    if (!row) throw new NotFoundException('Favorite not found after insert');
    return { created: true, item: toFavoriteDish(await this.withRelations(row)) };
  }

  /**
   * Un-heart. `removed:false` when the dish wasn't favorited (idempotent).
   * A malformed id can never match a row, so it answers the same way —
   * short-circuit keeps junk out of Postgres (22P02). Over HTTP the route's
   * `UuidParam` answers 400 first; this guard covers direct service calls.
   */
  async remove(userId: string, menuItemId: string): Promise<{ removed: boolean }> {
    if (!isUuid(menuItemId)) return { removed: false };
    const result = await this.favRepo.delete({ userId, menuItemId });
    return { removed: (result.affected ?? 0) > 0 };
  }

  /** Re-read one favorite with dish+restaurant loaded, for the add response. */
  private withRelations(fav: Favorite): Promise<Favorite> {
    return this.favRepo.findOneOrFail({
      where: { id: fav.id },
      relations: { menuItem: { restaurant: true } },
    });
  }
}
