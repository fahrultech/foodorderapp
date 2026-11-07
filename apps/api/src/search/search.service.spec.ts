import { BadRequestException } from '@nestjs/common';
import { SearchService, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, escapeLike } from './search.service';

/**
 * Unit spec for the fuzzy-search service. The SQL is the product here, so
 * the two raw queries are asserted as TEXT (operators, predicate columns,
 * availability filter, join, ordering) plus their BOUND PARAMS (never an
 * interpolated query string), and the response mapping is asserted EXACT.
 */

const RID = '11111111-1111-4111-8111-111111111111';

function restaurantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RID,
    slug: 'warung-nusantara',
    name: 'Warung Nusantara',
    description: 'Authentic home-style Indonesian cooking',
    cuisine: 'Indonesian',
    city: 'Jakarta',
    cityId: null,
    address: null,
    imageUrl: null,
    rating: '4.75', // pg NUMERIC arrives as a string — must be coerced
    deliveryFeeCents: 200,
    minOrderCents: 1000,
    avgPrepMinutes: 25,
    isOpen: true,
    timeZone: 'Asia/Jakarta',
    relevance: 0.83,
    ...overrides,
  };
}

function dishRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Nasi Goreng',
    description: 'Fried rice with egg',
    priceCents: 1800,
    category: 'Mains',
    imageUrl: null,
    restaurantId: RID,
    restaurantSlug: 'warung-nusantara',
    restaurantName: 'Warung Nusantara',
    restaurantCuisine: 'Indonesian',
    relevance: 0.77,
    ...overrides,
  };
}

function build(
  restaurantRows: any[] = [restaurantRow()],
  dishRows: any[] = [dishRow()],
) {
  const rQuery = jest.fn(async (_sql: string, _params: any[]) => restaurantRows);
  const mQuery = jest.fn(async (_sql: string, _params: any[]) => dishRows);
  const attachHours = jest.fn(async (rows: any[]) => rows);
  const service = new SearchService(
    { query: rQuery } as any,
    { query: mQuery } as any,
    { attachHours } as any,
  );
  return { service, rQuery, mQuery, attachHours };
}

describe('escapeLike', () => {
  it('escapes ILIKE metacharacters (backslash first, then % and _)', () => {
    expect(escapeLike('50%_off\\x')).toBe('50\\%\\_off\\\\x');
    expect(escapeLike('plain')).toBe('plain');
  });
});

describe('SearchService.search — queries', () => {
  it('binds the trimmed query, the escaped like pattern and the limit as PARAMS', async () => {
    const { service, rQuery, mQuery } = build();
    await service.search('  warung  ');

    expect(rQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = rQuery.mock.calls[0];
    expect(params).toEqual(['warung', '%warung%', SEARCH_DEFAULT_LIMIT]);
    expect(sql).not.toMatch(/warung/); // nothing interpolated
    // Index-friendly trigram operators + substring OR on every column:
    expect(sql).toMatch(/name % \$1/);
    expect(sql).toMatch(/\$1 <% name/);
    expect(sql).toMatch(/description % \$1/);
    expect(sql).toMatch(/\$1 <% cuisine/);
    expect(sql).toMatch(/name ILIKE \$2/);
    // Ranking + deterministic tie-breaks:
    expect(sql).toMatch(/GREATEST\(\s*similarity\(name, \$1\),\s*word_similarity\(\$1, name\)/);
    expect(sql).toMatch(/ORDER BY relevance DESC, rating DESC, name ASC/);
    expect(sql).toMatch(/LIMIT \$3/);

    expect(mQuery).toHaveBeenCalledTimes(1);
    const [dishSql, dishParams] = mQuery.mock.calls[0];
    expect(dishParams).toEqual(['warung', '%warung%', SEARCH_DEFAULT_LIMIT]);
    expect(dishSql).toMatch(/m\."isAvailable"/); // unavailable dishes never surface
    expect(dishSql).toMatch(/JOIN restaurants r ON r\.id = m\."restaurantId"/);
    expect(dishSql).toMatch(/ORDER BY relevance DESC/);
  });

  it('escapes ILIKE metacharacters inside the bound like param only', async () => {
    const { service, rQuery } = build([], []);
    await service.search('50%_deal');
    expect(rQuery.mock.calls[0][1]).toEqual(['50%_deal', '%50\\%\\_deal%', SEARCH_DEFAULT_LIMIT]);
  });

  it('clamps limit defensively to 1..25 (the DTO is the first gate, not the only one)', async () => {
    const cases: Array<[number | undefined, number]> = [
      [undefined, SEARCH_DEFAULT_LIMIT],
      [0, 1],
      [-5, 1],
      [26, SEARCH_MAX_LIMIT],
      [1000, SEARCH_MAX_LIMIT],
      [7, 7],
    ];
    for (const [input, expected] of cases) {
      const { service, rQuery, mQuery } = build([], []);
      await service.search('sushi', input as any);
      expect((rQuery.mock.calls[0] as any)[1][2]).toBe(expected);
      expect((mQuery.mock.calls[0] as any)[1][2]).toBe(expected);
    }
  });

  it('rejects an empty or whitespace-only query before touching the DB', async () => {
    const { service, rQuery, mQuery } = build();
    await expect(service.search('   ')).rejects.toThrow(BadRequestException);
    await expect(service.search('')).rejects.toThrow(BadRequestException);
    expect(rQuery).not.toHaveBeenCalled();
    expect(mQuery).not.toHaveBeenCalled();
  });
});

describe('SearchService.search — response shape', () => {
  it('maps restaurant rows with numbers coerced and runs the shared hours attach', async () => {
    const { service, attachHours } = build();
    const res = await service.search('warung');

    expect(res.query).toBe('warung');
    expect(res.limit).toBe(SEARCH_DEFAULT_LIMIT);
    expect(res.restaurants).toHaveLength(1);
    const r = res.restaurants[0];
    expect(r).toMatchObject({
      id: RID,
      name: 'Warung Nusantara',
      rating: 4.75, // string coerced per the response contract
      deliveryFeeCents: 200,
      isOpen: true,
      timeZone: 'Asia/Jakarta',
      relevance: 0.83,
    });
    expect(typeof r.rating).toBe('number');
    // The attach mutates the SAME objects the response carries, so search
    // results and the storefront list derive open-ness once, together.
    expect(attachHours).toHaveBeenCalledWith([res.restaurants[0]]);
  });

  it('nulls out absent optional fields instead of leaking undefined', async () => {
    const { service } = build(
      [restaurantRow({ cuisine: null, city: null, imageUrl: null, timeZone: null, description: null })],
      [dishRow({ description: null, category: null, restaurantCuisine: null })],
    );
    const res = await service.search('x');
    expect(res.restaurants[0]).toMatchObject({
      cuisine: null,
      city: null,
      imageUrl: null,
      timeZone: null,
    });
    expect(res.dishes[0]).toMatchObject({
      description: null,
      category: null,
      restaurant: { id: RID, slug: 'warung-nusantara', name: 'Warung Nusantara', cuisine: null },
    });
  });

  it('flattens the joined restaurant columns into a nested brief on dish hits', async () => {
    const { service } = build([], [dishRow()]);
    const res = await service.search('nasi');
    expect(res.dishes[0].restaurant).toEqual({
      id: RID,
      slug: 'warung-nusantara',
      name: 'Warung Nusantara',
      cuisine: 'Indonesian',
    });
    expect((res.dishes[0] as any).restaurantSlug).toBeUndefined();
    expect((res.dishes[0] as any).restaurantName).toBeUndefined();
    expect(res.dishes[0].priceCents).toBe(1800);
  });

  it('returns honest empty arrays when nothing matches', async () => {
    const { service } = build([], []);
    const res = await service.search('zzzznothing');
    expect(res).toEqual({ query: 'zzzznothing', limit: 10, restaurants: [], dishes: [] });
  });
});
