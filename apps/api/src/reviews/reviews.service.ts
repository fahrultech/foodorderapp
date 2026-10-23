import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Review } from './review.entity';
import { Order, OrderStatus } from '../orders/order.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { CreateReviewDto } from './dto/create-review.dto';
import { UpdateReviewDto } from './dto/update-review.dto';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../orders/dto/list-my-orders.dto';
import { isUuid } from '../common/uuid';

/**
 * Platform-default rating for restaurants with zero reviews — must stay in
 * sync with the `restaurants.rating` column default (seeded restaurants show
 * their curated seed value until their FIRST review lands; once all reviews
 * are deleted the rating resets to this neutral default, never a stale
 * average of rows that no longer exist).
 */
export const DEFAULT_RATING = 4.5;

/** Client-facing review row: order + restaurant identity + reviewer name. */
export interface ReviewRow {
  id: string;
  orderId: string;
  orderCode: string;
  restaurantId: string;
  restaurantName: string;
  restaurantSlug: string;
  reviewerName: string;
  rating: number;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The recomputed rating summary returned after every review write. */
export interface RestaurantRating {
  rating: number;
  ratingCount: number;
}

/** Postgres unique-violation discriminator (concurrent double-submit race). */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as any)?.code ?? (err as any)?.driverError?.code;
  return code === '23505';
}

function toReviewRow(r: Review): ReviewRow {
  return {
    id: r.id,
    orderId: r.orderId,
    orderCode: r.order?.code ?? '',
    restaurantId: r.restaurantId,
    restaurantName: r.restaurant?.name ?? 'Restaurant',
    restaurantSlug: r.restaurant?.slug ?? '',
    reviewerName: r.user?.name ?? 'Diner',
    rating: r.rating,
    comment: r.comment ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Customer reviews of completed orders (Phase 3). Rules the service owns:
 *
 * - A review belongs to ONE order and its author is that order's customer:
 *   unknown order, someone else's order and a malformed id are all the same
 *   404 — existence of another user's order is never leaked (same contract
 *   as customer order cancellation).
 * - Only `completed` orders can be reviewed; every other status is a 400.
 * - One review per order — pre-checked, and the unique index plus a 23505
 *   catch closes the double-submit race with the same 409.
 * - `restaurantId`/`userId` on the row are copied from the order, never from
 *   the request body (whitelist strips the rest anyway).
 * - EVERY review insert/update/delete recomputes the restaurant's server-side
 *   rating (`recomputeRating`) — clients can never write `restaurant.rating`.
 */
@Injectable()
export class ReviewsService {
  constructor(
    @InjectRepository(Review) private readonly reviews: Repository<Review>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(Restaurant) private readonly restaurants: Repository<Restaurant>,
  ) {}

  /** Full review row (order+restaurant+user loaded) after any write. */
  private async withRelations(id: string): Promise<Review> {
    return this.reviews.findOneOrFail({
      where: { id },
      relations: { order: true, restaurant: true, user: true },
    });
  }

  async create(userId: string, dto: CreateReviewDto): Promise<{ review: ReviewRow; restaurant: RestaurantRating }> {
    const order = await this.orders.findOne({ where: { id: dto.orderId } });
    if (!order || order.userId !== userId) {
      throw new NotFoundException('Order not found');
    }
    if (order.status !== OrderStatus.COMPLETED) {
      throw new BadRequestException(
        `You can only review completed orders (this one is: ${order.status})`,
      );
    }
    const existing = await this.reviews.findOne({ where: { orderId: order.id } });
    if (existing) {
      throw new ConflictException('This order has already been reviewed');
    }

    try {
      await this.reviews.insert({
        orderId: order.id,
        restaurantId: order.restaurantId,
        userId,
        rating: dto.rating,
        comment: dto.comment ?? null,
      });
    } catch (err) {
      // Lost a race against an identical concurrent submit — same 409.
      if (!isUniqueViolation(err)) throw err;
      throw new ConflictException('This order has already been reviewed');
    }

    const row = await this.reviews.findOne({
      where: { orderId: order.id },
      relations: { order: true, restaurant: true, user: true },
    });
    if (!row) throw new NotFoundException('Review not found after insert');
    const restaurant = await this.recomputeRating(order.restaurantId);
    return { review: toReviewRow(row), restaurant };
  }

  /** Every review the caller wrote, newest first. */
  async listMine(userId: string): Promise<{ items: ReviewRow[]; total: number }> {
    const rows = await this.reviews.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      relations: { order: true, restaurant: true, user: true },
    });
    const items = rows.map(toReviewRow);
    return { items, total: items.length };
  }

  /**
   * Public review feed for one restaurant, newest first, standard page
   * envelope + the current recomputed rating summary (restaurant pages render
   * it next to the star badge). Unknown/malformed restaurant id -> 404, same
   * screening rule as every other uuid param.
   */
  async listForRestaurant(
    restaurantId: string,
    page = 1,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<{
    items: ReviewRow[];
    total: number;
    page: number;
    limit: number;
    rating: number;
    ratingCount: number;
  }> {
    if (!isUuid(restaurantId)) throw new NotFoundException('Restaurant not found');
    const restaurant = await this.restaurants.findOne({ where: { id: restaurantId } });
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    const pageN = Math.max(1, Number(page) || 1);
    const limitN = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limit) || DEFAULT_PAGE_SIZE));
    const [rows, total] = await this.reviews.findAndCount({
      where: { restaurantId },
      order: { createdAt: 'DESC' },
      relations: { order: true, user: true },
      skip: (pageN - 1) * limitN,
      take: limitN,
    });
    return {
      items: rows.map(toReviewRow),
      total,
      page: pageN,
      limit: limitN,
      rating: restaurant.rating,
      ratingCount: restaurant.ratingCount,
    };
  }

  /**
   * Author edits their own review. Not-yours and unknown are both 404 (the
   * existence of someone else's review is not public either). An empty patch
   * is a 400 — the API never answers a fake "success".
   */
  async update(
    userId: string,
    reviewId: string,
    dto: UpdateReviewDto,
  ): Promise<{ review: ReviewRow; restaurant: RestaurantRating }> {
    if (!isUuid(reviewId)) throw new NotFoundException('Review not found');
    const review = await this.reviews.findOne({ where: { id: reviewId, userId } });
    if (!review) throw new NotFoundException('Review not found');
    if (dto.rating === undefined && dto.comment === undefined) {
      throw new BadRequestException('Provide a rating and/or a comment to update');
    }

    if (dto.rating !== undefined) review.rating = dto.rating;
    if (dto.comment !== undefined) review.comment = dto.comment;
    await this.reviews.save(review);

    const row = await this.withRelations(review.id);
    const restaurant = await this.recomputeRating(review.restaurantId);
    return { review: toReviewRow(row), restaurant };
  }

  /** Author deletes their review. `removed:false` when it wasn't found. */
  async remove(
    userId: string,
    reviewId: string,
  ): Promise<{ removed: boolean; restaurant?: RestaurantRating }> {
    if (!isUuid(reviewId)) return { removed: false };
    const review = await this.reviews.findOne({ where: { id: reviewId, userId } });
    if (!review) return { removed: false };
    await this.reviews.delete({ id: review.id });
    const restaurant = await this.recomputeRating(review.restaurantId);
    return { removed: true, restaurant };
  }

  /**
   * Server-side rating recomputation — the ONLY writer of
   * `restaurants.rating`/`ratingCount` for review-driven values. One aggregate
   * query + one targeted UPDATE (no read-modify-write race): average of all
   * the restaurant's review ratings rounded to 2 decimals, or the platform
   * default when no reviews remain; the row count rides along for the UI.
   */
  async recomputeRating(restaurantId: string): Promise<RestaurantRating> {
    const [stats] = await this.reviews.query<Array<{ rating: number; count: number }>>(
      `SELECT COALESCE(ROUND(AVG(rating)::numeric, 2), $2::numeric)::float8 AS rating,
              COUNT(*)::int AS count
         FROM reviews WHERE "restaurantId" = $1`,
      [restaurantId, DEFAULT_RATING],
    );
    const rating = Number(stats.rating);
    const ratingCount = Number(stats.count);
    await this.restaurants.update({ id: restaurantId }, { rating, ratingCount });
    return { rating, ratingCount };
  }
}
