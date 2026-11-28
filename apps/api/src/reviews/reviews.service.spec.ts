import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Review } from './review.entity';
import { Order, OrderStatus } from '../orders/order.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { User, UserRole } from '../users/user.entity';
import { DEFAULT_RATING, ReviewsService } from './reviews.service';

const U = '00000000-0000-4000-8000-000000000001'; // caller
const O = '00000000-0000-4000-8000-000000000002'; // order
const R = '00000000-0000-4000-8000-000000000003'; // restaurant
const V = '00000000-0000-4000-8000-000000000004'; // review
const OWN = '00000000-0000-4000-8000-000000000005'; // owner of restaurant R
const ADM = '00000000-0000-4000-8000-000000000006'; // platform admin
const owner = { sub: OWN, role: UserRole.OWNER };
const admin = { sub: ADM, role: UserRole.ADMIN };

function fakeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: O,
    code: 'FO-TEST1',
    userId: U,
    restaurantId: R,
    status: OrderStatus.COMPLETED,
    ...overrides,
  } as Order;
}

function fakeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: V,
    orderId: O,
    restaurantId: R,
    userId: U,
    rating: 4,
    comment: 'Good',
    reply: null,
    repliedAt: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    order: fakeOrder(),
    restaurant: { id: R, name: 'Warung', slug: 'warung' } as Restaurant,
    user: { id: U, name: 'Tester' } as User,
    ...overrides,
  } as Review;
}

interface BuildOpts {
  /** Review row the duplicate-check / post-insert findOne answers. */
  review?: Review | null;
  /** Rows for find/findAndCount. */
  rows?: Review[];
  totalCount?: number;
  restaurant?: Restaurant | null;
  /** Stats row the aggregate recompute query returns. */
  stats?: { rating: number | string; count: number | string };
  insertThrows?: unknown;
}

function build(order: Order | null, opts: BuildOpts = {}) {
  const update = jest.fn(async () => ({ affected: 1 }));
  const query = jest.fn(
    async (_sql: string, _params: unknown[]): Promise<Array<{ rating: number | string; count: number | string }>> => [
      opts.stats ?? { rating: DEFAULT_RATING, count: 0 },
    ],
  );
  const insert = jest.fn(async () => {
    if (opts.insertThrows) throw opts.insertThrows;
    return { identifiers: [{ id: V }], generatedMaps: [], raw: undefined };
  });
  const save = jest.fn(async (r: Review) => r);
  const del = jest.fn(async () => ({ affected: 1 }));
  // findOne answers the duplicate check / ownership read. Tests that need a
  // two-phase response (dup-check null, then read-back) override this mock.
  const findOne = jest.fn(async () => opts.review ?? null);
  const reviewsRepo: any = { findOne, findOneOrFail: jest.fn(async () => opts.review ?? fakeReview()),
    insert, save, delete: del, query, update,
    find: jest.fn(async () => opts.rows ?? []),
    findAndCount: jest.fn(async () => [opts.rows ?? [], opts.totalCount ?? 0]) };
  const ordersRepo: any = { findOne: jest.fn(async () => order) };
  const restaurantsRepo: any = {
    findOne: jest.fn(async () =>
      opts.restaurant === null ? null : opts.restaurant ?? ({ id: R, name: 'Warung', slug: 'warung', rating: 4.8, ratingCount: 0, ownerId: OWN } as Restaurant),
    ),
    update: jest.fn(async () => ({ affected: 1 })),
  };
  const service = new ReviewsService(reviewsRepo, ordersRepo, restaurantsRepo);
  return { service, reviewsRepo, ordersRepo, restaurantsRepo, findOne, insert, save, del, query };
}

describe('ReviewsService', () => {
  describe('create', () => {
    it('404s when the order does not exist', async () => {
      const h = build(null);
      await expect(
        h.service.create(U, { orderId: O, rating: 5 } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(h.insert).not.toHaveBeenCalled();
    });

    it("404s (not 403) for someone else's order — existence is not leaked", async () => {
      const h = build(fakeOrder({ userId: 'other-user' }));
      await expect(
        h.service.create(U, { orderId: O, rating: 5 } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(h.insert).not.toHaveBeenCalled();
    });

    it('400s for a not-completed order', async () => {
      const h = build(fakeOrder({ status: OrderStatus.DELIVERING }));
      await expect(
        h.service.create(U, { orderId: O, rating: 5 } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(h.insert).not.toHaveBeenCalled();
    });

    it('409s when the order was already reviewed', async () => {
      const h = build(fakeOrder(), { review: fakeReview() });
      await expect(
        h.service.create(U, { orderId: O, rating: 5 } as any),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(h.insert).not.toHaveBeenCalled();
    });

    it('maps the unique-violation race to the same 409', async () => {
      const err = Object.assign(new Error('duplicate key'), { code: '23505' });
      const h = build(fakeOrder(), { review: null, insertThrows: err });
      await expect(
        h.service.create(U, { orderId: O, rating: 5 } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rethrows non-unique insert errors untouched', async () => {
      const err = Object.assign(new Error('connection lost'), { code: '08006' });
      const h = build(fakeOrder(), { review: null, insertThrows: err });
      await expect(h.service.create(U, { orderId: O, rating: 5 } as any)).rejects.toBe(err);
    });

    it('inserts under order-derived ids (body restaurant/user values cannot win) and recomputes', async () => {
      const row = fakeReview({ rating: 5, comment: 'Great' });
      const h = build(fakeOrder(), { review: null, stats: { rating: 4.75, count: 4 } });
      // second findOne (post-insert read-back) answers the stored row
      let calls = 0;
      h.findOne.mockImplementation(async () => (++calls === 1 ? null : row));
      const res = await h.service.create(U, {
        orderId: O,
        rating: 5,
        comment: 'Great',
      } as any);

      expect(h.insert).toHaveBeenCalledWith({
        orderId: O,
        restaurantId: R,
        userId: U,
        rating: 5,
        comment: 'Great',
      });
      expect(h.query).toHaveBeenCalledWith(expect.stringContaining('AVG(rating)'), [R, DEFAULT_RATING]);
      expect(h.restaurantsRepo.update).toHaveBeenCalledWith({ id: R }, { rating: 4.75, ratingCount: 4 });
      expect(res.restaurant).toEqual({ rating: 4.75, ratingCount: 4 });
      expect(res.review).toEqual({
        id: V,
        orderId: O,
        orderCode: 'FO-TEST1',
        restaurantId: R,
        restaurantName: 'Warung',
        restaurantSlug: 'warung',
        reviewerName: 'Tester',
        rating: 5,
        comment: 'Great',
        // A brand-new review never carries a reply thread.
        reply: null,
        repliedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
    });

    it('defaults a missing comment to null on the row', async () => {
      const h = build(fakeOrder(), { review: null });
      let calls = 0;
      h.findOne.mockImplementation(async () => (++calls === 1 ? null : fakeReview({ comment: null })));
      await h.service.create(U, { orderId: O, rating: 2 } as any);
      expect(h.insert).toHaveBeenCalledWith(expect.objectContaining({ comment: null }));
    });
  });

  describe('listMine', () => {
    it('reads newest-first for the caller and flattens the rows', async () => {
      const h = build(null, { rows: [fakeReview()] });
      const res = await h.service.listMine(U);
      expect(h.reviewsRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: U }, order: { createdAt: 'DESC' } }),
      );
      expect(res.total).toBe(1);
      expect(res.items[0].orderCode).toBe('FO-TEST1');
      expect(res.items[0].reviewerName).toBe('Tester');
    });
  });

  describe('listForRestaurant', () => {
    it('404s on a malformed id without touching the DB', async () => {
      const h = build(null);
      await expect(h.service.listForRestaurant('garbage')).rejects.toBeInstanceOf(NotFoundException);
      expect(h.restaurantsRepo.findOne).not.toHaveBeenCalled();
    });

    it('404s for an unknown restaurant', async () => {
      const h = build(null, { restaurant: null });
      await expect(h.service.listForRestaurant(R)).rejects.toBeInstanceOf(NotFoundException);
    });

    // Session 87 sweep: this public route has NO DTO in front — raw
    // query-string values land on the service. `?page=1e30` used to bind
    // an OFFSET past bigint (22001/22P02 → 500); non-finite/fractional
    // shapes joined. All of it now lands on the closed range.
    it.each([
      // [page, limit, wantPage, wantLimit] — skip/take echo the pair
      ['1e30', '500', 100_000, 50],
      ['Infinity', '-Infinity', 1, 20],
      ['2.5', '2.5', 3, 3],
      ['abc', '1;DROP', 1, 20],
      ['', '', 1, 20],
      ['0', '0.4', 1, 1],
    ] as const)('hostile page=%s limit=%s clamps to (%i, %i)', async (page, limit, wantPage, wantLimit) => {
      const h = build(null, { rows: [], totalCount: 0 });
      const res = await h.service.listForRestaurant(R, page as any, limit as any);
      const args = (h.reviewsRepo.findAndCount as jest.Mock).mock.calls[0][0];
      expect(res.page).toBe(wantPage);
      expect(res.limit).toBe(wantLimit);
      expect(args.skip).toBe((wantPage - 1) * wantLimit);
      expect(args.take).toBe(wantLimit);
      expect(Number.isSafeInteger(args.skip)).toBe(true);
    });

    it('embeds the reply thread on every public feed row', async () => {
      const repliedAt = new Date('2026-11-03T00:00:00Z');
      const h = build(null, {
        rows: [fakeReview({ reply: 'Glad you liked it!', repliedAt })],
        totalCount: 1,
      });
      const res = await h.service.listForRestaurant(R);
      expect(res.items[0].reply).toBe('Glad you liked it!');
      expect(res.items[0].repliedAt).toBe(repliedAt);
    });

    it('returns the page envelope with the restaurant rating summary and clamped paging', async () => {
      const h = build(null, { rows: [fakeReview()], totalCount: 7 });
      const res = await h.service.listForRestaurant(R, 0, 500);
      expect(h.reviewsRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { restaurantId: R },
          order: { createdAt: 'DESC' },
          skip: 0,
          take: 50,
        }),
      );
      expect(res).toEqual({
        items: [expect.objectContaining({ id: V, reviewerName: 'Tester' })],
        total: 7,
        page: 1,
        limit: 50,
        rating: 4.8,
        ratingCount: 0,
      });
    });
  });

  describe('update', () => {
    it('404s on a malformed id before any read', async () => {
      const h = build(null);
      await expect(h.service.update(U, 'nope', { rating: 5 } as any)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(h.findOne).not.toHaveBeenCalled();
    });

    it('404s when the review is not the caller\'s', async () => {
      const h = build(null, { review: null });
      await expect(h.service.update(U, V, { rating: 5 } as any)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('400s an empty patch — never a silent no-op success', async () => {
      const h = build(null, { review: fakeReview() });
      await expect(h.service.update(U, V, {} as any)).rejects.toBeInstanceOf(BadRequestException);
      expect(h.save).not.toHaveBeenCalled();
    });

    it('applies the rating, keeps the untouched comment, and recomputes', async () => {
      const existing = fakeReview({ rating: 2, comment: 'Meh' });
      const h = build(null, { review: existing, stats: { rating: 3.5, count: 2 } });
      const res = await h.service.update(U, V, { rating: 5 } as any);
      expect(h.save).toHaveBeenCalled();
      expect((h.save.mock.calls[0][0] as Review).rating).toBe(5);
      expect((h.save.mock.calls[0][0] as Review).comment).toBe('Meh');
      expect(res.restaurant).toEqual({ rating: 3.5, ratingCount: 2 });
      expect(h.restaurantsRepo.update).toHaveBeenCalledWith({ id: R }, { rating: 3.5, ratingCount: 2 });
    });

    it('clears the comment on an explicit null', async () => {
      const existing = fakeReview({ comment: 'Old text' });
      const h = build(null, { review: existing });
      await h.service.update(U, V, { comment: null } as any);
      expect((h.save.mock.calls[0][0] as Review).comment).toBeNull();
    });
  });

  describe('remove', () => {
    it('is idempotent: malformed id answers removed:false without touching the DB', async () => {
      const h = build(null);
      const res = await h.service.remove(U, 'not-a-uuid');
      expect(res).toEqual({ removed: false });
      expect(h.del).not.toHaveBeenCalled();
      expect(h.query).not.toHaveBeenCalled();
    });

    it('unknown/foreign review answers removed:false and recomputes nothing', async () => {
      const h = build(null, { review: null });
      expect(await h.service.remove(U, V)).toEqual({ removed: false });
      expect(h.del).not.toHaveBeenCalled();
    });

    it('deletes the row and recomputes the restaurant rating', async () => {
      const h = build(null, { review: fakeReview(), stats: { rating: DEFAULT_RATING, count: 0 } });
      const res = await h.service.remove(U, V);
      expect(h.del).toHaveBeenCalledWith({ id: V });
      expect(res.removed).toBe(true);
      expect(res.restaurant).toEqual({ rating: DEFAULT_RATING, ratingCount: 0 });
    });
  });

  describe('recomputeRating', () => {
    it('coerces pg string numerics to numbers for both fields', async () => {
      const h = build(null, { stats: { rating: '4.33', count: '3' } });
      const res = await h.service.recomputeRating(R);
      expect(res).toEqual({ rating: 4.33, ratingCount: 3 });
      expect(h.restaurantsRepo.update).toHaveBeenCalledWith({ id: R }, { rating: 4.33, ratingCount: 3 });
    });

    it('falls back to the platform default in the SQL itself when no reviews remain', async () => {
      const h = build(null);
      const res = await h.service.recomputeRating(R);
      expect(h.query.mock.calls[0][1]).toEqual([R, DEFAULT_RATING]);
      expect(res.rating).toBe(DEFAULT_RATING);
      expect(res.ratingCount).toBe(0);
    });
  });

  describe('setReply', () => {
    it('404s on a malformed id before any read', async () => {
      const h = build(null);
      await expect(h.service.setReply(owner, 'nope', { reply: 'Hi' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(h.findOne).not.toHaveBeenCalled();
    });

    it('404s when the review does not exist', async () => {
      const h = build(null, { review: null });
      await expect(h.service.setReply(owner, V, { reply: 'Hi' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('403s an owner of a DIFFERENT restaurant (404 would only pretend: the feed is public)', async () => {
      const h = build(null, { review: fakeReview(), restaurant: { id: R, ownerId: U } as Restaurant });
      await expect(h.service.setReply(owner, V, { reply: 'Hi' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(h.save).not.toHaveBeenCalled();
    });

    it('403s when the restaurant has NO owner (platform-seeded rows are admin-only)', async () => {
      const h = build(null, { review: fakeReview(), restaurant: { id: R, ownerId: null } as Restaurant });
      await expect(h.service.setReply(owner, V, { reply: 'Hi' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('writes the trimmed reply + repliedAt and NEVER recomputes the rating', async () => {
      const existing = fakeReview();
      const h = build(null, { review: existing });
      const res = await h.service.setReply(owner, V, { reply: '  Thanks for the kind words!  ' });
      const saved = h.save.mock.calls[0][0] as Review;
      expect(saved.reply).toBe('Thanks for the kind words!');
      expect(saved.repliedAt).toBeInstanceOf(Date);
      // Reply changes no stars: no aggregate query, no restaurant UPDATE.
      expect(h.query).not.toHaveBeenCalled();
      expect(h.restaurantsRepo.update).not.toHaveBeenCalled();
      expect(res.review.reply).toBe('Thanks for the kind words!');
      expect(res.review.repliedAt).toBeInstanceOf(Date);
    });

    it('REPLACES the single thread on a second reply (no history rows)', async () => {
      const existing = fakeReview({ reply: 'First answer', repliedAt: new Date('2026-11-01T00:00:00Z') });
      const h = build(null, { review: existing });
      await h.service.setReply(owner, V, { reply: 'Updated answer' });
      expect(h.save).toHaveBeenCalledTimes(1);
      const saved = h.save.mock.calls[0][0] as Review;
      expect(saved.reply).toBe('Updated answer');
    });

    it('400s whitespace-only text — an invisible response card is a lie', async () => {
      const existing = fakeReview();
      const h = build(null, { review: existing });
      for (const bad of ['', '   ', '\n\t ']) {
        await expect(h.service.setReply(owner, V, { reply: bad })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
      expect(h.save).not.toHaveBeenCalled();
    });

    it('ADMIN bypasses restaurant ownership WITHOUT reading the restaurant', async () => {
      const existing = fakeReview();
      const h = build(null, { review: existing, restaurant: { id: R, ownerId: null } as Restaurant });
      const res = await h.service.setReply(admin, V, { reply: 'Platform apology' });
      expect(res.review.reply).toBe('Platform apology');
      // The admin path short-circuits the ownership lookup entirely.
      expect(h.restaurantsRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('clearReply', () => {
    it('nulls BOTH reply and repliedAt together (CHECK pairing)', async () => {
      const existing = fakeReview({
        reply: 'Thanks!',
        repliedAt: new Date('2026-11-02T00:00:00Z'),
      });
      const h = build(null, { review: existing });
      const res = await h.service.clearReply(owner, V);
      const saved = h.save.mock.calls[0][0] as Review;
      expect(saved.reply).toBeNull();
      expect(saved.repliedAt).toBeNull();
      expect(res.review.reply).toBeNull();
      expect(res.review.repliedAt).toBeNull();
    });

    it('idempotent: clearing an unreplied review WRITES NOTHING and still answers the row', async () => {
      const existing = fakeReview({ reply: null, repliedAt: null });
      const h = build(null, { review: existing });
      const res = await h.service.clearReply(owner, V);
      expect(h.save).not.toHaveBeenCalled();
      expect(res.review.reply).toBeNull();
    });

    it('same access ladder as setReply: 404 unknown, 403 foreign restaurant', async () => {
      const h1 = build(null, { review: null });
      await expect(h1.service.clearReply(owner, V)).rejects.toBeInstanceOf(NotFoundException);
      const h2 = build(null, {
        review: fakeReview(),
        restaurant: { id: R, ownerId: U } as Restaurant,
      });
      await expect(h2.service.clearReply(owner, V)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('eager-relation read shape (session 146 perf contract)', () => {
    it('create reads the ORDER join-free and re-reads the row WITHOUT nested items', async () => {
      const h = build(fakeOrder(), { review: null });
      let calls = 0;
      h.findOne.mockImplementation(async () => (++calls === 1 ? null : fakeReview()));
      await h.service.create(U, { orderId: O, rating: 5 } as any);
      expect(h.ordersRepo.findOne).toHaveBeenCalledWith({
        where: { id: O },
        loadEagerRelations: false,
      });
      // post-insert read-back keeps the explicit relations but drops the
      // NESTED Order.items ride (toReviewRow only needs order.code).
      expect(h.findOne).toHaveBeenLastCalledWith({
        where: { orderId: O },
        relations: { order: true, restaurant: true, user: true },
        loadEagerRelations: false,
      });
    });

    it('listMine and the public feed both opt out of the nested eager join', async () => {
      const h = build(null, { rows: [fakeReview()], totalCount: 1 });
      await h.service.listMine(U);
      expect(h.reviewsRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ loadEagerRelations: false }),
      );
      await h.service.listForRestaurant(R);
      const args = (h.reviewsRepo.findAndCount as jest.Mock).mock.calls[0][0];
      expect(args.loadEagerRelations).toBe(false);
      expect(args.relations).toEqual({ order: true, user: true });
    });

    it('withRelations (write-path read-backs) opts out too', async () => {
      const h = build(null, { review: fakeReview() });
      const findOneOrFail = h.reviewsRepo.findOneOrFail as jest.Mock;
      findOneOrFail.mockResolvedValue(fakeReview());
      await h.service.update(U, V, { rating: 4 } as any);
      expect(findOneOrFail).toHaveBeenCalledWith({
        where: { id: V },
        relations: { order: true, restaurant: true, user: true },
        loadEagerRelations: false,
      });
    });
  });
});
