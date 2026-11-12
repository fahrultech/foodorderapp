import {
  HISTOGRAM_BOUNDS_MS,
  OVERFLOW_KEY,
  RequestMetricsRegistry,
  normalizeUnmatched,
  routeKeyOf,
  shouldTrackUrl,
  statusClassOf,
} from './request-metrics';
import { bucketLabel } from './request-metrics.middleware';
import { DEFAULT_METRICS_LOG_INTERVAL_SEC, resolveIntervalSec } from './request-metrics.service';

describe('request metrics — status classes + url policy', () => {
  it('classifies every real finish-time status', () => {
    expect(statusClassOf(200)).toBe('2xx');
    expect(statusClassOf(201)).toBe('2xx');
    expect(statusClassOf(299)).toBe('2xx');
    expect(statusClassOf(301)).toBe('3xx');
    expect(statusClassOf(400)).toBe('4xx');
    expect(statusClassOf(404)).toBe('4xx');
    expect(statusClassOf(499)).toBe('4xx');
    expect(statusClassOf(500)).toBe('5xx');
    expect(statusClassOf(503)).toBe('5xx');
  });

  it('tracks everything except the liveness probe', () => {
    expect(shouldTrackUrl('/api/restaurants')).toBe(true);
    expect(shouldTrackUrl('/api/health')).toBe(false);
    expect(shouldTrackUrl('/api/health/deep')).toBe(false);
    expect(shouldTrackUrl(undefined)).toBe(false);
  });
});

describe('request metrics — route keys', () => {
  it('prefers the MATCHED route template (with baseUrl), never the concrete path', () => {
    expect(
      routeKeyOf({
        method: 'GET',
        url: '/api/orders/5f0a1b2c-3d4e-4f50-9a8b-7c6d5e4f3a2b',
        baseUrl: '',
        route: { path: '/api/orders/:id' },
      }),
    ).toBe('GET /api/orders/:id');
    expect(routeKeyOf({ method: 'POST', url: '/x', baseUrl: '/api', route: { path: '/auth/login' } })).toBe(
      'POST /api/auth/login',
    );
  });

  it('collapses dynamic segments on UNMATCHED paths and strips query strings', () => {
    expect(routeKeyOf({ method: 'GET', url: '/api/nope/5f0a1b2c-3d4e-4f50-9a8b-7c6d5e4f3a2b?x=1' })).toBe(
      'GET /api/nope/:id',
    );
    expect(routeKeyOf({ method: 'GET', url: '/api/item/42/kid/7' })).toBe('GET /api/item/:id/kid/:id');
    expect(routeKeyOf({ method: 'GET', url: '/?query=only' })).toBe('GET /');
  });

  it('truncates absurd unmatched paths instead of storing them', () => {
    const key = routeKeyOf({ method: 'GET', url: `/${'a'.repeat(300)}` });
    expect(key.length).toBeLessThanOrEqual('GET '.length + 96);
  });

  it('normalizeUnmatched keeps static segments intact', () => {
    expect(normalizeUnmatched('/api/admin/metrics')).toBe('/api/admin/metrics');
  });
});

describe('request metrics — histogram + percentile math', () => {
  it('bucketLabel matches the registry bounds inclusively', () => {
    expect(bucketLabel(0.4)).toBe('<=5ms');
    expect(bucketLabel(5)).toBe('<=5ms'); // upper bound INCLUSIVE
    expect(bucketLabel(5.001)).toBe('<=10ms');
    expect(bucketLabel(100)).toBe('<=100ms');
    expect(bucketLabel(HISTOGRAM_BOUNDS_MS[HISTOGRAM_BOUNDS_MS.length - 1])).toBe('<=10000ms');
    expect(bucketLabel(10000.1)).toBe('>10000ms');
  });

  it('cumulative histogram counts each sample into every bucket at or above it', () => {
    const reg = new RequestMetricsRegistry();
    for (const d of [3, 7, 60, 600, 20000]) reg.record('GET /x', 200, d);
    const row = reg.snapshot().routes[0];
    const byLe = new Map(row.histogram.map((b) => [b.leMs, b.count]));
    expect(byLe.get(5)).toBe(1); // 3
    expect(byLe.get(10)).toBe(2); // 3,7
    expect(byLe.get(25)).toBe(2);
    expect(byLe.get(100)).toBe(3); // +60
    expect(byLe.get(500)).toBe(3);
    expect(byLe.get(1000)).toBe(4); // +600
    expect(byLe.get(10000)).toBe(4);
    expect(byLe.get(null)).toBe(5); // +Inf = all
  });

  it('percentiles are nearest-bound estimates (never below the true value)', () => {
    const reg = new RequestMetricsRegistry();
    for (const d of [3, 7, 60, 600, 20000]) reg.record('GET /x', 200, d);
    const row = reg.snapshot().routes[0];
    // rank(q) = ceil(q*n): p50 -> 3rd smallest (60) -> bound 100.
    expect(row.p50Ms).toBe(100);
    // p95 -> 5th smallest (20000) -> beyond every bound -> maxMs.
    expect(row.p95Ms).toBe(20000);
    expect(row.maxMs).toBe(20000);
    expect(row.minMs).toBe(3);
    expect(row.sumMs).toBe(20670);
    expect(row.avgMs).toBe(4134);
  });

  it('empty snapshot: null percentiles, zero rows', () => {
    const snap = new RequestMetricsRegistry().snapshot();
    expect(snap.totals.requests).toBe(0);
    expect(snap.totals.avgMs).toBeNull();
    expect(snap.totals.p95Ms).toBeNull();
    expect(snap.routes).toEqual([]);
  });
});

describe('request metrics — registry aggregation', () => {
  it('tallies per-route counts and status classes', () => {
    const reg = new RequestMetricsRegistry();
    reg.record('GET /a', 200, 10);
    reg.record('GET /a', 500, 20);
    reg.record('POST /a', 201, 5);
    const snap = reg.snapshot();
    expect(snap.totals.requests).toBe(3);
    expect(snap.totals.byStatus).toEqual({ '2xx': 2, '3xx': 0, '4xx': 0, '5xx': 1 });
    const getRow = snap.routes.find((r) => r.route === 'GET /a')!;
    expect(getRow.requests).toBe(2);
    expect(getRow.byStatus['5xx']).toBe(1);
  });

  it('sorts rows by request count desc, then route asc', () => {
    const reg = new RequestMetricsRegistry();
    reg.record('GET /single', 200, 1);
    reg.record('GET /zzz', 200, 1);
    reg.record('GET /aaa', 200, 1);
    reg.record('GET /aaa', 200, 1);
    expect(reg.snapshot().routes.map((r) => r.route)).toEqual(['GET /aaa', 'GET /single', 'GET /zzz']);
  });

  it('folds NEW keys into "other" once the cap trips; existing keys keep counting', () => {
    const reg = new RequestMetricsRegistry(2);
    reg.record('GET /one', 200, 1);
    reg.record('GET /two', 200, 1);
    reg.record('GET /three', 500, 1);
    reg.record('GET /four', 200, 1);
    reg.record('GET /one', 200, 1); // under cap: still precise
    const snap = reg.snapshot();
    expect(snap.totals.routeKeys).toBe(2);
    expect(snap.totals.overflowed).toBe(true);
    const other = snap.routes.find((r) => r.route === OVERFLOW_KEY)!;
    expect(other.requests).toBe(2);
    expect(other.byStatus['5xx']).toBe(1);
    expect(snap.routes.find((r) => r.route === 'GET /one')!.requests).toBe(2);
    expect(snap.totals.requests).toBe(5); // NOTHING is lost by folding
  });

  it('totals merge route histograms additively', () => {
    const reg = new RequestMetricsRegistry();
    reg.record('GET /a', 200, 4);
    reg.record('GET /b', 200, 8);
    const t = reg.snapshot().totals;
    expect(t.requests).toBe(2);
    expect(t.avgMs).toBe(6);
    expect(t.maxMs).toBe(8);
    expect(t.p50Ms).toBe(5); // rank ceil(0.5*2)=1 -> first sample 4 -> bound 5
  });

  it('reset() returns to pristine', () => {
    const reg = new RequestMetricsRegistry(1);
    reg.record('GET /a', 200, 1);
    reg.record('GET /b', 500, 1);
    reg.reset();
    const snap = reg.snapshot();
    expect(snap.totals.requests).toBe(0);
    expect(snap.totals.overflowed).toBe(false);
    expect(snap.routes).toEqual([]);
  });
});

describe('request metrics — interval resolution (METRICS_LOG_INTERVAL_SEC)', () => {
  it('defaults when unset/empty', () => {
    expect(resolveIntervalSec(undefined)).toBe(DEFAULT_METRICS_LOG_INTERVAL_SEC);
    expect(resolveIntervalSec('')).toBe(DEFAULT_METRICS_LOG_INTERVAL_SEC);
    expect(resolveIntervalSec('  ')).toBe(DEFAULT_METRICS_LOG_INTERVAL_SEC);
  });
  it('explicit 0 disables the periodic fold', () => {
    expect(resolveIntervalSec('0')).toBe(0);
    expect(resolveIntervalSec('0.0')).toBe(0);
  });
  it('parses positives as integers', () => {
    expect(resolveIntervalSec('5')).toBe(5);
    expect(resolveIntervalSec('30.9')).toBe(30);
  });
  it('garbage and negatives fall back to the default — boot must never crash on this knob', () => {
    expect(resolveIntervalSec('abc')).toBe(DEFAULT_METRICS_LOG_INTERVAL_SEC);
    expect(resolveIntervalSec('-5')).toBe(DEFAULT_METRICS_LOG_INTERVAL_SEC);
    expect(resolveIntervalSec('Infinity')).toBe(DEFAULT_METRICS_LOG_INTERVAL_SEC);
  });
});
