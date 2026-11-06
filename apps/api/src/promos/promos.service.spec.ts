import { PromosService, normalizePromoCode } from './promos.service';
import { PromoCode, PromoDiscountType } from './promo-code.entity';
import { PromoUsage } from './promo-usage.entity';
import { Repository } from 'typeorm';

const REST_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_REST_ID = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function promo(overrides: Partial<PromoCode> = {}): PromoCode {
  return {
    id: 'p-1',
    code: 'WELCOME10',
    description: '10% off your cart',
    discountType: PromoDiscountType.PERCENT,
    valueCents: 10,
    maxDiscountCents: null,
    minSubtotalCents: 0,
    restaurantId: null,
    isActive: true,
    startsAt: null,
    expiresAt: null,
    maxTotalUsages: null,
    maxPerUser: null,
    ...overrides,
  } as PromoCode;
}

/** A redemption ledger row for promo p-1. */
function usage(overrides: Partial<PromoUsage> = {}): Partial<PromoUsage> {
  return { promoId: 'p-1', orderId: 'o-x', userId: null, discountCents: 100, ...overrides };
}

/**
 * Repo mocks: the promo repo looks up by code OR id; the ledger repo counts
 * rows exactly like TypeORM's `count({ where })` would for our fixed shape.
 */
function build(stored: PromoCode[], ledger: Partial<PromoUsage>[] = []) {
  const repo = {
    findOne: jest.fn(async ({ where }: any) =>
      where.id
        ? stored.find((p) => p.id === where.id) ?? null
        : stored.find((p) => p.code === where.code) ?? null,
    ),
  } as unknown as Repository<PromoCode>;
  const usageRepo = {
    count: jest.fn(async ({ where }: any) =>
      ledger.filter(
        (u) =>
          u.promoId === where.promoId &&
          (where.userId === undefined || u.userId === where.userId),
      ).length,
    ),
    create: jest.fn((x: any) => x),
    save: jest.fn(async (x: any) => ({ id: 'usage-1', ...x })),
  } as unknown as Repository<PromoUsage>;
  return {
    service: new PromosService(repo, usageRepo),
    repo,
    usageRepo,
  };
}

describe('normalizePromoCode', () => {
  it('trims and uppercases', () => {
    expect(normalizePromoCode('  weLcome10 ')).toBe('WELCOME10');
  });
});

describe('PromosService.evaluate — gates', () => {
  it('unknown code -> not_found', async () => {
    const { service } = build([]);
    const out = await service.evaluate('NOPE', REST_ID, 5000);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not_found');
  });

  it('matches case-insensitively against the stored uppercase code', async () => {
    const { service } = build([promo()]);
    const out = await service.evaluate('welcome10', REST_ID, 5000);
    expect(out.ok).toBe(true);
    expect(out.promo!.code).toBe('WELCOME10');
  });

  it('inactive promo -> inactive', async () => {
    const { service } = build([promo({ isActive: false })]);
    expect((await service.evaluate('WELCOME10', REST_ID, 5000)).reason).toBe('inactive');
  });

  it('restaurant-scoped promo applied elsewhere -> restaurant_mismatch', async () => {
    const { service } = build([promo({ restaurantId: REST_ID })]);
    expect((await service.evaluate('WELCOME10', OTHER_REST_ID, 5000)).reason).toBe(
      'restaurant_mismatch',
    );
    // Same promo at ITS restaurant passes.
    expect((await service.evaluate('WELCOME10', REST_ID, 5000)).ok).toBe(true);
  });

  it('platform-wide promo (restaurantId null) works at any restaurant', async () => {
    const { service } = build([promo({ restaurantId: null })]);
    expect((await service.evaluate('WELCOME10', OTHER_REST_ID, 5000)).ok).toBe(true);
  });

  it('subtotal under minSubtotalCents -> below_min_subtotal (gate is pre-discount)', async () => {
    const { service } = build([promo({ minSubtotalCents: 20000 })]);
    const out = await service.evaluate('WELCOME10', REST_ID, 19999);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('below_min_subtotal');
    expect(out.message).toContain('200.00');
  });
});

describe('PromosService.evaluate — expiry window (start inclusive, end exclusive)', () => {
  const now = new Date('2026-11-06T12:00:00.000Z');
  const at = (iso: string) => new Date(iso);

  it('code before its startsAt -> not_started', async () => {
    const { service } = build([promo({ startsAt: at('2026-11-06T12:00:01.000Z') })]);
    const out = await service.evaluate('WELCOME10', REST_ID, 5000, { now });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not_started');
    expect(out.message).toContain('2026-11-06T12:00:01');
  });

  it('exactly at startsAt is INSIDE the window (inclusive)', async () => {
    const { service } = build([promo({ startsAt: now })]);
    expect((await service.evaluate('WELCOME10', REST_ID, 5000, { now })).ok).toBe(true);
  });

  it('at or after expiresAt -> expired (exclusive end)', async () => {
    const expiry = at('2026-11-06T12:00:00.000Z');
    const { service } = build([promo({ expiresAt: expiry })]);
    expect((await service.evaluate('WELCOME10', REST_ID, 5000, { now: expiry })).reason).toBe('expired');
    const { service: s2 } = build([promo({ expiresAt: at('2026-01-01T00:00:00.000Z') })]);
    const out = await s2.evaluate('WELCOME10', REST_ID, 5000, { now });
    expect(out.reason).toBe('expired');
    expect(out.message).toContain('expired');
  });

  it('one millisecond before expiresAt still works', async () => {
    const { service } = build([promo({ expiresAt: at('2026-11-06T12:00:00.001Z') })]);
    expect((await service.evaluate('WELCOME10', REST_ID, 5000, { now })).ok).toBe(true);
  });

  it('window check runs BEFORE restaurant scope and minimums', async () => {
    // An expired restaurant-scoped code answers `expired`, not `restaurant_mismatch`.
    const { service } = build([
      promo({ restaurantId: REST_ID, expiresAt: at('2026-01-01T00:00:00.000Z') }),
    ]);
    expect((await service.evaluate('WELCOME10', OTHER_REST_ID, 5000, { now })).reason).toBe('expired');
  });
});

describe('PromosService.evaluate — usage caps (counted on the ledger)', () => {
  it('total cap reached -> total_cap_reached', async () => {
    const { service } = build(
      [promo({ maxTotalUsages: 2 })],
      [usage({ orderId: 'o-1' }), usage({ orderId: 'o-2' })],
    );
    const out = await service.evaluate('WELCOME10', REST_ID, 5000);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('total_cap_reached');
  });

  it('one slot left under the total cap still works', async () => {
    const { service } = build([promo({ maxTotalUsages: 2 })], [usage({ orderId: 'o-1' })]);
    expect((await service.evaluate('WELCOME10', REST_ID, 5000)).ok).toBe(true);
  });

  it('maxTotalUsages 0 is instantly spent (even with an empty ledger)', async () => {
    const { service } = build([promo({ maxTotalUsages: 0 })]);
    expect((await service.evaluate('WELCOME10', REST_ID, 5000)).reason).toBe('total_cap_reached');
  });

  it('other promos rows do not count (count is promoId-scoped)', async () => {
    const { service } = build([promo({ maxTotalUsages: 1 })], [usage({ promoId: 'p-OTHER' })]);
    expect((await service.evaluate('WELCOME10', REST_ID, 5000)).ok).toBe(true);
  });

  it('per-user cap counts only the caller identity', async () => {
    const ledger = [usage({ orderId: 'o-1', userId: USER_A })];
    const { service } = build([promo({ maxPerUser: 1 })], ledger);
    expect((await service.evaluate('WELCOME10', REST_ID, 5000, { userId: USER_A })).reason).toBe(
      'per_user_cap_reached',
    );
    // A different account has NOT spent its own slot.
    expect((await service.evaluate('WELCOME10', REST_ID, 5000, { userId: USER_B })).ok).toBe(true);
  });

  it('guests skip the per-user cap (no provable identity) but consume the total', async () => {
    const ledger = [usage({ orderId: 'o-1', userId: USER_A })];
    const { service } = build([promo({ maxPerUser: 1 })], ledger);
    expect((await service.evaluate('WELCOME10', REST_ID, 5000)).ok).toBe(true);
    expect((await service.evaluate('WELCOME10', REST_ID, 5000, { userId: null })).ok).toBe(true);
  });

  it('caps are the LAST gate — no ledger query runs for a dead code', async () => {
    const { service, usageRepo } = build([promo({ isActive: false, maxTotalUsages: 1 })]);
    await service.evaluate('WELCOME10', REST_ID, 5000);
    expect(usageRepo.count).not.toHaveBeenCalled();
  });
});

describe('PromosService.recordUsage', () => {
  it('appends the exact ledger input as one row', async () => {
    const { service, usageRepo } = build([promo()]);
    await service.recordUsage({ promoId: 'p-1', orderId: 'o-9', userId: USER_A, discountCents: 250 });
    expect(usageRepo.create).toHaveBeenCalledWith({
      promoId: 'p-1',
      orderId: 'o-9',
      userId: USER_A,
      discountCents: 250,
    });
    expect(usageRepo.save).toHaveBeenCalledTimes(1);
  });
});

describe('PromosService.evaluate — money math (integer cents)', () => {
  const percent = (v: number, cap: number | null = null) =>
    build([promo({ discountType: PromoDiscountType.PERCENT, valueCents: v, maxDiscountCents: cap })]).service;

  it('percent floors to whole cents', async () => {
    // 10% of 1234 = 123.4 -> 123
    expect((await percent(10).evaluate('WELCOME10', REST_ID, 1234)).discountCents).toBe(123);
  });

  it('percent respects maxDiscountCents cap', async () => {
    // 10% of 90000 = 9000, capped at 2000
    expect((await percent(10, 2000).evaluate('WELCOME10', REST_ID, 90000)).discountCents).toBe(2000);
  });

  it('fixed discount subtracts valueCents', async () => {
    const { service } = build([promo({ discountType: PromoDiscountType.FIXED, valueCents: 1000 })]);
    expect((await service.evaluate('WELCOME10', REST_ID, 5000)).discountCents).toBe(1000);
  });

  it('fixed discount larger than the subtotal is clamped to the subtotal', async () => {
    const { service } = build([promo({ discountType: PromoDiscountType.FIXED, valueCents: 1000 })]);
    // subtotal 800 -> discount 800, never negative, fee untouched (caller adds it)
    expect((await service.evaluate('WELCOME10', REST_ID, 800)).discountCents).toBe(800);
  });

  it('zero subtotal yields zero discount but stays valid', async () => {
    const out = await percent(10).evaluate('WELCOME10', REST_ID, 0);
    expect(out.ok).toBe(true);
    expect(out.discountCents).toBe(0);
  });
});

describe('PromosService.preview — checkout endpoint shape', () => {
  it('valid: exposes discount + discounted subtotal for the UI', async () => {
    const { service } = build([promo({ discountType: PromoDiscountType.FIXED, valueCents: 1000 })]);
    const out = await service.preview('welcome10', REST_ID, 5000);
    expect(out).toMatchObject({
      valid: true,
      code: 'WELCOME10',
      discountCents: 1000,
      discountedSubtotalCents: 4000,
    });
  });

  it('invalid: 200-shaped soft failure with reason + message, no discount fields', async () => {
    const { service } = build([]);
    const out = await service.preview('NOPE', REST_ID, 5000);
    expect(out).toMatchObject({ valid: false, reason: 'not_found' });
    expect((out as any).discountCents).toBeUndefined();
  });

  it('valid payload carries the window + remaining redemptions', async () => {
    const starts = new Date('2026-11-01T00:00:00.000Z');
    const expires = new Date('2026-12-01T00:00:00.000Z');
    const { service } = build(
      [promo({ startsAt: starts, expiresAt: expires, maxTotalUsages: 3 })],
      [usage({ orderId: 'o-1' }), usage({ orderId: 'o-2' })],
    );
    const out = await service.preview('WELCOME10', REST_ID, 5000);
    expect(out).toMatchObject({ valid: true, startsAt: starts, expiresAt: expires, remainingUsages: 1 });
  });

  it('unlimited codes report remainingUsages null without a ledger query', async () => {
    const { service, usageRepo } = build([promo()]);
    const out = await service.preview('WELCOME10', REST_ID, 5000);
    expect((out as any).remainingUsages).toBeNull();
    expect(usageRepo.count).not.toHaveBeenCalled();
  });

  it('per-user caps surface softly in the preview for signed-in callers', async () => {
    const { service } = build(
      [promo({ maxPerUser: 1 })],
      [usage({ orderId: 'o-1', userId: USER_A })],
    );
    const asA = await service.preview('WELCOME10', REST_ID, 5000, { userId: USER_A });
    expect(asA).toMatchObject({ valid: false, reason: 'per_user_cap_reached' });
    const asGuest = await service.preview('WELCOME10', REST_ID, 5000, { userId: null });
    expect(asGuest).toMatchObject({ valid: true });
  });
});
