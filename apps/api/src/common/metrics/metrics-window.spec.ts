import { MetricsSnapshot, RequestMetricsRegistry } from './request-metrics';
import {
  computeWindowDelta,
  isSnapshotShape,
  WINDOW_TOP_ROUTES,
} from './metrics-window';

/**
 * Window deltas are REAL registry output throughout — snapshots come from
 * actual record() streams (cumulative, internally consistent), so a
 * regression in either producer (registry) or consumer (delta) fails here.
 */

const T0 = new Date('2026-11-14T00:00:00.000Z');
const T1 = new Date('2026-11-14T00:10:00.000Z');

describe('computeWindowDelta — same-boot cumulative subtraction', () => {
  it('reports EXACTLY the traffic between two snapshots (requests, status, histogram, per-route, percentiles)', () => {
    const reg = new RequestMetricsRegistry();
    // Phase A (captured in the baseline):
    reg.record('GET /a', 200, 3);
    reg.record('GET /a', 404, 8);
    reg.record('GET /a', 200, 40);
    reg.record('GET /a', 500, 60);
    reg.record('POST /b', 201, 1200);
    reg.record('POST /b', 200, 12000);
    const prev = reg.snapshot(T0);

    // Phase B — the WINDOW proper:
    reg.record('GET /a', 200, 4);
    reg.record('POST /b', 429, 7);
    const cur = reg.snapshot(T1);

    const w = computeWindowDelta(prev, cur);
    expect(w).not.toBeNull();
    expect(w!.fromCapturedAt).toBe(T0.toISOString());
    expect(w!.toCapturedAt).toBe(T1.toISOString());
    expect(w!.spanSec).toBe(600);
    expect(w!.requests).toBe(2);
    expect(w!.byStatus).toEqual({ '2xx': 1, '3xx': 0, '4xx': 1, '5xx': 0 });
    expect(w!.fiveXxRatePct).toBe(0);
    expect(w!.avgMs).toBe(5.5); // (4 + 7) / 2

    // Delta histogram (bounds are the registry's own 11 + +Inf):
    expect(w!.histogram.map((b) => b.count)).toEqual([1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    // p50: rank 1 -> first delta bucket >=1 is leMs=5. p95/p99: rank 2 —
    // reached only at leMs=10.
    expect(w!.p50Ms).toBe(5);
    expect(w!.p95Ms).toBe(10);
    expect(w!.p99Ms).toBe(10);

    // Per-route window tallies, ties sorted by route name:
    expect(w!.routes).toEqual([
      { route: 'GET /a', requests: 1, byStatus: { '2xx': 1, '3xx': 0, '4xx': 0, '5xx': 0 }, avgMs: 4 },
      { route: 'POST /b', requests: 1, byStatus: { '2xx': 0, '3xx': 0, '4xx': 1, '5xx': 0 }, avgMs: 7 },
    ]);
  });

  it('an identical pair (zero window) reports zeros with null percentiles, never division by zero', () => {
    const reg = new RequestMetricsRegistry();
    reg.record('GET /a', 200, 12);
    const snap = reg.snapshot(T0);
    const w = computeWindowDelta(snap, snap);
    expect(w).not.toBeNull();
    expect(w!.requests).toBe(0);
    expect(w!.avgMs).toBeNull();
    expect(w!.p50Ms).toBeNull();
    expect(w!.p95Ms).toBeNull();
    expect(w!.fiveXxRatePct).toBeNull();
    expect(w!.routes).toEqual([]);
    expect(w!.histogram.every((b) => b.count === 0)).toBe(true);
  });

  it('percentile estimates that land past the last bound report null, not an invented number', () => {
    const reg = new RequestMetricsRegistry();
    reg.record('GET /slow', 200, 1);
    const prev = reg.snapshot(T0);
    reg.record('GET /slow', 200, 60000); // beyond 10000 — only +Inf grows
    const cur = reg.snapshot(T1);
    const w = computeWindowDelta(prev, cur);
    expect(w!.requests).toBe(1);
    expect(w!.p95Ms).toBeNull();
    expect(w!.histogram[w!.histogram.length - 1].count).toBe(1);
  });

  it('a 5xx in the window surfaces fiveXxRatePct exactly (the error-budget denominator that survives restarts)', () => {
    const reg = new RequestMetricsRegistry();
    for (let i = 0; i < 10; i++) reg.record('GET /a', 200, 5);
    const prev = reg.snapshot(T0);
    reg.record('GET /a', 200, 5);
    reg.record('GET /a', 503, 5);
    const cur = reg.snapshot(T1);
    const w = computeWindowDelta(prev, cur);
    expect(w!.requests).toBe(2);
    expect(w!.byStatus['5xx']).toBe(1);
    expect(w!.fiveXxRatePct).toBe(50);
  });

  it('caps the route list at WINDOW_TOP_ROUTES, most-requested first', () => {
    const reg = new RequestMetricsRegistry();
    reg.record('GET /seed', 200, 5); // baseline keeps prev/cur key sets equal
    const prev = reg.snapshot(T0);
    for (let i = 0; i < WINDOW_TOP_ROUTES + 4; i++) {
      for (let j = 0; j <= i % 3; j++) reg.record(`GET /r${i}`, 200, 5);
    }
    reg.record('GET /seed', 200, 5);
    const cur = reg.snapshot(T1);
    const w = computeWindowDelta(prev, cur);
    expect(w!.routes.length).toBe(WINDOW_TOP_ROUTES);
    expect(w!.routes[0].requests).toBeGreaterThanOrEqual(w!.routes[1].requests);
  });

  // ---- integrity guards: a non-monotonic or mismatched pair is NULL, never a clamped fiction ----

  it('swapped pair (more traffic in the baseline) -> null', () => {
    const reg = new RequestMetricsRegistry();
    reg.record('GET /a', 200, 5);
    const only = reg.snapshot(T0);
    reg.record('GET /a', 200, 5);
    const more = reg.snapshot(T1);
    expect(computeWindowDelta(more, only)).toBeNull();
  });

  it('a route key missing from the CURRENT side (impossible within one boot) -> null', () => {
    const reg = new RequestMetricsRegistry();
    reg.record('GET /a', 200, 5);
    reg.record('GET /gone', 200, 5);
    const prev = reg.snapshot(T0);
    const reg2 = new RequestMetricsRegistry();
    reg2.record('GET /a', 200, 5);
    reg2.record('GET /a', 200, 5);
    const cur = reg2.snapshot(T1);
    expect(computeWindowDelta(prev, cur)).toBeNull();
  });

  it('different boundsMs between the pair -> null', () => {
    const reg = new RequestMetricsRegistry();
    reg.record('GET /a', 200, 5);
    const prev = reg.snapshot(T0);
    const cur: MetricsSnapshot = { ...reg.snapshot(T1), boundsMs: [1, 2, 3] };
    expect(computeWindowDelta(prev, cur)).toBeNull();
  });

  it('non-snapshot garbage (operator-edited jsonb) never reaches arithmetic', () => {
    expect(isSnapshotShape(null)).toBe(false);
    expect(isSnapshotShape({})).toBe(false);
    expect(isSnapshotShape('nope')).toBe(false);
    expect(isSnapshotShape({ generatedAt: 'x', boundsMs: ['a'], totals: { requests: 1 }, routes: [] })).toBe(false);
    const reg = new RequestMetricsRegistry();
    expect(isSnapshotShape(reg.snapshot(T0))).toBe(true);
    const snap = reg.snapshot(T0);
    expect(computeWindowDelta({} as unknown as MetricsSnapshot, snap)).toBeNull();
  });
});
