import { MAX_RESTAURANT_KEYS, RequestMetricsRegistry, restaurantScopeOf } from './request-metrics';

/**
 * Session 98 (Phase 8 "per-restaurant traffic for owners"): the explicit
 * restaurant dimension of the metrics registry. Two contracts matter and
 * are pinned exhaustively here:
 *   1. ATTRIBUTION is TEMPLATE-driven — only matched restaurant-scoped
 *      routes carry a bucket id, the metrics read is exempt, unmatched
 *      junk and non-uuid segments never mint anything.
 *   2. ISOLATION — a restaurant snapshot can ONLY ever contain its own
 *      attributed samples; the global snapshot is never reachable from it.
 */

const RID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'GET /api/restaurants/:id';

describe('restaurantScopeOf — template-driven attribution', () => {
  it('attributes every restaurant-scoped template variant (both param names)', () => {
    expect(
      restaurantScopeOf({ url: `/api/restaurants/${RID}`, baseUrl: '', route: { path: '/api/restaurants/:id' } }),
    ).toBe(RID);
    expect(
      restaurantScopeOf({ url: `/api/restaurants/${RID}/menu`, baseUrl: '', route: { path: '/api/restaurants/:restaurantId/menu' } }),
    ).toBe(RID);
    expect(
      restaurantScopeOf({ url: `/api/restaurants/${RID}/orders/2/orders`, baseUrl: '', route: { path: '/api/restaurants/:id/orders/:orderId/status' } }),
    ).toBe(RID);
    expect(
      restaurantScopeOf({ url: `/api/restaurants/${RID}/reviews`, baseUrl: '', route: { path: '/api/restaurants/:id/reviews' } }),
    ).toBe(RID);
  });

  it('EXEMPTS the metrics read itself — polling never inflates its own view', () => {
    expect(
      restaurantScopeOf({ url: `/api/restaurants/${RID}/metrics`, baseUrl: '', route: { path: '/api/restaurants/:id/metrics' } }),
    ).toBeNull();
    // even with a trailing slash the exemption holds
    expect(
      restaurantScopeOf({ url: `/api/restaurants/${RID}/metrics/`, baseUrl: '', route: { path: '/api/restaurants/:id/metrics' } }),
    ).toBeNull();
  });

  it('never attributes non-restaurant templates that also carry :id', () => {
    // /orders/:id's :id is an ORDER id; /menu/items/:id's is a DISH id.
    expect(
      restaurantScopeOf({ url: `/api/orders/${RID}`, baseUrl: '', route: { path: '/api/orders/:id' } }),
    ).toBeNull();
    expect(
      restaurantScopeOf({ url: `/api/menu/items/${RID}`, baseUrl: '', route: { path: '/api/menu/items/:id' } }),
    ).toBeNull();
  });

  it('unmatched paths, non-uuid segments and query strings: no bucket', () => {
    expect(restaurantScopeOf({ url: `/api/restaurants/${RID}`, baseUrl: '', route: undefined })).toBeNull();
    expect(restaurantScopeOf({ url: '/api/restaurants/not-a-uuid', baseUrl: '', route: { path: '/api/restaurants/:id' } })).toBeNull();
    expect(restaurantScopeOf({ url: '/api/restaurants/mine', baseUrl: '', route: { path: '/api/restaurants/mine' } })).toBeNull();
    expect(restaurantScopeOf({ url: `/api/restaurants/${RID}?expand=menu`, baseUrl: '', route: { path: '/api/restaurants/:id' } })).toBe(RID);
  });

  it('normalizes case and reads the id positionally, independent of the template slot count', () => {
    const upper = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC';
    expect(
      restaurantScopeOf({ url: `/api/restaurants/${upper}`, baseUrl: '', route: { path: '/api/restaurants/:id' } }),
    ).toBe(upper.toLowerCase());
  });

  it('never lets the concrete-path segment disagree with the template (prefix-sibling safety)', () => {
    // A template for /api/restaurants/:id/reviews served at an unrelated URL shape
    // is a malformed probe: the 4th path segment must still parse as a uuid.
    expect(
      restaurantScopeOf({ url: '/api/restaurants/../../etc/passwd', baseUrl: '', route: { path: '/api/restaurants/:id/reviews' } }),
    ).toBeNull();
  });

  it('MAX_RESTAURANT_KEYS is the documented cap (bounded flood guard)', () => {
    expect(MAX_RESTAURANT_KEYS).toBe(250);
  });
});

describe('RequestMetricsRegistry — restaurant dimension', () => {
  it('buckets are minted by 2xx only; 3xx revalidations and errors only top up existing buckets', () => {
    const reg = new RequestMetricsRegistry();
    reg.record(KEY, 404, 5, 'unknown-id'); // error before any success -> NOT created
    reg.record(KEY, 304, 2, 'cold-id'); // ETag revalidation cold (session 103) -> NOT created
    expect(reg.restaurantSnapshot('unknown-id').totals.requests).toBe(0);
    expect(reg.restaurantSnapshot('cold-id').totals.requests).toBe(0);

    reg.record(KEY, 200, 5, RID); // 2xx creates
    reg.record(KEY, 304, 2, RID); // revalidation now tops up
    reg.record(KEY, 500, 15, RID); // error now tops up
    reg.record(KEY, 404, 3, RID); // and another error
    const snap = reg.restaurantSnapshot(RID);
    expect(snap.totals.requests).toBe(4);
    expect(snap.totals.byStatus).toEqual({ '2xx': 1, '3xx': 1, '4xx': 1, '5xx': 1 });
    expect(reg.snapshot().totals.restaurantKeys).toBe(1);
  });

  it('snapshots isolate restaurants — foreign samples can never ride along', () => {
    const reg = new RequestMetricsRegistry();
    reg.record(KEY, 200, 1, RID);
    reg.record('GET /api/restaurants/:id/menu', 201, 2, OTHER);
    const a = reg.restaurantSnapshot(RID);
    expect(a.totals.requests).toBe(1);
    expect(a.routes.map((r) => r.route)).toEqual([KEY]);
    const b = reg.restaurantSnapshot(OTHER);
    expect(b.routes.map((r) => r.route)).toEqual(['GET /api/restaurants/:id/menu']);
    // unknown id: honest zero, never a subtraction artifact
    expect(reg.restaurantSnapshot('ffffffff-ffff-4fff-8fff-ffffffffffff').totals.requests).toBe(0);
  });

  it('unattributed global samples NEVER appear in any restaurant bucket', () => {
    const reg = new RequestMetricsRegistry();
    reg.record('GET /api/restaurants', 200, 1); // list browse: global only
    reg.record(KEY, 200, 2, RID);
    expect(reg.snapshot().totals.requests).toBe(2);
    expect(reg.snapshot().totals.restaurantKeys).toBe(1);
    expect(reg.restaurantSnapshot(RID).totals.requests).toBe(1);
  });

  it('caps buckets at construction limit; beyond it REFUSES new buckets and flags', () => {
    const reg = new RequestMetricsRegistry(50, 1); // 1 bucket max
    reg.record(KEY, 200, 1, RID);
    reg.record(KEY, 200, 1, OTHER); // cap tripped: refused, NOT folded
    const snap = reg.snapshot();
    expect(snap.totals.restaurantKeys).toBe(1);
    expect(snap.totals.restaurantOverflowed).toBe(true);
    // the refused restaurant stays an honest zero (never another's data):
    expect(reg.restaurantSnapshot(OTHER).totals.requests).toBe(0);
    // and the global snapshot kept BOTH samples (nothing lost):
    expect(snap.totals.requests).toBe(2);
  });

  it('idempotent case-normalized lookup', () => {
    const reg = new RequestMetricsRegistry();
    reg.record(KEY, 200, 1, RID);
    expect(reg.restaurantSnapshot(RID.toUpperCase()).totals.requests).toBe(1);
    expect(reg.restaurantSnapshot(RID.toUpperCase()).restaurantId).toBe(RID);
  });

  it('window/scope markers are constants — OWNER rung honesty', () => {
    const reg = new RequestMetricsRegistry();
    reg.record(KEY, 200, 1, RID);
    const snap = reg.restaurantSnapshot(RID);
    expect(snap.scope).toBe('restaurant');
    expect(snap.window).toBe('since_api_boot');
    // the payload has no global totals field to leak:
    expect(Object.keys(snap)).toEqual(
      expect.arrayContaining(['restaurantId', 'scope', 'window', 'generatedAt', 'uptimeSec', 'boundsMs', 'totals', 'routes']),
    );
    expect((snap as any).durability).toBeUndefined();
  });

  it('reset() clears the restaurant dimension too', () => {
    const reg = new RequestMetricsRegistry();
    reg.record(KEY, 200, 1, RID);
    reg.reset();
    expect(reg.snapshot().totals.restaurantKeys).toBe(0);
    expect(reg.restaurantSnapshot(RID).totals.requests).toBe(0);
  });
});

describe('restaurantEntries — the persistence feed (session 116)', () => {
  const T0 = new Date('2026-11-21T00:00:00.000Z');
  const T1 = new Date('2026-11-21T00:05:00.000Z');

  it('carries EVERY minted bucket keyed by lowercased id, entry === restaurantSnapshot', () => {
    const reg = new RequestMetricsRegistry();
    reg.record(KEY, 200, 5, RID);
    reg.record('GET /api/restaurants/:id/menu', 200, 6, OTHER);
    // never-attempted id stays absent:
    const entries = reg.restaurantEntries(T1);
    expect(Object.keys(entries).sort()).toEqual([RID, OTHER].sort());
    expect(entries[RID]).toEqual(reg.restaurantSnapshot(RID, T1));
    expect(entries[OTHER].routes.map((r) => r.route)).toEqual(['GET /api/restaurants/:id/menu']);
    // an entry is a valid structural window input (totals + rows + bounds):
    expect(typeof entries[RID].totals.requests).toBe('number');
    expect(Array.isArray(entries[RID].boundsMs)).toBe(true);
  });

  it('empty map for a pristine boot — distinct from "no rows" for the reader', () => {
    const reg = new RequestMetricsRegistry();
    expect(reg.restaurantEntries(T0)).toEqual({});
    // probes/404s never mint, so they never appear in the feed either:
    reg.record(KEY, 404, 2, RID);
    reg.record(KEY, 304, 2, OTHER);
    expect(reg.restaurantEntries(T1)).toEqual({});
  });

  it('past-cap REFUSED ids never enter the feed (owners are never handed foreign buckets)', () => {
    const reg = new RequestMetricsRegistry(10, 2);
    reg.record(KEY, 200, 5, RID);
    reg.record(KEY, 200, 5, OTHER);
    reg.record(KEY, 200, 5, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'); // refused at cap
    const entries = reg.restaurantEntries(T0);
    expect(Object.keys(entries)).toHaveLength(2);
    expect(entries['cccccccc-cccc-4ccc-8ccc-cccccccccccc']).toBeUndefined();
  });
});
