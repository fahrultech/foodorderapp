import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { PromoCode, PromoDiscountType } from './promo-code.entity';
import { PromoUsage } from './promo-usage.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import {
  CreatePromoDto,
  ListPromoUsagesDto,
  UpdatePromoDto,
} from './dto/admin-promo.dto';

export type PromoRejection =
  | 'not_found'
  | 'inactive'
  | 'not_started'
  | 'expired'
  | 'restaurant_mismatch'
  | 'below_min_subtotal'
  | 'total_cap_reached'
  | 'per_user_cap_reached';

/** The caller-side facts a promo gate can depend on. */
export interface PromoContext {
  /** Signed-in identity for per-user caps; null/absent = guest (skips them). */
  userId?: string | null;
  /** Clock injection point — expiry tests assert without time travel. */
  now?: Date;
}

/**
 * The single decision the rest of the app asks about a promo: given a code,
 * a restaurant and a SERVER-computed subtotal, what is the discount?
 * Never throws — callers choose between a user-facing error (order create)
 * and a soft 200 preview (validate endpoint).
 */
export interface PromoOutcome {
  ok: boolean;
  reason?: PromoRejection;
  message: string;
  promo?: PromoCode;
  discountCents?: number;
}

/** Codes are matched case-insensitively; this is the ONE normalization point. */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

const DEFAULT_PAGE = 1;
const DEFAULT_USAGE_PAGE_SIZE = 50;

@Injectable()
export class PromosService {
  constructor(
    @InjectRepository(PromoCode) private readonly promos: Repository<PromoCode>,
    @InjectRepository(PromoUsage) private readonly usages: Repository<PromoUsage>,
  ) {}

  /**
   * Evaluate a promo against a cart. The subtotal MUST come from server-side
   * menu pricing (OrdersService.create recomputes it before calling this),
   * never from anything the client sent.
   *
   * Gate order is cheapest-first and deterministic: existence → kill switch →
   * time window → scope → minimum → (only then) the ledger-counted caps.
   */
  async evaluate(
    rawCode: string,
    restaurantId: string,
    subtotalCents: number,
    ctx: PromoContext = {},
  ): Promise<PromoOutcome> {
    const code = normalizePromoCode(rawCode);
    // Same money formatting the existing order errors use (integer cents / 100).
    const money = (n: number) => (n / 100).toFixed(2);

    const promo = await this.promos.findOne({ where: { code } });
    if (!promo) {
      return { ok: false, reason: 'not_found', message: `Promo code "${code}" is not valid` };
    }
    if (!promo.isActive) {
      return { ok: false, reason: 'inactive', message: `Promo code "${code}" is no longer active` };
    }
    const now = ctx.now ?? new Date();
    if (promo.startsAt && now < promo.startsAt) {
      return {
        ok: false,
        reason: 'not_started',
        message: `Promo code "${code}" is not valid until ${promo.startsAt.toISOString()}`,
      };
    }
    if (promo.expiresAt && now >= promo.expiresAt) {
      return { ok: false, reason: 'expired', message: `Promo code "${code}" has expired` };
    }
    if (promo.restaurantId && promo.restaurantId !== restaurantId) {
      return {
        ok: false,
        reason: 'restaurant_mismatch',
        message: `Promo code "${code}" does not apply to this restaurant`,
      };
    }
    if (subtotalCents < promo.minSubtotalCents) {
      return {
        ok: false,
        reason: 'below_min_subtotal',
        message: `Promo "${code}" needs a subtotal of at least ${money(promo.minSubtotalCents)}`,
      };
    }
    if (promo.maxTotalUsages !== null) {
      const used = await this.usages.count({ where: { promoId: promo.id } });
      if (used >= promo.maxTotalUsages) {
        return {
          ok: false,
          reason: 'total_cap_reached',
          message: `Promo code "${code}" has been redeemed the maximum number of times`,
        };
      }
    }
    if (promo.maxPerUser !== null && ctx.userId) {
      const mine = await this.usages.count({
        where: { promoId: promo.id, userId: ctx.userId },
      });
      if (mine >= promo.maxPerUser) {
        return {
          ok: false,
          reason: 'per_user_cap_reached',
          message: `You have already used promo "${code}" the maximum number of times`,
        };
      }
    }

    // Money math, integer cents only.
    let discountCents: number;
    if (promo.discountType === PromoDiscountType.PERCENT) {
      discountCents = Math.floor((subtotalCents * promo.valueCents) / 100);
      if (promo.maxDiscountCents !== null) {
        discountCents = Math.min(discountCents, promo.maxDiscountCents);
      }
    } else {
      discountCents = promo.valueCents;
    }
    // A discount never goes negative and never eats the delivery fee:
    // clamped to the subtotal, so `total = subtotal - discount + fee >= fee`.
    discountCents = Math.max(0, Math.min(discountCents, subtotalCents));

    return { ok: true, message: `Promo "${code}" applied`, promo, discountCents };
  }

  /**
   * Append one redemption to the ledger INSIDE the order-create
   * transaction (unit-of-work, session 71 — this closes the count→insert
   * race session 67 left documented). Sequence under the caller's
   * EntityManager:
   *   1. SELECT ... FOR UPDATE the promo row — simultaneous "last
   *      redemption" orders serialize on this lock;
   *   2. RE-CHECK the caps against the post-lock ledger state (whatever
   *      other txns committed before we got the lock is now visible);
   *   3. insert the ledger row — rolls back together with the order if
   *      anything downstream fails.
   * Rejection messages match `evaluate()` exactly, so the client sees one
   * vocabulary whether the cap trips pre-save or under lock. A promo row
   * deleted between evaluate and record answers 400 and rolls the order
   * back too — no orphan discount.
   */
  async recordUsage(
    input: {
      promoId: string;
      orderId: string;
      userId: string | null;
      discountCents: number;
    },
    em: EntityManager,
  ): Promise<PromoUsage> {
    const promo = await em.getRepository(PromoCode).findOne({
      where: { id: input.promoId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!promo) {
      throw new BadRequestException('Promo code is no longer available');
    }
    if (promo.maxTotalUsages !== null) {
      const used = await em
        .getRepository(PromoUsage)
        .count({ where: { promoId: promo.id } });
      if (used >= promo.maxTotalUsages) {
        throw new BadRequestException(
          `Promo code "${promo.code}" has been redeemed the maximum number of times`,
        );
      }
    }
    if (promo.maxPerUser !== null && input.userId) {
      const mine = await em
        .getRepository(PromoUsage)
        .count({ where: { promoId: promo.id, userId: input.userId } });
      if (mine >= promo.maxPerUser) {
        throw new BadRequestException(
          `You have already used promo "${promo.code}" the maximum number of times`,
        );
      }
    }
    const usageRepo = em.getRepository(PromoUsage);
    return usageRepo.save(usageRepo.create(input));
  }

  /**
   * Soft preview for the checkout UI: always 2xx (POST default is 201), the `valid` flag says
   * the rest. Invalid-code spamming is harmless — the code is public info by
   * design — and the authoritative re-check happens at order creation.
   * A bearer token on the validate route enables the per-user cap check.
   */
  async preview(
    code: string,
    restaurantId: string,
    subtotalCents: number,
    ctx: PromoContext = {},
  ) {
    const outcome = await this.evaluate(code, restaurantId, subtotalCents, ctx);
    if (!outcome.ok) {
      return { valid: false as const, reason: outcome.reason, message: outcome.message };
    }
    const promo = outcome.promo!;
    const remainingUsages =
      promo.maxTotalUsages === null
        ? null
        : Math.max(
            0,
            promo.maxTotalUsages -
              (await this.usages.count({ where: { promoId: promo.id } })),
          );
    return {
      valid: true as const,
      code: promo.code,
      description: promo.description,
      discountType: promo.discountType,
      valueCents: promo.valueCents,
      discountCents: outcome.discountCents,
      discountedSubtotalCents: subtotalCents - outcome.discountCents!,
      startsAt: promo.startsAt,
      expiresAt: promo.expiresAt,
      remainingUsages,
      message: outcome.message,
    };
  }

  // ---------------------------------------------------------------------------
  // ADMIN management (Coupons expiry + usage caps)
  // ---------------------------------------------------------------------------

  /** Serializable admin row: the code definition + the live redemption count. */
  private adminRow(p: PromoCode, usageCount: number) {
    return {
      id: p.id,
      code: p.code,
      description: p.description,
      discountType: p.discountType,
      valueCents: p.valueCents,
      maxDiscountCents: p.maxDiscountCents,
      minSubtotalCents: p.minSubtotalCents,
      restaurantId: p.restaurantId,
      isActive: p.isActive,
      startsAt: p.startsAt,
      expiresAt: p.expiresAt,
      maxTotalUsages: p.maxTotalUsages,
      maxPerUser: p.maxPerUser,
      usageCount,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  /** One grouped ledger query — no per-code N+1 across the admin list. */
  private async usageCountByPromo(): Promise<Map<string, number>> {
    const raw = await this.usages
      .createQueryBuilder('u')
      .select('u.promoId', 'promoId')
      .addSelect('COUNT(*)', 'count')
      .groupBy('u.promoId')
      .getRawMany();
    return new Map(raw.map((r) => [String(r.promoId), Number(r.count)]));
  }

  async listAdmin() {
    const [codes, counts] = await Promise.all([
      this.promos.find({ order: { createdAt: 'DESC' } }),
      this.usageCountByPromo(),
    ]);
    return {
      items: codes.map((c) => this.adminRow(c, counts.get(c.id) ?? 0)),
    };
  }

  /** percent values must be real percentages; the DTO bound is looser. */
  private assertValueCoherent(discountType: PromoDiscountType, valueCents: number) {
    if (
      discountType === PromoDiscountType.PERCENT &&
      (valueCents < 1 || valueCents > 100)
    ) {
      throw new BadRequestException('percent promo valueCents must be 1..100');
    }
  }

  private window(startsAt: Date | null, expiresAt: Date | null) {
    if (startsAt && expiresAt && startsAt.getTime() >= expiresAt.getTime()) {
      throw new BadRequestException('startsAt must be before expiresAt');
    }
  }

  private async assertRestaurantExists(restaurantId: string) {
    const found = await this.promos.manager
      .getRepository(Restaurant)
      .countBy({ id: restaurantId });
    if (!found) throw new BadRequestException('restaurantId does not exist');
  }

  async createCode(dto: CreatePromoDto) {
    const code = normalizePromoCode(dto.code);
    this.assertValueCoherent(dto.discountType, dto.valueCents);
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : null;
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    this.window(startsAt, expiresAt);
    if (dto.restaurantId) await this.assertRestaurantExists(dto.restaurantId);
    if (await this.promos.findOne({ where: { code } })) {
      throw new ConflictException(`Promo code "${code}" already exists`);
    }
    const saved = await this.promos.save(
      this.promos.create({
        code,
        description: dto.description ?? null,
        discountType: dto.discountType,
        valueCents: dto.valueCents,
        maxDiscountCents: dto.maxDiscountCents ?? null,
        minSubtotalCents: dto.minSubtotalCents ?? 0,
        restaurantId: dto.restaurantId ?? null,
        isActive: dto.isActive ?? true,
        startsAt,
        expiresAt,
        maxTotalUsages: dto.maxTotalUsages ?? null,
        maxPerUser: dto.maxPerUser ?? null,
      }),
    );
    return this.adminRow(saved, 0);
  }

  /**
   * undefined keeps the current value; explicit null CLEARS expiry/caps.
   * Lowering a cap below the current redemption count is allowed — it just
   * makes the code immediately spent for new redemptions (past ledger rows
   * are never touched).
   */
  async updateCode(id: string, dto: UpdatePromoDto) {
    const promo = await this.promos.findOne({ where: { id } });
    if (!promo) throw new NotFoundException('Promo code not found');

    if (dto.code !== undefined) {
      const code = normalizePromoCode(dto.code);
      if (code !== promo.code) {
        const clash = await this.promos.findOne({ where: { code } });
        if (clash && clash.id !== promo.id) {
          throw new ConflictException(`Promo code "${code}" already exists`);
        }
        promo.code = code;
      }
    }
    const discountType = dto.discountType ?? promo.discountType;
    const valueCents = dto.valueCents ?? promo.valueCents;
    this.assertValueCoherent(discountType, valueCents);
    promo.discountType = discountType;
    promo.valueCents = valueCents;

    if (dto.maxDiscountCents !== undefined) promo.maxDiscountCents = dto.maxDiscountCents;
    if (dto.minSubtotalCents !== undefined) promo.minSubtotalCents = dto.minSubtotalCents;
    if (dto.description !== undefined) promo.description = dto.description;
    if (dto.isActive !== undefined) promo.isActive = dto.isActive;
    if (dto.maxTotalUsages !== undefined) promo.maxTotalUsages = dto.maxTotalUsages;
    if (dto.maxPerUser !== undefined) promo.maxPerUser = dto.maxPerUser;
    if (dto.restaurantId !== undefined) {
      if (dto.restaurantId) await this.assertRestaurantExists(dto.restaurantId);
      promo.restaurantId = dto.restaurantId;
    }

    const startsAt =
      dto.startsAt === undefined ? promo.startsAt : dto.startsAt === null ? null : new Date(dto.startsAt);
    const expiresAt =
      dto.expiresAt === undefined
        ? promo.expiresAt
        : dto.expiresAt === null
          ? null
          : new Date(dto.expiresAt);
    this.window(startsAt, expiresAt);
    promo.startsAt = startsAt;
    promo.expiresAt = expiresAt;

    const saved = await this.promos.save(promo);
    const counts = await this.usageCountByPromo();
    return this.adminRow(saved, counts.get(saved.id) ?? 0);
  }

  /** Newest-first redemption ledger for one code (ADMIN audit view). */
  async listUsages(id: string, query: ListPromoUsagesDto) {
    const exists = await this.promos.countBy({ id });
    if (!exists) throw new NotFoundException('Promo code not found');
    const page = query.page ?? DEFAULT_PAGE;
    const limit = query.limit ?? DEFAULT_USAGE_PAGE_SIZE;
    const [rows, total] = await this.usages.findAndCount({
      where: { promoId: id },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        promoId: r.promoId,
        orderId: r.orderId,
        userId: r.userId,
        discountCents: r.discountCents,
        createdAt: r.createdAt,
      })),
      total,
      page,
      limit,
    };
  }
}
