import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { PromosService } from './promos.service';
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../common/app-config';
import { CreatePromoDto, UpdatePromoDto } from './dto/admin-promo.dto';
import { PromoCode, PromoDiscountType } from './promo-code.entity';
import { PromoUsage } from './promo-usage.entity';

const P1 = 'p-1';
const P2 = 'p-2';

function promo(overrides: Partial<PromoCode> = {}): PromoCode {
  return {
    id: P1,
    code: 'WELCOME10',
    description: '10% off',
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
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  } as PromoCode;
}

interface Harness {
  stored?: PromoCode[];
  /** Raw GROUP-BY ledger counts ({promoId, count} — count arrives as a STRING from pg). */
  rawCounts?: Array<{ promoId: string; count: string }>;
  restaurantExists?: boolean;
  ledgerRows?: Partial<PromoUsage>[];
}

function build(h: Harness = {}) {
  const stored = h.stored ?? [];
  const savedPromos: any[] = [];
  const promoRepo: any = {
    findOne: jest.fn(async ({ where }: any) =>
      where.id
        ? stored.find((p) => p.id === where.id) ?? null
        : stored.find((p) => p.code === where.code) ?? null,
    ),
    find: jest.fn(async () => [...stored]),
    countBy: jest.fn(async ({ id }: any) => (stored.some((p) => p.id === id) ? 1 : 0)),
    create: jest.fn((x: any) => ({
      id: 'p-new',
      createdAt: new Date('2026-11-06T00:00:00.000Z'),
      updatedAt: new Date('2026-11-06T00:00:00.000Z'),
      ...x,
    })),
    save: jest.fn(async (x: any) => {
      savedPromos.push(x);
      return x;
    }),
    manager: {
      getRepository: jest.fn(() => ({
        countBy: jest.fn(async () => (h.restaurantExists === false ? 0 : 1)),
      })),
    },
  };
  const usageRepo: any = {
    createQueryBuilder: jest.fn(() => {
      const qb: any = {
        select: () => qb,
        addSelect: () => qb,
        groupBy: () => qb,
        getRawMany: async () => h.rawCounts ?? [],
      };
      return qb;
    }),
    findAndCount: jest.fn(async ({ where, skip, take }: any) => {
      const rows = (h.ledgerRows ?? [])
        .filter((u) => u.promoId === where.promoId)
        .map((u) => ({ id: 'u-1', createdAt: new Date('2026-11-06T00:00:00.000Z'), ...u }));
      return [rows.slice(skip, skip + take), rows.length];
    }),
  };
  return {
    service: new PromosService(promoRepo, usageRepo),
    promoRepo,
    usageRepo,
    savedPromos,
  };
}

describe('CreatePromoDto/UpdatePromoDto through the REAL global ValidationPipe', () => {
  const pipe = new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);
  const body = (value: any, metatype: any) =>
    pipe.transform(value, { type: 'body', metatype });

  it('trims pasted whitespace off the code BEFORE @Matches (service still uppercases)', async () => {
    const dto = await body({ code: ' smoke20 ', discountType: 'fixed', valueCents: 100 }, CreatePromoDto);
    expect(dto.code).toBe('smoke20');
  });

  it('still rejects a garbage code after trimming', async () => {
    await expect(
      body({ code: '  !!  ', discountType: 'fixed', valueCents: 100 }, CreatePromoDto),
    ).rejects.toThrow();
  });

  it('PATCH nulls survive the pipe (they MEAN clear, not skip)', async () => {
    const dto = await body({ expiresAt: null, maxTotalUsages: null }, UpdatePromoDto);
    expect(dto).toMatchObject({ expiresAt: null, maxTotalUsages: null });
  });

  it('whitelist strips every undecorated property', async () => {
    const dto = await body(
      { code: 'OK1', discountType: 'fixed', valueCents: 100, restaurantId: null, hacker: 1 },
      CreatePromoDto,
    );
    expect((dto as any).hacker).toBeUndefined();
  });
});

describe('PromosService.createCode (ADMIN)', () => {
  it('normalizes the code, applies defaults and reports usageCount 0', async () => {
    const { service, savedPromos } = build();
    const out = await service.createCode({
      code: ' flash3off ',
      discountType: PromoDiscountType.FIXED,
      valueCents: 300,
    } as any);
    expect(savedPromos[0]).toMatchObject({
      code: 'FLASH3OFF',
      isActive: true,
      minSubtotalCents: 0,
      maxDiscountCents: null,
      restaurantId: null,
      startsAt: null,
      expiresAt: null,
      maxTotalUsages: null,
      maxPerUser: null,
    });
    expect(out).toMatchObject({ code: 'FLASH3OFF', valueCents: 300, usageCount: 0 });
  });

  it('converts ISO window strings into real Dates on the stored row', async () => {
    const { service, savedPromos } = build();
    await service.createCode({
      code: 'WEEKEND',
      discountType: PromoDiscountType.FIXED,
      valueCents: 500,
      startsAt: '2026-11-07T00:00:00.000Z',
      expiresAt: '2026-11-09T00:00:00.000Z',
    } as any);
    expect(savedPromos[0].startsAt).toBeInstanceOf(Date);
    expect(savedPromos[0].expiresAt).toBeInstanceOf(Date);
  });

  it('rejects a percent value outside 1..100 (DTO bound is looser on purpose)', async () => {
    const { service } = build();
    await expect(
      service.createCode({ code: 'BIG', discountType: PromoDiscountType.PERCENT, valueCents: 101 } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects startsAt at/after expiresAt (empty window)', async () => {
    const { service } = build();
    await expect(
      service.createCode({
        code: 'BROKEN',
        discountType: PromoDiscountType.FIXED,
        valueCents: 100,
        startsAt: '2026-12-01T00:00:00.000Z',
        expiresAt: '2026-11-01T00:00:00.000Z',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown restaurantId before saving (400, not an FK 500)', async () => {
    const { service, savedPromos } = build({ restaurantExists: false });
    await expect(
      service.createCode({
        code: 'SCOPED',
        discountType: PromoDiscountType.FIXED,
        valueCents: 100,
        restaurantId: '11111111-1111-4111-8111-111111111111',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(savedPromos).toHaveLength(0);
  });

  it('409 on a code collision (checked AFTER normalization)', async () => {
    const { service } = build({ stored: [promo()] });
    await expect(
      service.createCode({ code: 'welcome10', discountType: PromoDiscountType.FIXED, valueCents: 100 } as any),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('PromosService.updateCode (ADMIN)', () => {
  it('404 for an unknown id', async () => {
    const { service } = build();
    await expect(service.updateCode('missing', { isActive: false })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('omitted fields keep their value; explicit null CLEARS expiry and caps', async () => {
    const { service, savedPromos } = build({
      stored: [promo({ expiresAt: new Date('2027-01-01T00:00:00Z'), maxTotalUsages: 100, maxPerUser: 5 })],
    });
    await service.updateCode(P1, { expiresAt: null, maxTotalUsages: null } as any);
    expect(savedPromos[0]).toMatchObject({
      expiresAt: null,
      maxTotalUsages: null,
      maxPerUser: 5, // untouched (undefined), NOT cleared
      isActive: true,
      code: 'WELCOME10',
    });
  });

  it('rename colliding with another code 409s; rename to its own normalized form passes', async () => {
    const { service } = build({
      stored: [promo(), promo({ id: P2, code: 'FLASH3OFF' })],
    });
    await expect(service.updateCode(P1, { code: 'flash3off' } as any)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.updateCode(P1, { code: 'welcome10' } as any)).resolves.toMatchObject({
      code: 'WELCOME10',
    });
  });

  it('incoherent RESULT after patching (percent value 150) is rejected', async () => {
    const { service, savedPromos } = build({ stored: [promo()] });
    await expect(service.updateCode(P1, { valueCents: 150 } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(savedPromos).toHaveLength(0);
  });

  it('lowering a cap below the current redemption count is ALLOWED (code becomes spent, ledger untouched)', async () => {
    const { service, savedPromos } = build({
      stored: [promo({ maxTotalUsages: 100 })],
      rawCounts: [{ promoId: P1, count: '7' }],
    });
    const out = await service.updateCode(P1, { maxTotalUsages: 3 } as any);
    expect(savedPromos[0].maxTotalUsages).toBe(3);
    expect(out).toMatchObject({ usageCount: 7 }); // pg raw counts arrive as strings
  });

  it('restaurantId null clears the scope back to platform-wide', async () => {
    const { service, savedPromos } = build({
      stored: [promo({ restaurantId: '22222222-2222-4222-8222-222222222222' })],
    });
    await service.updateCode(P1, { restaurantId: null } as any);
    expect(savedPromos[0].restaurantId).toBeNull();
  });
});

describe('PromosService.listAdmin', () => {
  it('merges grouped ledger counts into the rows (0 for unseen codes)', async () => {
    const { service } = build({
      stored: [promo(), promo({ id: P2, code: 'FLASH3OFF' })],
      rawCounts: [{ promoId: P1, count: '5' }],
    });
    const out = await service.listAdmin();
    expect(out.items).toHaveLength(2);
    expect(out.items.find((i: any) => i.id === P1)!.usageCount).toBe(5);
    expect(out.items.find((i: any) => i.id === P2)!.usageCount).toBe(0);
  });
});

describe('PromosService.listUsages (ADMIN ledger view)', () => {
  const row = (o: string): Partial<PromoUsage> => ({
    promoId: P1,
    orderId: o,
    userId: null,
    discountCents: 250,
  });

  it('404 for an unknown code id', async () => {
    const { service } = build();
    await expect(service.listUsages('nope', {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('defaults to page 1 / limit 50 and returns the pagination envelope', async () => {
    const { service, usageRepo } = build({
      stored: [promo()],
      ledgerRows: [row('o-1'), row('o-2'), row('o-3')],
    });
    const out = await service.listUsages(P1, {});
    const args = usageRepo.findAndCount.mock.calls[0][0];
    expect(args).toMatchObject({ skip: 0, take: 50, order: { createdAt: 'DESC' } });
    expect(out).toMatchObject({ total: 3, page: 1, limit: 50 });
    expect(out.items).toHaveLength(3);
  });

  it('page 2 of limit 1 skips exactly one row', async () => {
    const { service } = build({
      stored: [promo()],
      ledgerRows: [row('o-1'), row('o-2'), row('o-3')],
    });
    const out = await service.listUsages(P1, { page: 2, limit: 1 });
    expect(out.items).toHaveLength(1);
    expect(out).toMatchObject({ total: 3, page: 2, limit: 1 });
  });

  // Session 87 sweep: page had NO bound at all — `?page=1e30` passed
  // IsInt+Min and bound `OFFSET ≈ 2e31` (driver 22001/22P02 → 500).
  it('hostile page=1e30 clamps to MAX_PUBLIC_PAGE instead of overflowing OFFSET', async () => {
    const { service, usageRepo } = build({ stored: [promo()], ledgerRows: [] });
    const out = await service.listUsages(P1, { page: 1e30 });
    const args = usageRepo.findAndCount.mock.calls[0][0];
    expect(out).toMatchObject({ page: 100_000, limit: 50 });
    expect(args.skip).toBe((100_000 - 1) * 50);
    expect(args.take).toBe(50);
    expect(Number.isSafeInteger(args.skip)).toBe(true);
  });

  it('rows expose only the ledger fields (no relation objects ride along)', async () => {
    const { service } = build({ stored: [promo()], ledgerRows: [row('o-1')] });
    const out = await service.listUsages(P1, {});
    expect(Object.keys(out.items[0]).sort()).toEqual(
      ['createdAt', 'discountCents', 'id', 'orderId', 'promoId', 'userId'].sort(),
    );
  });
});
