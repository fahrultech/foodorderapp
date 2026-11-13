import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { SearchController } from '../../search/search.controller';
import { SearchService } from '../../search/search.service';
import { RestaurantsController } from '../../restaurants/restaurants.controller';
import { RestaurantsService } from '../../restaurants/restaurants.service';
import {
  RestaurantReviewsController,
  ReviewsController,
} from '../../reviews/reviews.controller';
import { ReviewsService } from '../../reviews/reviews.service';
import { OrdersController } from '../../orders/orders.controller';
import { OrdersService } from '../../orders/orders.service';
import { NotFoundException } from '@nestjs/common';
import { ErrorFormatFilter } from '../error-format.filter';
import { createGlobalValidationPipe } from '../app-config';
import { hasIllegalQueryChars } from '../query-sanitizer';
import { JwtService } from '@nestjs/jwt';
import { RATE_LIMIT_CONFIG } from '../rate-limit/rate-limit.config';
import { SlidingWindowLogStore } from '../rate-limit/rate-limit.store';
import {
  HOSTILE_TEXT,
  HOSTILE_NUMERIC,
  HOSTILE_SORT,
  encodeParam,
  makeRng,
} from './fuzz-harness';

/**
 * HTTP-level fuzz over the PUBLIC query surface (session 84): both real
 * controllers behind the REAL global ValidationPipe + ErrorFormatFilter on
 * live HTTP, services mocked. Pins the transport half of the contract:
 *   - a public GET answers 2xx-or-4xx ONLY — never 5xx, never a hang;
 *   - every rejection is the standard envelope with a machine code;
 *   - what the DTO lets through carries NO illegal wire codepoints — the
 *     sanitizer runs in the Transform, before the service (the 22021 class
 *     dies before any SQL exists).
 * The SQL side of the same contract is pinned in public-query-fuzz.spec;
 * the REAL database (only a real driver can produce that 500) in the live
 * smoke — see DEVLOG session 84.
 */

function get(app: INestApplication, path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json: any;
        try {
          json = JSON.parse(raw);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode!, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request HUNG for 5s')));
    req.end();
  });
}

async function withCtx<T>(ctx: string, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (e: any) {
    throw new Error(`${ctx}\n  → ${e?.message ?? e}`);
  }
}

async function boot() {
  const search = jest.fn(async (q: string, limit?: number) => ({
    query: q,
    limit: limit ?? 10,
    restaurants: [],
    dishes: [],
  }));
  const findAll = jest.fn(async (q: any) => ({
    items: [],
    total: 0,
    page: Math.max(1, Number(q.page) || 1),
    limit: Math.min(50, Math.max(1, Number(q.limit) || 20)),
  }));
  // Session 87 sweep surfaces. The REAL services own the clamping/in-memory
  // comparison contracts (unit + live smoke); this harness pins the
  // TRANSPORT half: raw query strings never produce 5xx at pipe level.
  const listForRestaurant = jest.fn(async () => ({
    items: [],
    total: 0,
    page: 1,
    limit: 20,
    rating: 0,
    ratingCount: 0,
  }));
  const findOneForViewer = jest.fn(async () => {
    throw new NotFoundException('Order not found');
  });
  const moduleRef = await Test.createTestingModule({
    controllers: [
      SearchController,
      RestaurantsController,
      ReviewsController,
      RestaurantReviewsController,
      OrdersController,
    ],
    providers: [
      { provide: SearchService, useValue: { search } },
      {
        provide: RestaurantsService,
        useValue: {
          findAll,
          distinctCuisines: jest.fn(async () => []),
          findOwned: jest.fn(async () => []),
        },
      },
      { provide: ReviewsService, useValue: { listForRestaurant } },
      { provide: OrdersService, useValue: { findOneForViewer } },
      // RateLimitGuard is instantiated eagerly for OrdersController's POST
      // route (never hit by this sweep — the fuzzed routes pass no bucket).
      { provide: SlidingWindowLogStore, useValue: {} },
      { provide: RATE_LIMIT_CONFIG, useValue: { rules: {} } },
      // Instantiated for the guarded routes on the controller class; the
      // fuzzed routes are public, so these never run (uuid-route-params
      // spec pattern).
      { provide: JwtService, useValue: { verifyAsync: jest.fn(async () => ({})) } },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(createGlobalValidationPipe());
  app.useGlobalFilters(new ErrorFormatFilter());
  await app.listen(0);
  return { app, search, findAll, listForRestaurant, findOneForViewer };
}

const REVIEWS_UUID = '22222222-2222-4222-8222-222222222222';
const ORDERS_UUID = '33333333-3333-4333-8333-333333333333';

describe('fuzz over HTTP: public query surface — 2xx-or-4xx ONLY', () => {
  let app: INestApplication;
  let search: jest.Mock;
  let findAll: jest.Mock;
  let listForRestaurant: jest.Mock;
  let findOneForViewer: jest.Mock;

  beforeAll(async () => {
    ({ app, search, findAll, listForRestaurant, findOneForViewer } = await boot());
  });
  afterAll(() => app.close());
  beforeEach(() => {
    search.mockClear();
    findAll.mockClear();
    listForRestaurant.mockClear();
    findOneForViewer.mockClear();
  });

  it('seed 0x84e101: 200 hostile GET /api/search — envelope-only failures, sanitized q at the service', async () => {
    const rng = makeRng(0x84e101);
    for (let i = 0; i < 200; i++) {
      const q = encodeParam(rng.pick(HOSTILE_TEXT));
      const limit = rng.int(2) === 0 ? '' : `&limit=${encodeParam(rng.pick(HOSTILE_NUMERIC))}`;
      const path = `/api/search?q=${q}${limit}`;
      await withCtx(`case#${i} path=${path}`, async () => {
        search.mockClear(); // per-case: the sweep shares one boot, calls accumulate otherwise
        const res = await get(app, path);
        expect(res.status).toBeLessThan(500);
        expect([200, 400]).toContain(res.status);
        if (res.status === 400) {
          expect(res.json?.error?.code).toBe('BAD_REQUEST');
          expect(Array.isArray(res.json.error.details)).toBe(true);
          expect(search).not.toHaveBeenCalled();
        } else {
          expect(search).toHaveBeenCalled();
          const seenQ = String(search.mock.calls[search.mock.calls.length - 1][0]);
          expect(hasIllegalQueryChars(seenQ)).toBe(false);
        }
      });
    }
  }, 90000);

  it('seed 0x84e102: 200 hostile GET /restaurants — raw params forwarded, never a 5xx, always the paged shape', async () => {
    const rng = makeRng(0x84e102);
    for (let i = 0; i < 200; i++) {
      const parts = [
        `search=${encodeParam(rng.pick(HOSTILE_TEXT))}`,
        `cuisine=${encodeParam(rng.pick(HOSTILE_TEXT))}`,
        `city=${encodeParam(rng.pick(HOSTILE_TEXT))}`,
        `sort=${encodeParam(rng.pick(HOSTILE_SORT))}`,
        `page=${encodeParam(rng.pick(HOSTILE_NUMERIC))}`,
        `limit=${encodeParam(rng.pick(HOSTILE_NUMERIC))}`,
      ].filter(() => rng.int(4) !== 0);
      const path = `/api/restaurants${parts.length ? '?' + parts.join('&') : ''}`;
      await withCtx(`case#${i} path=${path}`, async () => {
        findAll.mockClear(); // per-case (same reason as the search sweep)
        const res = await get(app, path);
        expect(res.status).toBeLessThan(500);
        expect(res.status).toBe(200); // no DTO on this route — list always answers
        expect(res.json?.items).toEqual([]);
        expect(res.json?.total).toBe(0);
        expect(findAll).toHaveBeenCalled();
      });
    }
  }, 90000);

  it('transport-junk shapes a fuzzer loves: repeated params, empty values, brackets, %25', async () => {
    const cases = [
      '/api/restaurants?search=a&search=b', // last-wins (express extended qs)
      '/api/restaurants?search=', // empty present
      '/api/restaurants?search[]=%00', // array key, NUL value
      '/api/restaurants?page[gt]=1', // operator-object shape
      '/api/restaurants?__proto__=x&constructor=y',
      '/api/search?q=sushi&limit=3&limit=4',
      '/api/search?q=%25%00%24%7B7*7%7D', // % NUL ${7*7}
      '/api/restaurants?sort=%00&city=%ed%a0%80', // NUL sort, lone-surrogate city
    ];
    for (const path of cases) {
      await withCtx(path, async () => {
        const res = await get(app, path);
        expect(res.status).toBeLessThan(500);
        expect([200, 400]).toContain(res.status);
      });
    }
  });

  it('the list route forwards RAW bytes (service sanitizer is the guard) while the DTO strips them first', async () => {
    await get(app, '/api/restaurants?search=%00&city=%00&cuisine=%00');
    const forwarded: any = findAll.mock.calls[0][0];
    expect(forwarded.search).toBe('\u0000'); // controller forwards RAW — service owns sanitation
    expect(hasIllegalQueryChars(forwarded.search)).toBe(true); // hence the service MUST sanitize

    const bad = await get(app, '/api/search?q=%00');
    expect(bad.status).toBe(400); // junk-only q → stripped → MinLength 400, service never called
    expect(search).not.toHaveBeenCalled();

    const mixed = await get(app, '/api/search?q=war%00ung');
    expect(mixed.status).toBe(200);
    expect(search).toHaveBeenCalledWith('warung', undefined); // deleted, never substituted
  });

  // ---- session 87 sweep surfaces -------------------------------------

  it('seed 0x87e101: 150 hostile GET /restaurants/:id/reviews — raw page/limit forwarded, never 5xx', async () => {
    const rng = makeRng(0x87e101);
    for (let i = 0; i < 150; i++) {
      const parts = [
        `page=${encodeParam(rng.pick(HOSTILE_NUMERIC))}`,
        `limit=${encodeParam(rng.pick(HOSTILE_NUMERIC))}`,
      ].filter(() => rng.int(3) !== 0);
      const path = `/api/restaurants/${REVIEWS_UUID}/reviews${parts.length ? '?' + parts.join('&') : ''}`;
      await withCtx(`case#${i} path=${path}`, async () => {
        listForRestaurant.mockClear(); // per-case (shared boot accumulates)
        const res = await get(app, path);
        expect(res.status).toBeLessThan(500);
        expect(res.status).toBe(200); // no DTO in front — the service clamp owns bounds
        expect(res.json?.items).toEqual([]);
        expect(listForRestaurant).toHaveBeenCalled();
        // Global-pipe coercion (harness lesson, session 87): raw params
        // annotated `number` arrive at the service ALREADY Number()-coerced
        // ('1;DROP' → NaN — typeof number), which is why the service clamp
        // (blankToUndefined + clampToIntRange, NaN → fallback) is the whole
        // guard. Query-string brackets would arrive as objects — asserted
        // non-crashing in the transport-junk case, not in this sweep.
        const seen = listForRestaurant.mock.calls[listForRestaurant.mock.calls.length - 1];
        expect(seen[0]).toBe(REVIEWS_UUID);
        for (const v of [seen[1], seen[2]]) {
          if (v !== undefined) expect(typeof v).toBe('number');
        }
      });
    }
  }, 90000);

  it('transport junk on the sweep routes: brackets, arrays, blanks, repeats — all non-5xx', async () => {
    const cases = [
      `/api/restaurants/${REVIEWS_UUID}/reviews?page[]=%00`,
      `/api/restaurants/${REVIEWS_UUID}/reviews?page[gt]=1&limit=`,
      `/api/restaurants/${REVIEWS_UUID}/reviews?page=%ed%a0%80&limit=%00`,
      `/api/restaurants/${REVIEWS_UUID}/reviews?page=1e30&limit=1e30`,
      '/api/orders?__proto__=x', // unknown route shape → 404, not 5xx
    ];
    for (const path of cases) {
      await withCtx(path, async () => {
        const res = await get(app, path);
        expect(res.status).toBeLessThan(500);
        expect([200, 400, 404]).toContain(res.status);
      });
    }
  });

  it('seed 0x87e102: 60 hostile ?contactEmail= guest proofs — in-memory compare means 404, never 5xx', async () => {
    const rng = makeRng(0x87e102);
    for (let i = 0; i < 60; i++) {
      const raw = rng.pick(HOSTILE_TEXT);
      const proof = encodeParam(raw);
      const path = `/api/orders/${ORDERS_UUID}?contactEmail=${proof}`;
      await withCtx(`case#${i} path=${path}`, async () => {
        findOneForViewer.mockClear();
        const res = await get(app, path);
        expect(res.status).toBeLessThan(500);
        // A lone surrogate breaks express's qs decoder up front (400) —
        // everything else reaches the service, which answers the plain 404
        // (unknown id and failed proof are indistinguishable).
        expect([400, 404]).toContain(res.status);
        expect(res.json?.error?.code).toBeTruthy();
        if (res.status === 404) {
          expect(findOneForViewer).toHaveBeenCalled();
          // The bytes the WIRE carries reach the service VERBATIM —
          // encodeParam is deliberately lossy exactly like a browser
          // (lone surrogates → U+FFFD), so the honest pin compares against
          // the wire form, not the JS corpus entry. The guard is that the
          // service compares in JS memory and NEVER binds the proof into
          // SQL (static gate query-surface-audit + orders.service pins).
          const wire = decodeURIComponent(proof);
          expect(findOneForViewer.mock.calls[0][2]).toBe(wire);
        } else {
          expect(findOneForViewer).not.toHaveBeenCalled();
        }
      });
    }
  }, 60000);
});
