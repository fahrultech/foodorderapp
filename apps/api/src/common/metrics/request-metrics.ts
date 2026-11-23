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
 *
 * Restaurant dimension (session 98, Phase 8 "per-restaurant traffic for
 * owners"): samples whose MATCHED route template is restaurant-scoped
 * (`restaurantScopeOf`) additionally land in a per-restaurant sub-registry
 * of the SAME route-key space. Creation is success-gated — since session
 * 103 a bucket is minted ONLY by a 2xx (a fresh 304 revalidation proves a
 * browser cache, not this boot serving the page, so it may top up an
 * existing bucket but never create one; probe floods of random-but-valid
 * uuids 404 and never mint; 4xx/5xx may only top up an existing bucket,
 * so owners also see errors ON their surfaces); the id set is capped like
 * the route set, and the metrics-read route itself is EXEMPT so an owner
 * polling their own traffic never inflates it.
 * A per-restaurant snapshot can NEVER contain unattributed or foreign
 * samples — that separation is the OWNER-rung safety contract (session 85
 * decision: the global snapshot stays ADMIN-only).
 *
 * Rate-limit dimension (session 123, Phase 13 "rate-limit pressure
 * telemetry"): a sample may additionally carry `throttled = true`, set by
 * the metrics middleware ONLY when the RateLimitGuard stamped the request
 * AND the response finished as 429. Route rows and the GLOBAL totals gain
 * an additive `throttled` count so a store silently shedding customers is
 * visible between the limiter headers and the complaint. The counter is
 * deliberately GLOBAL-ONLY: `restaurantSnapshot()` never emits the key
 * (neither rows nor totals), keeping the pinned OWNER-rung shape from
 * sessions 85/98/116 byte-identical — per-restaurant limiter pressure is
 * ADMIN telemetry, not an owner-facing field.
 */

export const HISTOGRAM_BOUNDS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;

/** Hard cap on distinct route keys; keys beyond it fold into OVERFLOW_KEY. */
export const MAX_ROUTE_KEYS = 250;
export const OVERFLOW_KEY = 'other';

/**
 * Hard cap on distinct restaurant buckets. New ids BEYOND the cap are not
 * attributed (unlike route keys there is no honest fold: merging restaurant
 * A's traffic into bucket "other" would hand it to an owner who never
 * served it, while the GLOBAL registry still tallies everything).
 */
export const MAX_RESTAURANT_KEYS = 250;

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

/**
 * Explicit restaurant dimension (session 98): which concrete restaurant a
 * matched request concerns. Deliberately keyed on the MATCHED TEMPLATE,
 * never the url shape — only restaurant-scoped controllers get attributed:
 * the parameter directly after `/restaurants/` is a restaurant id by
 * CONSTRUCTION on those routes (`GET/PATCH /api/restaurants/:id`,
 * `:id/hours`, `:id/orders*`, `:id/reviews`, `:restaurantId/menu`). Routes
 * elsewhere that also carry `:id` (`/menu/items/:id`, `/orders/:id`) are
 * NOT restaurants — a url-only heuristic would misattribute them.
 *
 * The metrics read itself (`/api/restaurants/:id/metrics`) is EXEMPT: a
 * dashboard polling its own traffic must never inflate it.
 *
 * Returns the lowercased uuid, or null when the request is unattributable
 * (unmatched, non-restaurant template, metrics route, or a non-uuid-shaped
 * segment — ParseUUIDPipe would 400 those anyway; this is defence in depth).
 */
const RESTAURANT_TEMPLATE_RE = /^\/api\/restaurants\/:(?:id|restaurantId)(?:\/|$)/;
const RESTAURANT_METRICS_TEMPLATE_RE = /^\/api\/restaurants\/:(?:id|restaurantId)\/metrics\/?$/;
const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function restaurantScopeOf(req: {
  url?: string;
  baseUrl?: string;
  route?: { path?: string };
}): string | null {
  if (!req.route) return null; // unmatched junk must NEVER mint a bucket
  const template = `${req.baseUrl ?? ''}${req.route.path ?? ''}`;
  if (RESTAURANT_METRICS_TEMPLATE_RE.test(template)) return null; // observer exemption
  if (!RESTAURANT_TEMPLATE_RE.test(template)) return null;
  const seg = (req.url ?? '').split('?')[0].split('/')[3];
  return seg && UUID_SHAPE_RE.test(seg) ? seg.toLowerCase() : null;
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
  /**
   * Guard-throttled responses (429) for this route (session 123). Present
   * ONLY on rows from the GLOBAL snapshot — restaurant views never carry
   * the key (OWNER-rung shape contract). Subset of `byStatus['4xx']`.
   */
  throttled?: number;
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
    /** Guard-throttled 429 total across all routes (session 123; GLOBAL-only field). */
    throttled: number;
    routeKeys: number;
    overflowed: boolean;
    /** Distinct success-created restaurant buckets (session 98 dimension). */
    restaurantKeys: number;
    /** True when the restaurant bucket cap tripped and samples were NOT attributed. */
    restaurantOverflowed: boolean;
    avgMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    maxMs: number | null;
  };
  routes: MetricsRouteRow[];
}

/**
 * Per-restaurant traffic view (session 98) — the SAME row/histogram shape
 * as the global snapshot but restricted to samples attributed to ONE
 * restaurant. It can never carry foreign or unattributed traffic, and it
 * never carries the global totals (OWNER-rung safety contract, session 85
 * decision). Cumulative since boot, exactly like the global snapshot.
 */
export interface RestaurantTrafficSnapshot {
  restaurantId: string;
  scope: 'restaurant';
  window: 'since_api_boot';
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

/**
 * What the durability scheduler STORES per tick: the global snapshot plus
 * the FULL restaurant dimension (session-116 per-restaurant durability).
 * Old rows legitimately lack `restaurants` — readers treat absence as
 * "not persisted yet", never as "no restaurants had traffic".
 */
export type PersistedMetricsSnapshot = MetricsSnapshot & {
  restaurants?: Record<string, RestaurantTrafficSnapshot>;
};

interface RouteAgg {
  count: number;
  byStatus: Record<StatusClass, number>;
  /** Guard-throttled 429 samples within this route (session 123). Counted on
   *  the GLOBAL map only — the restaurant fold path never sets it, so a
   *  bucket's agg carries a structural zero, never a claim. */
  throttled: number;
  sumMs: number;
  minMs: number;
  maxMs: number;
  /** Cumulative counts: bucketCounts[i] = samples <= HISTOGRAM_BOUNDS_MS[i]; last slot = +Inf = count. */
  bucketCounts: number[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

interface RestaurantBucket {
  routes: Map<string, RouteAgg>;
  /** Route-key cap tripped WITHIN this bucket. */
  overflowed: boolean;
}

function freshAgg(): RouteAgg {
  return {
    count: 0,
    byStatus: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
    throttled: 0,
    sumMs: 0,
    minMs: Infinity,
    maxMs: 0,
    bucketCounts: new Array<number>(HISTOGRAM_BOUNDS_MS.length + 1).fill(0),
  };
}

function addSample(agg: RouteAgg, status: number, durationMs: number, throttled = false): void {
  agg.count += 1;
  agg.byStatus[statusClassOf(status)] += 1;
  if (throttled) agg.throttled += 1;
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

function rowOf(route: string, agg: RouteAgg, withThrottled = false): MetricsRouteRow {
  const row: MetricsRouteRow = {
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
  // The key is present ONLY on the global view (session 123): the OWNER
  // rung emitted exactly these keys since session 98 and multiple specs
  // pin that set — a per-restaurant throttle tally is ADMIN telemetry.
  if (withThrottled) row.throttled = agg.throttled;
  return row;
}

export class RequestMetricsRegistry {
  private readonly routes = new Map<string, RouteAgg>();
  private readonly restaurantBuckets = new Map<string, RestaurantBucket>();
  private startedAt = Date.now();
  private overflowed = false;
  private restaurantCapTripped = false;

  constructor(
    private readonly maxKeys: number = MAX_ROUTE_KEYS,
    private readonly maxRestaurantKeys: number = MAX_RESTAURANT_KEYS,
  ) {}

  /**
   * Epoch ms of registry creation (re-stamped by reset()). The persistence
   * scheduler stamps every stored snapshot with this so a row can never be
   * subtracted across process boots.
   */
  get bootStartedAtMs(): number {
    return this.startedAt;
  }

  record(
    key: string,
    status: number,
    durationMs: number,
    restaurantId?: string | null,
    throttled = false,
  ): void {
    let agg = this.routes.get(key);
    if (!agg) {
      const folding = this.routes.size >= this.maxKeys && key !== OVERFLOW_KEY;
      const mapKey = folding ? OVERFLOW_KEY : key;
      if (folding) this.overflowed = true;
      agg = this.routes.get(mapKey) ?? freshAgg();
      this.routes.set(mapKey, agg);
    }
    addSample(agg, status, durationMs, throttled);

    // The restaurant fold NEVER carries the throttle tally (session 123):
    // the OWNER rung must not gain the field, and the middleware only
    // passes throttled=true on guard-blocked requests anyway.
    if (restaurantId) this.recordRestaurant(restaurantId, key, status, durationMs);
  }

  /**
   * Restaurant-dimension fold of an already-globally-recorded sample.
   * 2xx-ONLY CREATION (tightened in session 103 alongside the public-read
   * ETag cache): a bucket is minted only by a fresh 200/201 — the proof
   * that the id addresses a real, serving restaurant. A 304 revalidation
   * may only TOP UP an existing bucket: it proves the page existed in
   * someone's browser cache, not that this boot served it, so a cold
   * observer (post-restart, past the cap) must never mint a bucket via a
   * validator. 4xx/5xx probe floods of random-but-valid uuids therefore
   * never grow the key space, while real errors AND ETag revalidations ON
   * an already-provisioned surface still top up its bucket (owners see
   * failures and repeat traffic, not just first pageviews). Past the cap
   * new buckets are REFUSED (the sample stays global-only) — folding into
   * a shared "other" bucket would hand one owner another's traffic, the
   * one thing this dimension must never do.
   */
  private recordRestaurant(restaurantId: string, key: string, status: number, durationMs: number): void {
    let bucket = this.restaurantBuckets.get(restaurantId);
    if (!bucket) {
      const cls = statusClassOf(status);
      if (cls !== '2xx') return;
      if (this.restaurantBuckets.size >= this.maxRestaurantKeys) {
        this.restaurantCapTripped = true;
        return;
      }
      bucket = { routes: new Map<string, RouteAgg>(), overflowed: false };
      this.restaurantBuckets.set(restaurantId, bucket);
    }
    let agg = bucket.routes.get(key);
    if (!agg) {
      const folding = bucket.routes.size >= this.maxKeys && key !== OVERFLOW_KEY;
      const mapKey = folding ? OVERFLOW_KEY : key;
      if (folding) bucket.overflowed = true;
      agg = bucket.routes.get(mapKey) ?? freshAgg();
      bucket.routes.set(mapKey, agg);
    }
    addSample(agg, status, durationMs);
  }

  /** Rows + element-wise merged histogram for any route-keyed map. */
  private aggregate(
    map: Map<string, RouteAgg>,
    withThrottled = false,
  ): { rows: MetricsRouteRow[]; merged: RouteAgg } {
    const rows = [...map.entries()]
      .map(([route, agg]) => rowOf(route, agg, withThrottled))
      .sort((a, b) => (b.requests - a.requests) || a.route.localeCompare(b.route));

    // Cumulative histogram counts are additive across routes, so the
    // merged row is a plain element-wise sum.
    const merged = freshAgg();
    for (const agg of map.values()) {
      merged.count += agg.count;
      for (const cls of ['2xx', '3xx', '4xx', '5xx'] as const) merged.byStatus[cls] += agg.byStatus[cls];
      merged.throttled += agg.throttled;
      merged.sumMs += agg.sumMs;
      if (agg.minMs < merged.minMs) merged.minMs = agg.minMs;
      if (agg.maxMs > merged.maxMs) merged.maxMs = agg.maxMs;
      for (let i = 0; i < merged.bucketCounts.length; i++) merged.bucketCounts[i] += agg.bucketCounts[i];
    }
    return { rows, merged };
  }

  private totalsOf(merged: RouteAgg) {
    return {
      requests: merged.count,
      byStatus: { ...merged.byStatus },
      avgMs: merged.count === 0 ? null : round1(merged.sumMs / merged.count),
      p50Ms: percentile(merged, 0.5),
      p95Ms: percentile(merged, 0.95),
      p99Ms: percentile(merged, 0.99),
      maxMs: merged.count === 0 ? null : round1(merged.maxMs),
    };
  }

  snapshot(now: Date = new Date()): MetricsSnapshot {
    const { rows, merged } = this.aggregate(this.routes, true);
    return {
      generatedAt: now.toISOString(),
      uptimeSec: Math.max(0, Math.round((now.getTime() - this.startedAt) / 1000)),
      boundsMs: [...HISTOGRAM_BOUNDS_MS],
      totals: {
        ...this.totalsOf(merged),
        throttled: merged.throttled,
        routeKeys: this.routes.has(OVERFLOW_KEY) ? this.routes.size - 1 : this.routes.size,
        overflowed: this.overflowed,
        restaurantKeys: this.restaurantBuckets.size,
        restaurantOverflowed: this.restaurantCapTripped,
      },
      routes: rows,
    };
  }

  /**
   * The per-restaurant view the OWNER route serves. NEVER derived from the
   * global snapshot — built exclusively from this restaurant's own bucket,
   * so an empty bucket is an honest zero (no traffic since boot), never a
   * foreign sample leaking through a subtraction.
   */
  restaurantSnapshot(restaurantId: string, now: Date = new Date()): RestaurantTrafficSnapshot {
    const rid = restaurantId.toLowerCase();
    const bucket = this.restaurantBuckets.get(rid);
    const { rows, merged } = this.aggregate(bucket?.routes ?? new Map<string, RouteAgg>());
    return {
      restaurantId: rid,
      scope: 'restaurant',
      window: 'since_api_boot',
      generatedAt: now.toISOString(),
      uptimeSec: Math.max(0, Math.round((now.getTime() - this.startedAt) / 1000)),
      boundsMs: [...HISTOGRAM_BOUNDS_MS],
      totals: {
        ...this.totalsOf(merged),
        routeKeys: bucket ? (bucket.routes.has(OVERFLOW_KEY) ? bucket.routes.size - 1 : bucket.routes.size) : 0,
        overflowed: bucket?.overflowed ?? false,
      },
      routes: rows,
    };
  }

  /**
   * Persistence feed (session-116 per-restaurant durability): a snapshot
   * of EVERY minted restaurant bucket, keyed by lowercased restaurant id.
   * The durability scheduler stores this alongside the global snapshot so
   * the restaurant dimension survives restarts exactly like the global
   * totals do. An empty map means no bucket has been minted this boot —
   * distinct from an old row that carries no `restaurants` key at all.
   */
  restaurantEntries(now: Date = new Date()): Record<string, RestaurantTrafficSnapshot> {
    const out: Record<string, RestaurantTrafficSnapshot> = {};
    for (const rid of this.restaurantBuckets.keys()) out[rid] = this.restaurantSnapshot(rid, now);
    return out;
  }

  /** Test-only: return to a pristine state. */
  reset(): void {
    this.routes.clear();
    this.restaurantBuckets.clear();
    this.startedAt = Date.now();
    this.overflowed = false;
    this.restaurantCapTripped = false;
  }
}
