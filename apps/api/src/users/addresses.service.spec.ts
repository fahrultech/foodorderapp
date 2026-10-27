import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  MAX_ADDRESSES,
  AddressesService,
} from './addresses.service';
import { DeliveryAddress } from './delivery-address.entity';

const USER_ID = 'u1';
const createDto = (over: Record<string, unknown> = {}) =>
  ({
    label: 'Home',
    recipientName: 'Ada Lovelace',
    phone: '+62 812 3456 7890',
    address: 'Jl. Sudirman No. 1, Jakarta',
    ...over,
  }) as any;

let seq = 0;
/** The real column is uuid; shape-guards in the service require
 *  the fakes to look like one too (12-hex tail with a per-row counter). */
const rowId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fakeRow(overrides: Partial<DeliveryAddress> = {}): DeliveryAddress {
  seq += 1;
  return {
    id: rowId(seq),
    userId: USER_ID,
    label: 'Home',
    recipientName: 'Ada Lovelace',
    phone: '+62 812 3456 7890',
    address: 'Jl. Sudirman No. 1, Jakarta',
    isDefault: false,
    createdAt: new Date(1_700_000_000_000 + seq),
    updatedAt: new Date(1_700_000_000_000 + seq),
    ...overrides,
  } as DeliveryAddress;
}

/**
 * Stateful repo double over an in-memory row list: find/findOne honour
 * `where` + `order` for the shapes the service actually uses, update/
 * delete/save mutate the list, count reads it. This exercises the
 * exactly-one-default invariant across create/promote/delete, not just
 * single-call argument passing.
 */
function build(rows: DeliveryAddress[] = []) {
  const live = [...rows];
  const repo: any = {
    find: jest.fn(async ({ where, order }: any) =>
      live
        .filter((r) => r.userId === where.userId)
        .sort((a, b) =>
          order?.isDefault === 'DESC'
            ? Number(b.isDefault) - Number(a.isDefault) ||
              a.createdAt.getTime() - b.createdAt.getTime()
            : 0,
        ),
    ),
    findOne: jest.fn(async ({ where, order }: any) => {
      const cands = live.filter(
        (r) =>
          r.userId === where.userId &&
          (!where.id || r.id === where.id) &&
          (where.isDefault === undefined || r.isDefault === where.isDefault),
      );
      if (order?.createdAt === 'ASC') {
        return cands.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;
      }
      return cands[0] ?? null;
    }),
    count: jest.fn(async ({ where }: any) => live.filter((r) => r.userId === where.userId).length),
    create: jest.fn((x: any) => ({ id: rowId(1000 + ++seq), ...x })),
    save: jest.fn(async (x: DeliveryAddress) => {
      if (!x.id) x.id = rowId(2000 + ++seq);
      live.push(x);
      return x;
    }),
    update: jest.fn(async (criteria: any, patch: any) => {
      const touched = live.filter(
        (r) =>
          r.userId === criteria.userId &&
          (!criteria.id || r.id === criteria.id) &&
          (criteria.isDefault === undefined || r.isDefault === criteria.isDefault),
      );
      touched.forEach((r) => Object.assign(r, patch));
      return { affected: touched.length };
    }),
    delete: jest.fn(async (criteria: any) => {
      const before = live.length;
      for (let i = live.length - 1; i >= 0; i--) {
        const r = live[i];
        if (r.userId === criteria.userId && (!criteria.id || r.id === criteria.id)) {
          live.splice(i, 1);
        }
      }
      return { affected: before - live.length };
    }),
  };
  return { repo, live, service: new AddressesService(repo) };
}

describe('AddressesService.list', () => {
  it('scopes by caller and orders default-first, oldest-added next', async () => {
    const h = build([
      fakeRow({ label: 'Old' }),
      fakeRow({ label: 'Home', isDefault: true }),
    ]);
    const res = await h.service.list(USER_ID);
    expect(h.repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID },
        order: { isDefault: 'DESC', createdAt: 'ASC' },
      }),
    );
    expect(res.total).toBe(2);
    expect(res.items.map((r) => r.label)).toEqual(['Home', 'Old']);
  });
});

describe('AddressesService.create', () => {
  it('forces the FIRST address to be the default even if the client said no', async () => {
    const h = build();
    const { item } = await h.service.create(USER_ID, createDto({ isDefault: false }));
    expect(item.isDefault).toBe(true);
  });

  it('a later address stays non-default unless it asks to promote', async () => {
    const h = build([fakeRow({ isDefault: true })]);
    const { item } = await h.service.create(USER_ID, createDto({ label: 'Office' }));
    expect(item.isDefault).toBe(false);
    expect(h.repo.update).not.toHaveBeenCalled();

    const h2 = build([fakeRow({ isDefault: true })]);
    const promoted = await h2.service.create(USER_ID, createDto({ label: 'Office', isDefault: true }));
    expect(promoted.item.isDefault).toBe(true);
    expect(h2.live.find((r) => r.label === 'Home')!.isDefault).toBe(false);
  });

  it('caps the book at MAX_ADDRESSES with a 400', async () => {
    const many = Array.from({ length: MAX_ADDRESSES }, (_, i) =>
      fakeRow({ isDefault: i === 0 }),
    );
    const h = build(many);
    await expect(h.service.create(USER_ID, createDto())).rejects.toBeInstanceOf(BadRequestException);
    expect(h.repo.save).not.toHaveBeenCalled();
  });

  it('trims whitespace before storing', async () => {
    const h = build();
    const { item } = await h.service.create(
      USER_ID,
      createDto({ label: '  Home ', address: '  Jl. Test 9 ' }),
    );
    expect(item.label).toBe('Home');
    expect(item.address).toBe('Jl. Test 9');
  });
});

describe('AddressesService.update', () => {
  it('rejects an empty patch with 400 (same convention as PATCH /users/me)', async () => {
    const h = build([fakeRow()]);
    await expect(h.service.update(USER_ID, 'a1', {})).rejects.toBeInstanceOf(BadRequestException);
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('404s for a foreign id without distinguishing it from a typo', async () => {
    const h = build([fakeRow({ userId: 'victim' })]);
    await expect(h.service.update(USER_ID, 'a1', { label: 'Mine' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('applies only the provided fields', async () => {
    const row = fakeRow();
    const h = build([row]);
    const { item } = await h.service.update(USER_ID, row.id, { label: 'Casa' });
    expect(item.label).toBe('Casa');
    expect(item.address).toBe('Jl. Sudirman No. 1, Jakarta'); // untouched
  });
});

describe('AddressesService.remove', () => {
  it('is idempotent: unknown/foreign id answers removed:false, never 404', async () => {
    const h = build([fakeRow({ userId: 'victim' })]);
    expect(await h.service.remove(USER_ID, 'nope')).toEqual({ removed: false });
    expect(h.repo.delete).not.toHaveBeenCalled();
  });

  it('a non-default delete touches nothing else', async () => {
    const keep = fakeRow({ isDefault: true });
    const gone = fakeRow({ label: 'Office' });
    const h = build([keep, gone]);
    const res = await h.service.remove(USER_ID, gone.id);
    expect(res).toEqual({ removed: true });
    expect(keep.isDefault).toBe(true);
  });

  it('deleting the default promotes the oldest survivor and names it', async () => {
    const oldest = fakeRow({ label: 'Oldest' });
    const newer = fakeRow({ label: 'Newer' });
    const home = fakeRow({ label: 'Home', isDefault: true });
    const h = build([oldest, newer, home]);
    const res = await h.service.remove(USER_ID, home.id);
    expect(res.removed).toBe(true);
    expect(res.promotedDefaultId).toBe(oldest.id);
    expect(oldest.isDefault).toBe(true);
    expect(newer.isDefault).toBe(false);
  });

  it('deleting the only address leaves an empty book, no promotion', async () => {
    const only = fakeRow({ isDefault: true });
    const h = build([only]);
    const res = await h.service.remove(USER_ID, only.id);
    expect(res).toEqual({ removed: true });
    expect(h.live).toHaveLength(0);
  });
});

describe('AddressesService.setDefault', () => {
  it('404s for unknown/foreign ids', async () => {
    const h = build([fakeRow({ userId: 'victim' })]);
    await expect(h.service.setDefault(USER_ID, 'a1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('re-promoting the current default is a no-op', async () => {
    const home = fakeRow({ isDefault: true });
    const h = build([home]);
    const res = await h.service.setDefault(USER_ID, home.id);
    expect(res.alreadyDefault).toBe(true);
    expect(h.repo.update).not.toHaveBeenCalled();
  });

  it('promoting demotes the previous default — exactly one stays set', async () => {
    const home = fakeRow({ label: 'Home', isDefault: true });
    const office = fakeRow({ label: 'Office' });
    const h = build([home, office]);
    const res = await h.service.setDefault(USER_ID, office.id);
    expect(res.alreadyDefault).toBe(false);
    expect(res.item.isDefault).toBe(true);
    expect(home.isDefault).toBe(false);
    expect(h.live.filter((r) => r.isDefault)).toHaveLength(1);
  });

  it('getOwned 404s when the row is absent for that user', async () => {
    const h = build();
    await expect(h.service.getOwned(USER_ID, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AddressesService — malformed uuid guards (route pipe 400s over HTTP)', () => {
  const BAD = 'not-a-uuid';

  it('update rejects junk ids AFTER dto-shape checks, before any repo write', async () => {
    const { repo, service } = build();
    await expect(service.update(USER_ID, BAD, { label: 'X' } as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.update).not.toHaveBeenCalled();
    // The empty-patch 400 still takes precedence over the shape guard.
    await expect(service.update(USER_ID, BAD, {} as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('remove answers removed:false for junk ids without touching the DB', async () => {
    const { repo, service } = build();
    await expect(service.remove(USER_ID, BAD)).resolves.toEqual({ removed: false });
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('setDefault short-circuits junk ids to 404 (via getOwned guard)', async () => {
    const { repo, service } = build();
    await expect(service.setDefault(USER_ID, BAD)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.update).not.toHaveBeenCalled();
  });
});
