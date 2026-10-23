import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PromoCode, PromoDiscountType } from './promo-code.entity';

export type PromoRejection =
  | 'not_found'
  | 'inactive'
  | 'restaurant_mismatch'
  | 'below_min_subtotal';

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

@Injectable()
export class PromosService {
  constructor(
    @InjectRepository(PromoCode) private readonly promos: Repository<PromoCode>,
  ) {}

  /**
   * Evaluate a promo against a cart. The subtotal MUST come from server-side
   * menu pricing (OrdersService.create recomputes it before calling this),
   * never from anything the client sent.
   */
  async evaluate(
    rawCode: string,
    restaurantId: string,
    subtotalCents: number,
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
   * Soft preview for the checkout UI: always HTTP 200, the `valid` flag says
   * the rest. Invalid-code spamming is harmless — the code is public info by
   * design — and the authoritative re-check happens at order creation.
   */
  async preview(code: string, restaurantId: string, subtotalCents: number) {
    const outcome = await this.evaluate(code, restaurantId, subtotalCents);
    if (!outcome.ok) {
      return { valid: false as const, reason: outcome.reason, message: outcome.message };
    }
    return {
      valid: true as const,
      code: outcome.promo!.code,
      description: outcome.promo!.description,
      discountType: outcome.promo!.discountType,
      valueCents: outcome.promo!.valueCents,
      discountCents: outcome.discountCents,
      discountedSubtotalCents: subtotalCents - outcome.discountCents!,
      message: outcome.message,
    };
  }
}
