import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { MenuService } from './menu.service';
import { MenuItem } from './menu-item.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { UserRole } from '../users/user.entity';

function fakeItem(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Nasi Goreng',
    priceCents: 1800,
    restaurantId: '11111111-1111-4111-8111-111111111111',
    isAvailable: true,
    prepMinutes: 15,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as MenuItem;
}

function fakeRestaurant(overrides: Partial<Restaurant> = {}): Restaurant {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Warung',
    ownerId: 'u1',
    ...overrides,
  } as Restaurant;
}

const owner = { sub: 'u1', role: UserRole.OWNER };
const intruder = { sub: 'evil', role: UserRole.OWNER };
const admin = { sub: 'u9', role: UserRole.ADMIN };
const customer = { sub: 'c1', role: UserRole.CUSTOMER };

function build(
  items: MenuItem[] = [fakeItem()],
  restaurants: Restaurant[] = [fakeRestaurant()],
) {
  const itemRepo: any = {
    findOne: jest.fn(async ({ where }: any) =>
      where.id ? items.find((i) => i.id === where.id) ?? null : null,
    ),
    find: jest.fn(async ({ where }: any = {}) =>
      where.restaurantId
        ? items.filter((i) => i.restaurantId === where.restaurantId)
        : where.id
          ? items.filter((i) => (where.id.value ?? []).includes(i.id))
          : [...items],
    ),
    create: jest.fn((x: any) => x),
    save: jest.fn(async (x: any) => ({ ...fakeItem(), ...x })),
    // Faithful to TypeORM: remove() DISPOSES the entity IN PLACE, nulling its
    // primary column — so a naive `return item` after remove() loses `id`
    // (the exact bug session 14's runtime smoke caught). The service must
    // snapshot before calling this; reverting that would fail the tests below.
    remove: jest.fn(async (x: any) => {
      delete x.id;
      return x;
    }),
  };
  const restaurantRepo: any = {
    findOne: jest.fn(async ({ where }: any) =>
      restaurants.find((r) => r.id === where.id) ?? null,
    ),
  };
  const service = new MenuService(itemRepo as Repository<MenuItem>, restaurantRepo);
  return { itemRepo, restaurantRepo, service };
}

describe('MenuService — owner CRUD', () => {
  describe('createForRestaurant', () => {
    it('owner can add a dish: stamps restaurantId and defaults', async () => {
      const { service, itemRepo } = build([]);
      await service.createForRestaurant('11111111-1111-4111-8111-111111111111', owner, {
        name: 'Rendang',
        priceCents: 4500,
      });
      const arg = itemRepo.create.mock.calls[0][0];
      expect(arg).toMatchObject({
        restaurantId: '11111111-1111-4111-8111-111111111111',
        name: 'Rendang',
        priceCents: 4500,
        prepMinutes: 15,
        isAvailable: true,
      });
    });

    it('honours explicit isAvailable: false (draft dish)', async () => {
      const { service, itemRepo } = build([]);
      await service.createForRestaurant('11111111-1111-4111-8111-111111111111', owner, {
        name: 'Secret Dish',
        priceCents: 1,
        isAvailable: false,
      });
      expect(itemRepo.create.mock.calls[0][0].isAvailable).toBe(false);
    });

    it('other owner gets 403', async () => {
      const { service } = build([]);
      await expect(
        service.createForRestaurant('11111111-1111-4111-8111-111111111111', intruder, { name: 'X', priceCents: 100 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin can add to a platform restaurant (ownerId null)', async () => {
      const { service } = build([], [fakeRestaurant({ ownerId: null })]);
      const res = await service.createForRestaurant('11111111-1111-4111-8111-111111111111', admin, {
        name: 'Platform Special',
        priceCents: 2000,
      });
      expect((res as any).name).toBe('Platform Special');
    });

    it('unknown restaurant → 404', async () => {
      const { service } = build([], []);
      await expect(
        service.createForRestaurant('nope', owner, { name: 'X', priceCents: 100 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-uuid restaurant id → 404 without touching the DB', async () => {
      const { service, restaurantRepo } = build();
      await expect(
        service.createForRestaurant('garbage', owner, { name: 'X', priceCents: 100 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(restaurantRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('updateItem', () => {
    it('owner edits own dish (partial patch)', async () => {
      const { service, itemRepo } = build([fakeItem({ restaurantId: '11111111-1111-4111-8111-111111111111' })]);
      const res = await service.updateItem('33333333-3333-4333-8333-333333333333', owner, { priceCents: 2000 });
      expect((res as any).priceCents).toBe(2000);
      expect(itemRepo.save).toHaveBeenCalled();
    });

    it('only whitelisted fields are applied — restaurantId untouched', async () => {
      const { service, itemRepo } = build();
      await service.updateItem('33333333-3333-4333-8333-333333333333', owner, {
        name: 'Renamed',
        restaurantId: '22222222-2222-4222-8222-222222222222', // not a DTO property — must never reach the entity
        id: 'hijack',
      } as any);
      const saved = itemRepo.save.mock.calls[0][0];
      expect(saved.name).toBe('Renamed');
      expect(saved.restaurantId).toBe('11111111-1111-4111-8111-111111111111');
      expect(saved.id).toBe('33333333-3333-4333-8333-333333333333');
    });

    it("cannot edit another owner's dish", async () => {
      const { service } = build(
        [fakeItem({ restaurantId: '22222222-2222-4222-8222-222222222222' })],
        [fakeRestaurant({ id: '22222222-2222-4222-8222-222222222222', ownerId: 'someone-else' })],
      );
      await expect(service.updateItem('33333333-3333-4333-8333-333333333333', owner, { priceCents: 1 })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('unknown dish → 404 (before any ownership query)', async () => {
      const { service, restaurantRepo } = build();
      await expect(service.updateItem('nope', owner, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(restaurantRepo.findOne).not.toHaveBeenCalled();
    });

    it('dish whose restaurant vanished → 404', async () => {
      const { service } = build([fakeItem()], []);
      await expect(service.updateItem('33333333-3333-4333-8333-333333333333', owner, { name: 'Ghost' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('non-uuid dish id → 404 without touching the DB', async () => {
      const { service, itemRepo } = build();
      await expect(service.updateItem('not-a-uuid', owner, { name: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(itemRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('setAvailability', () => {
    it('owner toggles off, then on', async () => {
      const { service, itemRepo } = build();
      await service.setAvailability('33333333-3333-4333-8333-333333333333', owner, false);
      expect(itemRepo.save.mock.calls[0][0].isAvailable).toBe(false);
      await service.setAvailability('33333333-3333-4333-8333-333333333333', owner, true);
      expect(itemRepo.save.mock.calls[1][0].isAvailable).toBe(true);
    });

    it('non-owner → 403, no save', async () => {
      const { service, itemRepo } = build();
      await expect(service.setAvailability('33333333-3333-4333-8333-333333333333', intruder, false)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(itemRepo.save).not.toHaveBeenCalled();
    });

    it('admin may toggle a platform dish', async () => {
      const { service, itemRepo } = build([fakeItem()], [fakeRestaurant({ ownerId: null })]);
      await service.setAvailability('33333333-3333-4333-8333-333333333333', admin, false);
      expect(itemRepo.save.mock.calls[0][0].isAvailable).toBe(false);
    });
  });

  describe('remove', () => {
    it('owner deletes own dish', async () => {
      const { service, itemRepo } = build();
      const removed = await service.remove('33333333-3333-4333-8333-333333333333', owner);
      expect((removed as any).id).toBe('33333333-3333-4333-8333-333333333333');
      expect(itemRepo.remove).toHaveBeenCalled();
    });

    it('non-owner → 403, no remove', async () => {
      const { service, itemRepo } = build();
      await expect(service.remove('33333333-3333-4333-8333-333333333333', customer)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(itemRepo.remove).not.toHaveBeenCalled();
    });

    it('unknown dish → 404', async () => {
      const { service } = build();
      await expect(service.remove('nope', owner)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-uuid dish id → 404 for delete too', async () => {
      const { service, itemRepo } = build();
      await expect(service.remove('zzz', owner)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.setAvailability('zzz', owner, false)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(itemRepo.findOne).not.toHaveBeenCalled();
    });
  });
});
