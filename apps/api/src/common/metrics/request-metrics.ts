/**
 * In-process request metrics: per-route counters + a fixed duration
 * histogram + status-class tallies. Zero dependencies (no DI, no timers,
 * no I/O) so the registry is trivially unit-testable and can be shared by
 * the middleware, the service and the ADMIN snapshot route.
 *
 * Cardinality is bounded twice over: route keys come from the MATCHED
 * Express route template (`/api/orders/:id`, never the concrete uuid),
 * unmatched paths collapse uuid/numeric segments, and a hard key cap folds
 * anything new into an `other` bucket. A hostile path flood can therefore
 * never grow this map unboundedly.
 *
 * Cumulative-since-boot totals by design: the periodic pino fold and the
 * ADMIN route both expose the same snapshot, and alerting computes deltas
 * between consecutive log lines. v1 deliberately has no ring buffers.
 */

export const HISTOGRAM_BOUNDS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;

/** Hard cap on distinct route keys; keys beyond it fold into OVERFLOW_KEY. */
export const MAX_ROUTE_KEYS = 250;
export const OVERFLOW_KEY = 'other';

/** Unmatched paths longer than this are truncated (junk flood guard). */
const MAX_PATH_LEN = 96;

export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';

export function statusClassOf(status: number): StatusClass {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

/**
 * Liveness probes are ignored by the access logger too (pino-http
 * autoLogging.ignore) — kept out of the metrics stream for the same
 * reason: they would drown real traffic in the periodic fold.
 */
export function shouldTrackUrl(url: string | undefined): boolean {
  return typeof url === 'string' && !url.startsWith('/api/health');
}

const UUID_SEG = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi;
const NUMERIC_SEG = /\/\d+(?=\/|$)/g;

/** Exported for specs; used by routeKeyOf on unmatched paths. */
export function normalizeUnmatched(url: string): string {
  const path = url.split('?')[0] || '/';
  const collapsed = path.replace(UUID_SEG, '/:id').replace(NUMERIC_SEG, '/:id');
  return collapsed.length > MAX_PATH_LEN ? collapsed.slice(0, MAX_PATH_LEN) : collapsed;
}

/**
 * `METHOD /matched/route/template`. `req.route` is set once Express has
 * matched the handler chain — this is called at response-FINISH time, well
 * after routing, so the template is reliably present for every controller
 * route. Requests that matched NO route (404, stray paths) fall back to the
 * normalized url.
 */
export function routeKeyOf(req: {
  method?: string;
  url?: string;
  baseUrl?: string;
  route?: { path?: string };
}): string {
  const method = req.method ?? 'ANY';
  const matched = req.route?.path;
  const path = matched ? `${req.baseUrl ?? ''}${matched}` : normalizeUnmatched(req.url ?? '/');
  return `${method} ${path}`;
}

export interface HistogramBucket {
  /** Inclusive upper bound in ms; null = +Inf (everything above the last bound). */
  leMs: number | null;
  count: number;
}

export interface MetricsRouteRow {
  route: string;
  requests: number;
  byStatus: Record<StatusClass, number>;
  sumMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  histogram: HistogramBucket[];
}

export interface MetricsSnapshot {
  generatedAt: string;
  uptimeSec: number;
  boundsMs: number[];
  totals: {
    requests: number;
    byStatus: Record<StatusClass, number>;
    routeKeys: number;
    overflowed: boolean;
    avgMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    maxMs: number | null;
  };
  routes: MetricsRouteRow[];
}

interface RouteAgg {
  count: number;
  byStatus: Record<StatusClass, number>;
  sumMs: number;
  minMs: number;
  maxMs: number;
  /** Cumulative counts: bucketCounts[i] = samples <= HISTOGRAM_BOUNDS_MS[i]; last slot = +Inf = count. */
  bucketCounts: number[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

function freshAgg(): RouteAgg {
  return {
    count: 0,
    byStatus: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
    sumMs: 0,
    minMs: Infinity,
    maxMs: 0,
    bucketCounts: new Array<number>(HISTOGRAM_BOUNDS_MS.length + 1).fill(0),
  };
}

function addSample(agg: RouteAgg, status: number, durationMs: number): void {
  agg.count += 1;
  agg.byStatus[statusClassOf(status)] += 1;
  agg.sumMs += durationMs;
  if (durationMs < agg.minMs) agg.minMs = durationMs;
  if (durationMs > agg.maxMs) agg.maxMs = durationMs;
  for (let i = 0; i < HISTOGRAM_BOUNDS_MS.length; i++) {
    if (durationMs <= HISTOGRAM_BOUNDS_MS[i]) agg.bucketCounts[i] += 1;
  }
  agg.bucketCounts[HISTOGRAM_BOUNDS_MS.length] += 1;
}

/**
 * Nearest-rank percentile estimated from the cumulative histogram: the
 * FIRST bound whose cumulative count reaches rank. Honest by
 * construction — always >= the true value, never below the previous bound.
 */
function percentile(agg: RouteAgg, q: number): number | null {
  if (agg.count === 0) return null;
  const rank = Math.ceil(q * agg.count);
  for (let i = 0; i < HISTOGRAM_BOUNDS_MS.length; i++) {
    if (agg.bucketCounts[i] >= rank) return HISTOGRAM_BOUNDS_MS[i];
  }
  return round1(agg.maxMs);
}

function histogramOf(agg: RouteAgg): HistogramBucket[] {
  const buckets: HistogramBucket[] = HISTOGRAM_BOUNDS_MS.map((b, i) => ({ leMs: b, count: agg.bucketCounts[i] }));
  buckets.push({ leMs: null, count: agg.bucketCounts[HISTOGRAM_BOUNDS_MS.length] });
  return buckets;
}

function rowOf(route: string, agg: RouteAgg): MetricsRouteRow {
  return {
    route,
    requests: agg.count,
    byStatus: { ...agg.byStatus },
    sumMs: Math.round(agg.sumMs),
    avgMs: round1(agg.sumMs / agg.count),
    minMs: round1(agg.minMs),
    maxMs: round1(agg.maxMs),
    p50Ms: percentile(agg, 0.5),
    p95Ms: percentile(agg, 0.95),
    p99Ms: percentile(agg, 0.99),
    histogram: histogramOf(agg),
  };
}

export class RequestMetricsRegistry {
  private readonly routes = new Map<string, RouteAgg>();
  private startedAt = Date.now();
  private overflowed = false;

  constructor(private readonly maxKeys: number = MAX_ROUTE_KEYS) {}

  record(key: string, status: number, durationMs: number): void {
    let agg = this.routes.get(key);
    if (!agg) {
      const folding = this.routes.size >= this.maxKeys && key !== OVERFLOW_KEY;
      const mapKey = folding ? OVERFLOW_KEY : key;
      if (folding) this.overflowed = true;
      agg = this.routes.get(mapKey) ?? freshAgg();
      this.routes.set(mapKey, agg);
    }
    addSample(agg, status, durationMs);
  }

  snapshot(now: Date = new Date()): MetricsSnapshot {
    const rows = [...this.routes.entries()]
      .map(([route, agg]) => rowOf(route, agg))
      .sort((a, b) => (b.requests - a.requests) || a.route.localeCompare(b.route));

    // Cumulative histogram counts are additive across routes, so the
    // global row merges with a plain element-wise sum.
    const merged = freshAgg();
    for (const agg of this.routes.values()) {
      merged.count += agg.count;
      for (const cls of ['2xx', '3xx', '4xx', '5xx'] as const) merged.byStatus[cls] += agg.byStatus[cls];
      merged.sumMs += agg.sumMs;
      if (agg.minMs < merged.minMs) merged.minMs = agg.minMs;
      if (agg.maxMs > merged.maxMs) merged.maxMs = agg.maxMs;
      for (let i = 0; i < merged.bucketCounts.length; i++) merged.bucketCounts[i] += agg.bucketCounts[i];
    }

    return {
      generatedAt: now.toISOString(),
      uptimeSec: Math.max(0, Math.round((now.getTime() - this.startedAt) / 1000)),
      boundsMs: [...HISTOGRAM_BOUNDS_MS],
      totals: {
        requests: merged.count,
        byStatus: { ...merged.byStatus },
        routeKeys: this.routes.has(OVERFLOW_KEY) ? this.routes.size - 1 : this.routes.size,
        overflowed: this.overflowed,
        avgMs: merged.count === 0 ? null : round1(merged.sumMs / merged.count),
        p50Ms: percentile(merged, 0.5),
        p95Ms: percentile(merged, 0.95),
        p99Ms: percentile(merged, 0.99),
        maxMs: merged.count === 0 ? null : round1(merged.maxMs),
      },
      routes: rows,
    };
  }

  /** Test-only: return to a pristine state. */
  reset(): void {
    this.routes.clear();
    this.startedAt = Date.now();
    this.overflowed = false;
  }
}
