import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RestaurantsService } from './restaurants.service';
import { Restaurant } from './restaurant.entity';
import { UserRole } from '../users/user.entity';

function fakeRestaurant(overrides: Partial<Restaurant> = {}): Restaurant {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'test-slug',
    name: 'Test Slug',
    ownerId: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Restaurant;
}

function build(existing: Restaurant[] = [fakeRestaurant()]) {
  const findOne = jest.fn(async ({ where }: any) => {
    if (where.slug) return existing.find((r) => r.slug === where.slug) ?? null;
    if (where.id) return existing.find((r) => r.id === where.id) ?? null;
    return null;
  });
  const find = jest.fn(async ({ where }: any = {}) =>
    existing.filter((r) => !where || r.ownerId === where.ownerId),
  );
  const create = jest.fn((x: any) => x);
  const save = jest.fn(async (x: any) => ({ ...fakeRestaurant(), ...x }));
  const repo: any = { findOne, find, create, save };
  const cityFindOne = jest.fn(async ({ where }: any) =>
    where.id === '33333333-3333-4333-8333-333333333333'
      ? { id: where.id, name: 'Jakarta', slug: 'jakarta', isActive: true }
      : null,
  );
  const cityRepo: any = { findOne: cityFindOne };
  return {
    findOne,
    find,
    create,
    save,
    cityFindOne,
    repo,
    service: new RestaurantsService(repo, cityRepo),
  };
}

describe('RestaurantsService — owner CRUD', () => {
  describe('uniqueSlug', () => {
    it('slugifies a name', async () => {
      const { service } = build([]);
      await expect(service.uniqueSlug("Wartek 'Berkah' 24/7!")).resolves.toBe(
        'wartek-berkah-24-7',
      );
    });

    it('appends -2/-3 on collision', async () => {
      const { service } = build([
        fakeRestaurant({ slug: 'warung' }),
        fakeRestaurant({ id: '22222222-2222-4222-8222-222222222222', slug: 'warung-2' }),
      ]);
      await expect(service.uniqueSlug('Warung')).resolves.toBe('warung-3');
    });

    it('falls back to "restaurant" for empty slug', async () => {
      const { service } = build([]);
      await expect(service.uniqueSlug('   ')).resolves.toBe('restaurant');
    });
  });

  describe('createForOwner', () => {
    it('derives slug from name, stamps ownerId and defaults', async () => {
      const { service, create } = build([]);
      await service.createForOwner('u9', { name: 'Mie Ayam Jaya' } as any);
      const arg = create.mock.calls[0][0];
      expect(arg.slug).toBe('mie-ayam-jaya');
      expect(arg.ownerId).toBe('u9');
      expect(arg.deliveryFeeCents).toBe(0);
      expect(arg.minOrderCents).toBe(0);
      expect(arg.avgPrepMinutes).toBe(30);
    });

    it('honours an explicit slug', async () => {
      const { service, create } = build([]);
      await service.createForOwner('u9', {
        name: 'Warung X',
        slug: 'custom-x',
      } as any);
      expect(create.mock.calls[0][0].slug).toBe('custom-x');
    });

    it('de-duplicates an explicit slug against existing rows', async () => {
      const { service, create } = build([fakeRestaurant({ slug: 'taken' })]);
      await service.createForOwner('u9', { name: 'Whatever', slug: 'taken' } as any);
      expect(create.mock.calls[0][0].slug).toBe('taken-2');
    });

    it('stamps the caller id as ownerId', async () => {
      const { service, create } = build([]);
      await service.createForOwner('u1', { name: 'Solo' } as any);
      expect(create.mock.calls[0][0].ownerId).toBe('u1');
    });

    it('resolves cityId through the active city registry and stores its display name', async () => {
      const { service, create, cityFindOne } = build([]);
      const cityId = '33333333-3333-4333-8333-333333333333';

      await service.createForOwner('u1', { name: 'City Resto', cityId } as any);

      expect(cityFindOne).toHaveBeenCalledWith({ where: { id: cityId, isActive: true } });
      expect(create.mock.calls[0][0]).toMatchObject({ cityId, city: 'Jakarta' });
    });

    it('rejects an unknown or inactive cityId', async () => {
      const { service, create } = build([]);
      await expect(
        service.createForOwner('u1', {
          name: 'Nowhere',
          cityId: '44444444-4444-4444-8444-444444444444',
        } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('findOwned', () => {
    it('filters by ownerId', async () => {
      const { service } = build([
        fakeRestaurant({ id: 'a', ownerId: 'u1' }),
        fakeRestaurant({ id: 'b', ownerId: 'u2' }),
      ]);
      const rows = await service.findOwned('u1');
      expect(rows.map((r) => r.id)).toEqual(['a']);
    });
  });

  describe('updateOwned', () => {
    const owner = { sub: 'u1', role: UserRole.OWNER };
    const admin = { sub: 'u9', role: UserRole.ADMIN };

    it('owner updates their own restaurant', async () => {
      const { service, save } = build([fakeRestaurant({ ownerId: 'u1' })]);
      const res = await service.updateOwned('11111111-1111-4111-8111-111111111111', owner, { name: 'Renamed' } as any);
      expect((res as any).name).toBe('Renamed');
      expect(save).toHaveBeenCalled();
    });

    it('other owner gets 403', async () => {
      const { service } = build([fakeRestaurant({ ownerId: 'u1' })]);
      await expect(
        service.updateOwned('11111111-1111-4111-8111-111111111111', { sub: 'intruder', role: UserRole.OWNER }, {
          name: 'Hijacked',
        } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin may update an unowned (platform) restaurant', async () => {
      const { service } = build([fakeRestaurant({ ownerId: null })]);
      const res = await service.updateOwned('11111111-1111-4111-8111-111111111111', admin, { isOpen: false } as any);
      expect((res as any).isOpen).toBe(false);
    });

    it('unknown id → 404', async () => {
      const { service } = build([]);
      await expect(service.updateOwned('nope', owner, {} as any)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('malformed uuid id → 404, never reaches Postgres', async () => {
      const { service, findOne } = build([]);
      await expect(
        service.updateOwned('00000000-not-a-uuid', owner, { name: 'X' } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(findOne).not.toHaveBeenCalled();
    });

    it('never applies fields outside the DTO whitelist (e.g. rating)', async () => {
      const { service, save } = build([fakeRestaurant({ ownerId: 'u1' })]);
      await service.updateOwned('11111111-1111-4111-8111-111111111111', owner, {
        name: 'Renamed',
        rating: 500, // not a property of UpdateRestaurantDto — must be ignored
      } as any);
      const saved = save.mock.calls[0][0];
      expect(saved.name).toBe('Renamed');
      expect(saved.rating).toBeUndefined();
    });

    it('updates cityId and the city display snapshot together', async () => {
      const { service, save } = build([fakeRestaurant({ ownerId: 'u1' })]);
      const cityId = '33333333-3333-4333-8333-333333333333';

      await service.updateOwned('11111111-1111-4111-8111-111111111111', owner, {
        cityId,
      } as any);

      expect(save.mock.calls[0][0]).toMatchObject({ cityId, city: 'Jakarta' });
    });

    it('clears a stale registry link when a legacy client updates the city text', async () => {
      const { service, save } = build([
        fakeRestaurant({
          ownerId: 'u1',
          cityId: '33333333-3333-4333-8333-333333333333',
          city: 'Jakarta',
        }),
      ]);

      await service.updateOwned('11111111-1111-4111-8111-111111111111', owner, {
        city: 'Medan',
      } as any);

      expect(save.mock.calls[0][0]).toMatchObject({ cityId: null, city: 'Medan' });
    });
  });
});
