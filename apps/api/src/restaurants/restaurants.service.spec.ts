import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
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

function build(
  existing: Restaurant[] = [fakeRestaurant()],
  menu?: { attachOptionGroups: jest.Mock },
  hours?: any,
) {
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
    service: new RestaurantsService(repo, cityRepo, menu as any, hours),
  };
}

describe('RestaurantsService.findOne — storefront option-group embed', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  it('embeds optionGroups on menuItems through MenuService.attachOptionGroups', async () => {
    const attach = jest.fn(async (items: any[]) =>
      items.map((i) => ({ ...i, optionGroups: [{ id: 'g1', name: 'Size' }] })),
    );
    const { service } = build(
      [fakeRestaurant({ id: ID, menuItems: [{ id: 'i1', name: 'Es Teh' } as any] })],
      { attachOptionGroups: attach },
    );

    const res = await service.findOne(ID);

    expect(attach).toHaveBeenCalledWith([{ id: 'i1', name: 'Es Teh' }]);
    expect((res as any).menuItems[0].optionGroups).toEqual([
      { id: 'g1', name: 'Size' },
    ]);
  });

  it('skips the attach for a menu-less restaurant', async () => {
    const attach = jest.fn(async (items: any[]) => items);
    const { service } = build([fakeRestaurant({ id: ID, menuItems: [] })], {
      attachOptionGroups: attach,
    });

    await service.findOne(ID);

    expect(attach).not.toHaveBeenCalled();
  });

  it('stays valid without the optional MenuService (unit harness shape)', async () => {
    const { service } = build([
      fakeRestaurant({ id: ID, menuItems: [{ id: 'i1' } as any] }),
    ]);

    const res = await service.findOne(ID);

    expect((res as any).menuItems[0].optionGroups).toBeUndefined();
  });
});

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

describe('RestaurantsService — map-pin coordinate pair (session 70)', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const owner = { sub: 'u1', role: UserRole.OWNER };

  it('create: stores a full pair verbatim', async () => {
    const { service, create } = build([]);
    await service.createForOwner('u9', {
      name: 'Peta Resto',
      latitude: -6.2088,
      longitude: 106.8456,
    } as any);
    expect(create.mock.calls[0][0]).toMatchObject({
      latitude: -6.2088,
      longitude: 106.8456,
    });
  });

  it('create: absent pair stores both null (off the map)', async () => {
    const { service, create } = build([]);
    await service.createForOwner('u9', { name: 'Tanpa Peta' } as any);
    expect(create.mock.calls[0][0]).toMatchObject({
      latitude: null,
      longitude: null,
    });
  });

  it('create: half pair is a 400 and NOTHING is written', async () => {
    const { service, create } = build([]);
    await expect(
      service.createForOwner('u9', { name: 'Setengah', latitude: -6.2 } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();

    await expect(
      service.createForOwner('u9', {
        name: 'Setengah 2',
        latitude: null,
        longitude: 106.8,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it('update: both values MOVE the pin; both explicit nulls CLEAR it', async () => {
    const { service, save } = build([
      fakeRestaurant({ ownerId: 'u1', latitude: -6.1, longitude: 106.1 }),
    ]);
    await service.updateOwned(ID, owner, {
      latitude: -7.5,
      longitude: 110,
    } as any);
    expect(save.mock.calls[0][0]).toMatchObject({
      latitude: -7.5,
      longitude: 110,
    });

    await service.updateOwned(ID, owner, {
      latitude: null,
      longitude: null,
    } as any);
    expect(save.mock.calls[1][0]).toMatchObject({
      latitude: null,
      longitude: null,
    });
  });

  it('update: half pair (or one null + one value) is a 400, never saves', async () => {
    const { service, save } = build([fakeRestaurant({ ownerId: 'u1' })]);
    for (const half of [
      { longitude: 106.8 },
      { latitude: -6.2, longitude: null },
      { latitude: null, longitude: 106.8 },
    ]) {
      await expect(service.updateOwned(ID, owner, half as any)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    expect(save).not.toHaveBeenCalled();
  });

  it('update: a no-coordinate patch leaves the pair UNTOUCHED', async () => {
    const { service, save } = build([
      fakeRestaurant({ ownerId: 'u1', latitude: -6.9, longitude: 107.6 }),
    ]);
    await service.updateOwned(ID, owner, { name: 'Renamed Only' } as any);
    const saved = save.mock.calls[0][0];
    expect(saved.latitude).toBe(-6.9);
    expect(saved.longitude).toBe(107.6);
  });
});

const SAT_NOON_WIB = new Date('2026-11-07T05:00:00Z'); // Sat 12:00 Asia/Jakarta

function hoursMock(rows: any[] = []) {
  return {
    find: jest.fn(async () => rows),
    delete: jest.fn(async () => ({ affected: rows.length })),
    create: jest.fn((x: any) => x),
    save: jest.fn(async (x: any) => x),
  };
}

describe('RestaurantsService — open-hours attach (session 68)', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const ID2 = '22222222-2222-4222-8222-222222222222';

  it('derives isOpenNow from the schedule, overriding a closed manual column', async () => {
    const hours = hoursMock([
      { restaurantId: ID, dayOfWeek: 6, opensAt: '07:00', closesAt: '23:00' },
    ]);
    const { service } = build([fakeRestaurant({ id: ID })], undefined, hours);
    const [out] = await service.attachHours(
      [fakeRestaurant({ id: ID, timeZone: 'Asia/Jakarta', isOpen: false })],
      SAT_NOON_WIB,
    );
    expect((out as any).isOpenNow).toBe(true);
    expect((out as any).hours).toHaveLength(1);
  });

  it('falls back to the legacy manual column when the restaurant has NO rows', async () => {
    const hours = hoursMock([]);
    const { service } = build([], undefined, hours);
    const [out] = await service.attachHours(
      [fakeRestaurant({ id: ID, isOpen: false })],
      SAT_NOON_WIB,
    );
    expect((out as any).isOpenNow).toBe(false);
    expect((out as any).hours).toEqual([]);
  });

  it('loads ONE batched IN query for a whole page (no N+1)', async () => {
    const hours = hoursMock([]);
    const { service } = build([], undefined, hours);
    await service.attachHours(
      [fakeRestaurant({ id: ID }), fakeRestaurant({ id: ID2 })],
      SAT_NOON_WIB,
    );
    expect(hours.find).toHaveBeenCalledTimes(1);
  });

  it('findOne and findOwned both run the attach pass', async () => {
    const hours = hoursMock([]);
    const { service } = build([fakeRestaurant({ id: ID })], undefined, hours);
    const spy = jest.spyOn(service, 'attachHours');
    await service.findOne(ID);
    expect(spy).toHaveBeenCalledTimes(1);
    await service.findOwned('u1');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('stays a no-op without the optional hours repo (unit harness shape)', async () => {
    const { service } = build([fakeRestaurant({ id: ID })]);
    const res = await service.findOne(ID);
    expect((res as any).isOpenNow).toBeUndefined();
    expect((res as any).hours).toBeUndefined();
  });
});

describe('RestaurantsService.replaceHours (session 68)', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const owner = { sub: 'u1', role: UserRole.OWNER };

  it('full replace: delete, sorted insert, timeZone write, honest view', async () => {
    const hours = hoursMock();
    const { service, save } = build([fakeRestaurant({ id: ID })], undefined, hours);
    const view = await service.replaceHours(ID, owner, {
      timeZone: 'Asia/Makassar',
      days: [
        { dayOfWeek: 3, opensAt: '09:00', closesAt: '17:00' },
        { dayOfWeek: 1, opensAt: '08:00', closesAt: '22:00' },
      ],
    } as any);
    expect(hours.delete).toHaveBeenCalledWith({ restaurantId: ID });
    expect(view.days.map((d) => d.dayOfWeek)).toEqual([1, 3]);
    expect(view.restaurantId).toBe(ID);
    expect(typeof view.isOpenNow).toBe('boolean');
    // The IANA zone was persisted through the restaurant repo.
    expect(save).toHaveBeenCalled();
    expect(save.mock.calls[0][0]).toMatchObject({ timeZone: 'Asia/Makassar' });
  });

  it('omitted timeZone keeps the stored zone (no entity save)', async () => {
    const hours = hoursMock();
    const { service, save } = build(
      [fakeRestaurant({ id: ID, timeZone: 'UTC' })],
      undefined,
      hours,
    );
    const view = await service.replaceHours(ID, owner, {
      days: [{ dayOfWeek: 2, opensAt: '10:00', closesAt: '20:00' }],
    } as any);
    expect(save).not.toHaveBeenCalled();
    expect(view.timeZone).toBe('UTC');
  });

  it('empty days CLEARS the schedule and the status falls back to the manual column', async () => {
    const hours = hoursMock();
    const { service } = build(
      [fakeRestaurant({ id: ID, isOpen: false })],
      undefined,
      hours,
    );
    const view = await service.replaceHours(ID, owner, { days: [] } as any);
    expect(hours.delete).toHaveBeenCalled();
    expect(hours.save).not.toHaveBeenCalled();
    expect(view.days).toEqual([]);
    expect(view.isOpenNow).toBe(false); // manual column, deterministic
  });

  it('rejects a duplicate weekday and an empty window', async () => {
    const hours = hoursMock();
    const { service } = build([fakeRestaurant({ id: ID })], undefined, hours);
    await expect(
      service.replaceHours(ID, owner, {
        days: [
          { dayOfWeek: 1, opensAt: '08:00', closesAt: '12:00' },
          { dayOfWeek: 1, opensAt: '13:00', closesAt: '22:00' },
        ],
      } as any),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.replaceHours(ID, owner, {
        days: [{ dayOfWeek: 1, opensAt: '08:00', closesAt: '08:00' }],
      } as any),
    ).rejects.toThrow(/must differ/);
    expect(hours.delete).not.toHaveBeenCalled();
  });

  it('rejects a bogus IANA zone before touching anything', async () => {
    const hours = hoursMock();
    const { service } = build([fakeRestaurant({ id: ID })], undefined, hours);
    await expect(
      service.replaceHours(ID, owner, {
        timeZone: 'Mars/Olympus',
        days: [{ dayOfWeek: 1, opensAt: '08:00', closesAt: '22:00' }],
      } as any),
    ).rejects.toThrow(/valid IANA zone/);
    expect(hours.delete).not.toHaveBeenCalled();
    expect(hours.save).not.toHaveBeenCalled();
  });

  it('ownership rules mirror updateOwned: 403 foreign owner, 404 unknown, 404 malformed, admin bypasses', async () => {
    const hours = hoursMock();
    const days = [{ dayOfWeek: 1, opensAt: '08:00', closesAt: '22:00' }];
    const { service } = build(
      [fakeRestaurant({ id: ID, ownerId: 'someone-else' })],
      undefined,
      hours,
    );
    await expect(service.replaceHours(ID, owner, { days } as any)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(
      service.replaceHours('33333333-3333-4333-8333-333333333333', owner, { days } as any),
    ).rejects.toThrow(NotFoundException);
    await expect(service.replaceHours('not-a-uuid', owner, { days } as any)).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      service.replaceHours(ID, { sub: 'someone-else', role: UserRole.ADMIN }, { days } as any),
    ).resolves.toMatchObject({ restaurantId: ID });
  });
});
