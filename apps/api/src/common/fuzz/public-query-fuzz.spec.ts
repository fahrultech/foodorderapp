import { BadRequestException } from '@nestjs/common';
import { RestaurantsService } from '../../restaurants/restaurants.service';
import { SearchService } from '../../search/search.service';
import { escapeLike } from '../like-escape';
import { hasIllegalQueryChars, sanitizeQueryText } from '../query-sanitizer';
import { fuzzListQuery, makeRng, HOSTILE_TEXT, HOSTILE_NUMERIC } from './fuzz-harness';

/**
 * Property-based fuzz specs for the two PUBLIC text surfaces
 * (Phase 7 roadmap: "fuzz the public search/list query params — assert
 * constant statement shape + 4xx-or-2xx only, no 5xx").
 *
 * Contracts pinned (session 79's regression gate; the 500 class this suite
 * caught lives in common/query-sanitizer.ts):
 *  1. CONSTANT STATEMENT SHAPE — the emitted predicate set/order/paging
 *     depends ONLY on which params are PRESENT after sanitizing, never on
 *     their content. A NUL-only `search=` behaves exactly like an absent one.
 *  2. NO INTERPOLATION — hostile text can only ever reach SQL as a BOUND
 *     param, and every bound value is illegal-codepoint-free, so the driver
 *     can never answer 22021 → HTTP 500 on a GET.
 *  3. BOUNDED COERCION — page/limit clamp to safe integers, sort lands on
 *     the whitelist, and NOTHING escapes as a non-4xx error.
 *
 * Seeded xorshift: every FAIL prints the seed and the case — replays
 * exactly. No external fast-check dependency needed on this stack.
 */

/** Run one case; on any assertion failure rethrow with seed+case context. */
async function withCtx<T>(ctx: string, body: () => Promise<T> | T): Promise<T> {
  try {
    return await body();
  } catch (e: any) {
    throw new Error(`${ctx}\n  → ${e?.message ?? e}`);
  }
}

// ---------------------------------------------------------------- list ----

/** Closed set of predicate templates findAll may ever emit (session 79/84). */
const LIST_TEMPLATES = [
  'r.name ILIKE :s',
  'r.cuisine ILIKE :s',
  'LOWER(r.cuisine) = :cuisine',
  '(EXISTS (SELECT 1 FROM cities c WHERE c.id = r."cityId" AND (LOWER(c.slug) = :city OR LOWER(c.name) = :city)) OR (r."cityId" IS NULL AND LOWER(r.city) = :city))',
];

function qbHarness() {
  const arms: { sql: string; params?: any }[] = [];
  const orders: string[][] = [];
  const paging: { skip?: number; take?: number } = {};
  const track = (method: string) => (...args: any[]) => {
    if (method === 'andWhere') {
      const [sql, params] = args;
      if (sql && typeof sql.whereFactory === 'function') {
        const sub: any = {
          where: (s2: string, p2: any) => (arms.push({ sql: s2, params: p2 }), sub),
          orWhere: (s2: string, p2: any) => (arms.push({ sql: s2, params: p2 }), sub),
        };
        sql.whereFactory(sub);
      } else {
        arms.push({ sql, params });
      }
    } else if (method === 'orderBy') {
      orders.push(args.map(String));
    } else if (method === 'skip') {
      paging.skip = args[0];
    } else if (method === 'take') {
      paging.take = args[0];
    }
    return qb;
  };
  const qb: any = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'getManyAndCount') return async () => [[], 0];
        if (prop === 'then') return undefined; // never awaitable-as-thenable
        return track(prop);
      },
    },
  );
  const repo: any = { createQueryBuilder: jest.fn(() => qb) };
  const service = new RestaurantsService(repo, {} as any);
  return { service, arms, orders, paging };
}

async function sweepList(runs: number, seed: number) {
  const rng = makeRng(seed);
  for (let i = 0; i < runs; i++) {
    const q = fuzzListQuery(rng);
    const ctx = `case#${i} seed=${seed} case=${JSON.stringify(q)}`;
    await withCtx(ctx, async () => {
      const { service, arms, orders, paging } = qbHarness();
      let res: any;
      try {
        res = await service.findAll(q as any);
      } catch (e: any) {
        throw new Error(`NON-4xx escape: ${e?.message ?? e}`);
      }
      // 1. presence-derived arm set — content can never invent a predicate.
      const expectedArms =
        (sanitizeQueryText(q.search) ? 2 : 0) +
        (sanitizeQueryText(q.cuisine) ? 1 : 0) +
        (sanitizeQueryText(q.city) ? 1 : 0);
      expect(arms.length).toBe(expectedArms);
      for (const a of arms) expect(LIST_TEMPLATES).toContain(a.sql);
      // 2. no interpolation + driver-legal bound values (the 22021 gate).
      for (const a of arms) {
        for (const junk of [q.search, q.cuisine, q.city]) {
          // Only longer phrases are meaningful interpolation probes; 1–2 char
          // junk (`%`, `_`, `$1`) naturally occurs in legitimate SQL text,
          // and a value EQUAL to a template fragment ('r.name') cannot be
          // told apart from the template itself — the param assertion right
          // below proves where such a value actually went.
          if (junk && junk.length > 5 && !LIST_TEMPLATES.some((t) => t.includes(junk.slice(0, 10)))) {
            expect(a.sql).not.toContain(junk.slice(0, 10));
          }
        }
        for (const v of Object.values(a.params ?? {})) {
          if (typeof v === 'string') expect(hasIllegalQueryChars(v)).toBe(false);
        }
      }
      // search arms follow the shared escape contract exactly.
      for (const a of arms) {
        if (a.sql === 'r.name ILIKE :s' || a.sql === 'r.cuisine ILIKE :s') {
          expect(a.params!.s).toBe(`%${escapeLike(sanitizeQueryText(q.search).toLowerCase())}%`);
        }
      }
      // 3. sort whitelist — the orderBy column is one of exactly three.
      for (const [col] of orders) {
        expect(['r.rating', 'r.deliveryFeeCents', 'r.createdAt']).toContain(col);
      }
      // 4. bounded coercion at the service edge (the ONLY guard, no DTO here).
      // limit is hard-clamped 1..50. A huge `page` is NOT a contract break:
      // it stays a finite Number that reaches SQL as a bound OFFSET literal —
      // Postgres answers empty, status 200, shape unchanged. Deep-paging
      // hardening is a product decision, not this gate.
      expect(Number.isFinite(paging.skip)).toBe(true);
      expect(paging.skip).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(paging.take)).toBe(true);
      expect(paging.take).toBeGreaterThanOrEqual(1);
      expect(paging.take).toBeLessThanOrEqual(50);
      expect(res.page).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(res.page)).toBe(true);
      expect(res.limit).toBeGreaterThanOrEqual(1);
      expect(res.limit).toBeLessThanOrEqual(50);
    });
  }
}

describe('fuzz: GET /restaurants param sweep', () => {
  it('seed 0x84f101: 500 hostile list queries keep the contract', () =>
    sweepList(500, 0x84f101), 60000);

  it('seed 0x84f102: 500 more (different stream)', () => sweepList(500, 0x84f102), 60000);

  it('junk-only values behave EXACTLY like absent ones (shape-neutral)', async () => {
    const cases = ['\u0000', '\ufffd', '\ud800', '\u0001\u0002', '  \u0000  ', '\ud800\udbff'];
    for (const junk of cases) {
      const bare = qbHarness();
      await bare.service.findAll({} as any);
      const dirty = qbHarness();
      await dirty.service.findAll({ search: junk, cuisine: junk, city: junk } as any);
      expect(dirty.arms).toEqual(bare.arms); // zero extra predicates (any junk)
      expect(dirty.orders).toEqual(bare.orders);
      expect(dirty.paging).toEqual(bare.paging);
    }
  });

  it('array-valued params (?search[]=a) collapse to absent, never crash', async () => {
    const { service, arms } = qbHarness();
    await service.findAll({ search: ['a', 'b'], city: ['x'], cuisine: ['y'] } as any);
    expect(arms).toEqual([]);
  });

  it('oversize search (2000 chars) stays a BOUND param', async () => {
    const { service, arms } = qbHarness();
    await service.findAll({ search: 'q'.repeat(2000) } as any);
    expect(arms.length).toBe(2);
    expect(arms[0].params!.s.length).toBe(2002);
  });

  it('SQL injection idioms appear ONLY as bound params (classic scan)', async () => {
    const hostile = "'; DROP TABLE restaurants; --";
    const { service, arms } = qbHarness();
    await service.findAll({ search: hostile } as any);
    const sqlText = arms.map((a) => a.sql).join(' | ');
    expect(sqlText).not.toMatch(/DROP|;|--/i);
    expect(sqlText).toBe('r.name ILIKE :s | r.cuisine ILIKE :s');
    expect(arms[0].params!.s).toBe(`%${escapeLike(hostile.toLowerCase())}%`);
  });
});

// -------------------------------------------------------------- search ----

function searchHarness() {
  const calls: { sql: string; params: any[] }[] = [];
  const mk = () =>
    jest.fn(async (sql: string, params: any[]) => {
      calls.push({ sql, params });
      return [];
    });
  const attachHours = jest.fn(async (rows: any[]) => rows);
  const service = new SearchService({ query: mk() } as any, { query: mk() } as any, {
    attachHours,
  } as any);
  return { service, calls };
}

async function sweepSearch(runs: number, seed: number) {
  const rng = makeRng(seed);
  for (let i = 0; i < runs; i++) {
    const q = rng.pick(HOSTILE_TEXT);
    const rawLimit = rng.int(3) === 0 ? undefined : rng.pick(HOSTILE_NUMERIC);
    const ctx = `case#${i} seed=${seed} q=${JSON.stringify(q)} limit=${JSON.stringify(rawLimit)}`;
    await withCtx(ctx, async () => {
      const { service, calls } = searchHarness();
      let threw: any = null;
      try {
        await service.search(q, rawLimit as any);
      } catch (e) {
        threw = e;
      }
      const query = sanitizeQueryText(q);
      if (query === '') {
        // junk-only / empty q → the ONE sanctioned failure is a 400, and
        // NOTHING ever reached the driver.
        expect(threw).toBeInstanceOf(BadRequestException);
        expect(calls.length).toBe(0);
      } else {
        expect(threw).toBeNull();
        expect(calls.length).toBe(2); // restaurants + dishes, constant
        // Fixed SQL TEXT; hostile text lives ONLY in positional params…
        expect(calls[0].sql).toContain('name % $1');
        // Interpolation probe only for distinctive phrases: short queries
        // ("name", "$1", "id") occur inside the legitimate fixed SQL text.
        if (query.length > 7) expect(calls[0].sql).not.toContain(query.slice(0, 12));
        // …and every bound string param is driver-legal (the 22021 gate).
        for (const c of calls) {
          for (const v of c.params) {
            if (typeof v === 'string') expect(hasIllegalQueryChars(v)).toBe(false);
          }
        }
        // the escaped-LIKE pattern follows the shared contract; the search
        // surface does NOT lowercase (ILIKE itself is case-insensitive).
        expect(calls[0].params[0]).toBe(query);
        expect(calls[0].params[1]).toBe(`%${escapeLike(query)}%`);
        expect(calls[0].params[2]).toBeGreaterThanOrEqual(1);
        expect(calls[0].params[2]).toBeLessThanOrEqual(25);
      }
    });
  }
}

describe('fuzz: GET /api/search param sweep', () => {
  it('seed 0x84f201: 400 hostile q values', () => sweepSearch(400, 0x84f201), 60000);
  it('seed 0x84f202: 400 more', () => sweepSearch(400, 0x84f202), 60000);

  it('the response echoes the SANITIZED query (never the raw junk)', async () => {
    const { service } = searchHarness();
    const out: any = await service.search('war\u0000ung');
    expect(out.query).toBe('warung');
  });
});
