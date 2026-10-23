import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Review } from './review.entity';
import { Order, OrderStatus } from '../orders/order.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { User } from '../users/user.entity';
import { DEFAULT_RATING, ReviewsService } from './reviews.service';

const U = '00000000-0000-4000-8000-000000000001'; // caller
const O = '00000000-0000-4000-8000-000000000002'; // order
const R = '00000000-0000-4000-8000-000000000003'; // restaurant
const V = '00000000-0000-4000-8000-000000000004'; // review

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
      opts.restaurant === null ? null : opts.restaurant ?? ({ id: R, name: 'Warung', slug: 'warung', rating: 4.8, ratingCount: 0 } as Restaurant),
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
});
