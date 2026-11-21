import { RestaurantsService } from './restaurants.service';
import { Restaurant } from './restaurant.entity';
import {
  DELIVERY_ETA_SQL,
  ETA_DEFAULT_PREP_MINUTES,
  ETA_MIN_SAMPLES,
  ETA_WINDOW,
  buildDeliveryEta,
} from './delivery-eta';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function row(overrides: Partial<Restaurant> = {}): Restaurant {
  return {
    id: ID_A,
    slug: 'r',
    name: 'R',
    avgPrepMinutes: 25,
    ...overrides,
  } as Restaurant;
}

describe('buildDeliveryEta — pure ladder (session 113)', () => {
  it('constants: 5-sample floor, 20-row median window baked into the SQL', () => {
    expect(ETA_MIN_SAMPLES).toBe(5);
    expect(ETA_WINDOW).toBe(20);
    expect(DELIVERY_ETA_SQL).toContain(`rn <= ${ETA_WINDOW}`);
    // The exclusion guards the ladder depends on (both stamps + positive duration).
    expect(DELIVERY_ETA_SQL).toContain('o."completedAt" > o."confirmedAt"');
    expect(DELIVERY_ETA_SQL).toContain("o.status = 'completed'");
  });

  it('no row at all -> estimate from the curated minutes, zero samples', () => {
    expect(buildDeliveryEta(undefined, 25)).toEqual({
      source: 'estimate',
      seconds: 1500,
      sampleCount: 0,
    });
  });

  it('4 eligible samples stay estimate (sampleCount still reports the truth)', () => {
    expect(buildDeliveryEta({ rid: ID_A, samples: '4', median_seconds: '60' }, 25)).toEqual({
      source: 'estimate',
      seconds: 1500,
      sampleCount: 4,
    });
  });

  it('exactly 5 samples flip to observed; string numerics from the driver parse', () => {
    expect(buildDeliveryEta({ rid: ID_A, samples: '5', median_seconds: '3300.0' }, 25)).toEqual({
      source: 'observed',
      seconds: 3300,
      sampleCount: 5,
    });
  });

  it('even-count percentile .5 medians round to integer seconds', () => {
    expect(buildDeliveryEta({ rid: ID_A, samples: 6, median_seconds: 2700.5 }, 30).seconds).toBe(
      2701,
    );
  });

  it('sub-second garbage medians never observed-render as 0s (floor 1)', () => {
    expect(buildDeliveryEta({ rid: ID_A, samples: 9, median_seconds: 0.4 }, 30).seconds).toBe(1);
  });

  it('a garbage median honestly falls back to the estimate, keeping sampleCount', () => {
    for (const bad of [null, undefined, -5, 'junk', NaN]) {
      expect(
        buildDeliveryEta({ rid: ID_A, samples: '12', median_seconds: bad as any }, 25),
      ).toEqual({ source: 'estimate', seconds: 1500, sampleCount: 12 });
    }
  });

  it('garbage sample counts count as zero', () => {
    for (const bad of [null, 'x', -3, NaN]) {
      const eta = buildDeliveryEta({ rid: ID_A, samples: bad as any, median_seconds: '60' }, 25);
      expect(eta.source).toBe('estimate');
      expect(eta.sampleCount).toBe(0);
    }
  });

  it('unusable avgPrepMinutes falls to the 30-minute entity default; floats round', () => {
    for (const bad of [undefined, null, 'abc', -2, NaN, 0]) {
      expect(buildDeliveryEta(undefined, bad as any).seconds).toBe(
        ETA_DEFAULT_PREP_MINUTES * 60,
      );
    }
    expect(buildDeliveryEta(undefined, 22.5).seconds).toBe(23 * 60);
  });
});

describe('RestaurantsService.attachEta — one batched query, honest degradation', () => {
  function harness(raw: any | Error) {
    const query = jest.fn(async () => {
      if (raw instanceof Error) throw raw;
      return raw;
    });
    const orders: any = { query };
    const service = new RestaurantsService({} as any, {} as any, undefined, undefined, orders);
    return { query, service };
  }

  it('ONE query with DEDUPED ids; matched rows observe, missing rows estimate', async () => {
    const { query, service } = harness([
      { rid: ID_A, samples: '5', median_seconds: '3300.0' },
    ]);
    const rows = [row(), row({ id: ID_B, avgPrepMinutes: 30 }), row()];
    await service.attachEta(rows);
    expect(query).toHaveBeenCalledTimes(1);
    expect((query.mock.calls[0] as unknown as any[][])[1]).toEqual([[ID_A, ID_B]]);
    expect((rows[0] as any).deliveryEta).toEqual({
      source: 'observed',
      seconds: 3300,
      sampleCount: 5,
    });
    expect((rows[1] as any).deliveryEta).toEqual({
      source: 'estimate',
      seconds: 1800,
      sampleCount: 0,
    });
  });

  it('empty rows set queries NOTHING', async () => {
    const { query, service } = harness([]);
    await service.attachEta([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('a FAILED orders read attaches null everywhere and never throws (route stays 200)', async () => {
    const { service } = harness(new Error('dead orders table'));
    const rows = [row()];
    await expect(service.attachEta(rows)).resolves.toBe(rows);
    expect((rows[0] as any).deliveryEta).toBeNull();
  });

  it('a non-array driver result degrades to honest estimates, not a crash', async () => {
    const { service } = harness({ weird: true });
    const rows = [row()];
    await service.attachEta(rows);
    expect((rows[0] as any).deliveryEta).toEqual({
      source: 'estimate',
      seconds: 1500,
      sampleCount: 0,
    });
  });

  it('without the Order repo wiring (unit harnesses) rows stay byte-untouched', async () => {
    const legacy = new RestaurantsService({} as any, {} as any);
    const rows = [row()];
    await legacy.attachEta(rows);
    expect('deliveryEta' in rows[0]).toBe(false);
  });
});

describe('RestaurantsService.findOne — ETA rides the detail read only', () => {
  const repoFor = (restaurant: Restaurant) => ({
    findOne: jest.fn(async () => restaurant),
  });
  const orders = (rows: any[]) => ({ query: jest.fn(async () => rows) });

  it('embeds deliveryEta on the returned restaurant', async () => {
    const service = new RestaurantsService(
      repoFor(row({ menuItems: [] })) as any,
      {} as any,
      undefined,
      undefined,
      orders([{ rid: ID_A, samples: '7', median_seconds: '1234' }]) as any,
    );
    const found: any = await service.findOne(ID_A);
    expect(found.deliveryEta).toEqual({ source: 'observed', seconds: 1234, sampleCount: 7 });
  });

  it('the list path never calls the ETA aggregate (session-79 statement contract)', async () => {
    const query = jest.fn(async () => []);
    const qb: any = {
      andWhere: jest.fn(() => qb),
      orderBy: jest.fn(() => qb),
      skip: jest.fn(() => qb),
      take: jest.fn(() => qb),
      getManyAndCount: jest.fn(async () => [[row()], 1]),
    };
    const service = new RestaurantsService(
      { createQueryBuilder: jest.fn(() => qb) } as any,
      {} as any,
      undefined,
      undefined,
      { query } as any,
    );
    const res: any = await service.findAll({});
    expect(query).not.toHaveBeenCalled();
    expect('deliveryEta' in res.items[0]).toBe(false);
  });
});
