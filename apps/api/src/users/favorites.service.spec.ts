import { NotFoundException } from '@nestjs/common';
import { Favorite } from './favorite.entity';
import { FavoritesService } from './favorites.service';
import { MenuItem } from '../menu/menu-item.entity';
import { Restaurant } from '../restaurants/restaurant.entity';

/** The real dish id column is uuid — the service short-circuits junk ids. */
const DISH_ID = '00000000-0000-4000-8000-0000000000d1';

function fakeDish(overrides: Partial<MenuItem> = {}): MenuItem {
  const restaurant = {
    id: 'r1',
    name: 'Warung Nusantara',
    slug: 'warung-nusantara',
    isOpen: true,
  } as Restaurant;
  return {
    id: DISH_ID,
    name: 'Nasi Goreng',
    description: 'Fried rice',
    priceCents: 1200,
    category: 'Mains',
    imageUrl: null,
    isAvailable: true,
    prepMinutes: 15,
    restaurantId: 'r1',
    restaurant,
    ...overrides,
  } as MenuItem;
}

function fakeFavorite(dish: MenuItem, createdAt = new Date('2026-05-01T00:00:00Z')): Favorite {
  return {
    id: 'f1',
    userId: 'u1',
    menuItemId: dish.id,
    menuItem: dish,
    createdAt,
  } as Favorite;
}

interface FavOpts {
  existing?: Favorite | null;
  rows?: Favorite[];
  affected?: number;
  insertThrows?: unknown;
  /** Row that "the other transaction" committed when insert loses a race. */
  raceRow?: Favorite;
}

/** Stateful repo double: insert stores the row, findOne reads it back. */
function build(dish: MenuItem | null, opts: FavOpts = {}) {
  let stored: Favorite | null = opts.existing ?? null;
  const favRepo: any = {
    find: jest.fn(async () => opts.rows ?? []),
    findOne: jest.fn(async () => stored),
    findOneOrFail: jest.fn(async () => stored ?? fakeFavorite(dish ?? fakeDish())),
    insert: jest.fn(async () => {
      if (opts.insertThrows) {
        if (opts.raceRow) stored = opts.raceRow;
        throw opts.insertThrows;
      }
      if (!dish) throw new Error('test setup: insert without a dish');
      stored = fakeFavorite(dish);
      return { identifiers: [{ id: 'f-new' }], generatedMaps: [], raw: undefined };
    }),
    delete: jest.fn(async () => ({ affected: opts.affected ?? 0 })),
  };
  const dishRepo: any = {
    findOne: jest.fn(async () => dish),
  };
  return { favRepo, dishRepo, service: new FavoritesService(favRepo, dishRepo) };
}

describe('FavoritesService', () => {
  describe('list', () => {
    it('returns flat dish rows newest-first with restaurant identity', async () => {
      const older = fakeFavorite(fakeDish(), new Date('2026-01-01T00:00:00Z'));
      const h = build(null, { rows: [fakeFavorite(fakeDish()), older] });
      const res = await h.service.list('u1');

      expect(h.favRepo.findOne).not.toHaveBeenCalled();
      expect(h.favRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u1' }, order: { createdAt: 'DESC' } }),
      );
      expect(res.total).toBe(2);
      expect(res.items[0]).toEqual({
        menuItemId: DISH_ID,
        name: 'Nasi Goreng',
        description: 'Fried rice',
        priceCents: 1200,
        category: 'Mains',
        imageUrl: null,
        isAvailable: true,
        prepMinutes: 15,
        restaurantId: 'r1',
        restaurantName: 'Warung Nusantara',
        restaurantSlug: 'warung-nusantara',
        restaurantIsOpen: true,
        favoritedAt: expect.any(Date),
      });
    });

    it('drops rows whose dish vanished (defensive against FK drift)', async () => {
      const h = build(fakeDish(), { rows: [{ ...fakeFavorite(fakeDish()), menuItem: null } as any] });
      const res = await h.service.list('u1');
      expect(res.items).toHaveLength(0);
      expect(res.total).toBe(0);
    });
  });

  describe('add', () => {
    it('404s when the dish does not exist', async () => {
      const h = build(null);
      await expect(h.service.add('u1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
      expect(h.favRepo.insert).not.toHaveBeenCalled();
    });

    it('inserts a new favorite and returns created:true with the dish row', async () => {
      const dish = fakeDish();
      const h = build(dish, { existing: null });
      const res = await h.service.add('u1', DISH_ID);

      expect(h.favRepo.insert).toHaveBeenCalledWith({ userId: 'u1', menuItemId: DISH_ID });
      expect(res.created).toBe(true);
      expect(res.item.menuItemId).toBe(DISH_ID);
      expect(res.item.restaurantName).toBe('Warung Nusantara');
    });

    it('is idempotent: existing favorite returns created:false, no insert', async () => {
      const dish = fakeDish();
      const h = build(dish, { existing: fakeFavorite(dish) });
      const res = await h.service.add('u1', DISH_ID);

      expect(h.favRepo.insert).not.toHaveBeenCalled();
      expect(res.created).toBe(false);
      expect(res.item.menuItemId).toBe(DISH_ID);
    });

    it('absorbs the unique-violation race as created:false', async () => {
      const dish = fakeDish();
      const err = Object.assign(new Error('duplicate key'), { code: '23505' });
      const h = build(dish, { insertThrows: err, raceRow: fakeFavorite(dish) });
      const res = await h.service.add('u1', DISH_ID);
      expect(res.created).toBe(false);
      expect(res.item.menuItemId).toBe(DISH_ID);
    });

    it('rethrows non-unique insert errors untouched', async () => {
      const err = Object.assign(new Error('connection lost'), { code: '08006' });
      const h = build(fakeDish(), { insertThrows: err });
      await expect(h.service.add('u1', DISH_ID)).rejects.toBe(err);
    });
  });

  describe('remove', () => {
    it('reports removed:true when a row was deleted', async () => {
      const h = build(null, { affected: 1 });
      expect(await h.service.remove('u1', DISH_ID)).toEqual({ removed: true });
      expect(h.favRepo.delete).toHaveBeenCalledWith({ userId: 'u1', menuItemId: DISH_ID });
    });

    it('is idempotent: unknown pair reports removed:false, never 404s', async () => {
      const h = build(null, { affected: 0 });
      expect(await h.service.remove('u1', DISH_ID)).toEqual({ removed: false });
    });
  });
});

describe('FavoritesService — malformed uuid guards (route pipe 400s over HTTP)', () => {
  const U = '11111111-1111-4111-8111-111111111111';

  it('add short-circuits junk dish ids to 404 without any repo read', async () => {
    const { favRepo, dishRepo, service } = build(null);
    await expect(service.add(U, 'garbage')).rejects.toBeInstanceOf(NotFoundException);
    expect(dishRepo.findOne).not.toHaveBeenCalled();
    expect(favRepo.insert).not.toHaveBeenCalled();
  });

  it('remove keeps its idempotent answer for junk ids WITHOUT touching the DB', async () => {
    const { favRepo, service } = build(null);
    await expect(service.remove(U, 'not-a-uuid')).resolves.toEqual({ removed: false });
    expect(favRepo.delete).not.toHaveBeenCalled();
  });
});
