import { PromosService, normalizePromoCode } from './promos.service';
import { PromoCode, PromoDiscountType } from './promo-code.entity';
import { Repository } from 'typeorm';

const REST_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_REST_ID = '22222222-2222-4222-8222-222222222222';

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
    ...overrides,
  } as PromoCode;
}

/** Repo mock keyed by stored (uppercase) code. */
function build(stored: PromoCode[]) {
  const repo = {
    findOne: jest.fn(async ({ where }: any) =>
      stored.find((p) => p.code === where.code) ?? null,
    ),
  } as unknown as Repository<PromoCode>;
  return { service: new PromosService(repo), repo };
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
});
