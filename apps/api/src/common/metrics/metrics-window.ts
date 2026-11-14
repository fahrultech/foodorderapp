/**
 * Window deltas over the DI-free cumulative metrics snapshots.
 *
 * The live registry is cumulative-since-boot; persisted snapshots
 * (`metrics_snapshots`, MetricsPersistenceService) are full copies taken at
 * capture time. Because BOTH are cumulative and monotonic WITHIN one process
 * boot, subtracting an earlier same-boot snapshot from the live one yields
 * the traffic that happened in between — the "window" the roadmap item asks
 * for, replacing "since boot" as the error-budget denominator after enough
 * history exists.
 *
 * Honesty rules encoded here:
 *  - ANY negative subtraction result means the pair cannot describe one
 *    monotonic cumulative stream (cross-boot garbage, restored/partial row,
 *    a route key that vanished) → the whole window is `null`, never a
 *    clamped-to-zero fiction.
 *  - Percentiles are estimated from the DELTA histogram with the same
 *    nearest-bound rule as the registry (always >= the true value); a rank
 *    landing in the +Inf bucket has no honest bound → `null`.
 *  - min/max cannot be subtracted from cumulative tallies — deliberately
 *    absent from the window shape.
 */
import {
  HistogramBucket,
  MetricsSnapshot,
  StatusClass,
} from './request-metrics';

export const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;

/** Route rows are capped in the window payload to keep responses bounded. */
export const WINDOW_TOP_ROUTES = 10;

export interface MetricsWindowRouteDelta {
  route: string;
  requests: number;
  byStatus: Record<StatusClass, number>;
  /** avgMs over the WINDOW samples only (delta sumMs / delta requests); null when no samples. */
  avgMs: number | null;
}

export interface MetricsWindowDelta {
  /** ISO timestamp of the baseline snapshot (its `generatedAt`). */
  fromCapturedAt: string;
  /** ISO timestamp of the live snapshot (its `generatedAt`). */
  toCapturedAt: string;
  spanSec: number;
  requests: number;
  byStatus: Record<StatusClass, number>;
  /** 5xx share of the window in percent, 3 decimals; null when the window saw no requests. */
  fiveXxRatePct: number | null;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  /** Cumulative delta histogram over the window (same bounds as the registry + +Inf). */
  histogram: HistogramBucket[];
  /** Top routes by WINDOW requests (METHOD /template keys, never concrete ids). */
  routes: MetricsWindowRouteDelta[];
}

export interface MetricsDurability {
  /** False when METRICS_SNAPSHOT_INTERVAL_SEC=0 — nothing is written, nothing is read. */
  enabled: boolean;
  snapshotIntervalSec: number;
  retentionSec: number;
  /** ISO timestamp of the LIVE registry's boot (uptime window anchor). */
  bootStartedAt: string;
  /** Rows currently stored; null when disabled or the store could not be read. */
  stored: number | null;
  /** capturedAt of the newest stored row; null when none / unreadable / disabled. */
  lastCapturedAt: string | null;
  /**
   * True = the newest row was written by THIS boot, so `window` is
   * computable. False = the newest row predates this boot (fresh restart —
   * window stays null until the next snapshot lands). null = no rows /
   * disabled / store error.
   */
  bootAligned: boolean | null;
  /** The snapshot store could not be read on this call (route still 200s — a dead smoke detector must never 5xx). */
  error: boolean;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const pct3 = (part: number, whole: number): number | null =>
  whole <= 0 ? null : Math.round((part / whole) * 100 * 1000) / 1000;

/** Cheap shape guard: stored jsonb is operator-editable, so never trust it blindly. */
export function isSnapshotShape(v: unknown): v is MetricsSnapshot {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.generatedAt === 'string' &&
    Array.isArray(s.boundsMs) &&
    s.boundsMs.every((b) => typeof b === 'number' && Number.isFinite(b)) &&
    typeof s.totals === 'object' &&
    s.totals !== null &&
    typeof (s.totals as Record<string, unknown>).requests === 'number' &&
    Array.isArray(s.routes)
  );
}

/**
 * Element-wise cumulative-bucket sums over every route row. Bucket layout is
 * taken from the snapshot's OWN boundsMs (length + 1 for +Inf), so the
 * function stays correct across future bound-set changes — a row whose
 * histograms do not match that layout makes the pair inconsistent → null.
 */
function mergedBuckets(snapshot: MetricsSnapshot): number[] | null {
  const size = snapshot.boundsMs.length + 1;
  const merged = new Array<number>(size).fill(0);
  for (const row of snapshot.routes) {
    if (!Array.isArray(row.histogram) || row.histogram.length !== size) return null;
    for (let i = 0; i < size; i++) {
      const c = row.histogram[i].count;
      if (typeof c !== 'number' || !Number.isFinite(c) || c < 0) return null;
      merged[i] += c;
    }
  }
  return merged;
}

/** Nearest-bound percentile from a CUMULATIVE bucket array; null past the last bound. */
function percentileFromBuckets(bounds: readonly number[], buckets: number[], count: number, q: number): number | null {
  if (count <= 0) return null;
  const rank = Math.ceil(q * count);
  for (let i = 0; i < bounds.length; i++) {
    if (buckets[i] >= rank) return bounds[i];
  }
  return null;
}

/**
 * previous -> current subtraction over two cumulative snapshots. Returns the
 * delta window, or null when the pair cannot describe one monotonic stream.
 * Callers are responsible for boot alignment (this function only checks the
 * arithmetic; a cross-boot pair FAILS the monotonicity guards in practice,
 * but the service compares boot stamps BEFORE ever calling here).
 */
export function computeWindowDelta(
  previous: MetricsSnapshot,
  current: MetricsSnapshot,
): MetricsWindowDelta | null {
  if (!isSnapshotShape(previous) || !isSnapshotShape(current)) return null;
  if (previous.boundsMs.join(',') !== current.boundsMs.join(',')) return null;

  const totalDelta = current.totals.requests - previous.totals.requests;
  if (!Number.isInteger(totalDelta) || totalDelta < 0) return null;

  const byStatus = {} as Record<StatusClass, number>;
  for (const cls of STATUS_CLASSES) {
    const d = (current.totals.byStatus?.[cls] ?? 0) - (previous.totals.byStatus?.[cls] ?? 0);
    if (!Number.isInteger(d) || d < 0) return null;
    byStatus[cls] = d;
  }

  const prevBuckets = mergedBuckets(previous);
  const curBuckets = mergedBuckets(current);
  if (!prevBuckets || !curBuckets) return null;
  const size = current.boundsMs.length + 1;
  const histogramBuckets = new Array<number>(size);
  for (let i = 0; i < size; i++) {
    histogramBuckets[i] = curBuckets[i] - prevBuckets[i];
    if (histogramBuckets[i] < 0) return null;
  }

  // Route-key tallies: every PREVIOUS key must still exist in CURRENT — the
  // registry never drops keys within one boot, so absence = inconsistent pair.
  const prevRows = new Map(previous.routes.map((r) => [r.route, r]));
  const curRows = new Map(current.routes.map((r) => [r.route, r]));
  for (const key of prevRows.keys()) {
    if (!curRows.has(key)) return null;
  }

  let sumMsDelta = 0;
  const routes: MetricsWindowRouteDelta[] = [];
  for (const row of current.routes) {
    const prev = prevRows.get(row.route);
    const reqDelta = row.requests - (prev?.requests ?? 0);
    if (reqDelta < 0) return null;
    const rowByStatus = {} as Record<StatusClass, number>;
    for (const cls of STATUS_CLASSES) {
      const d = (row.byStatus?.[cls] ?? 0) - (prev?.byStatus?.[cls] ?? 0);
      if (d < 0) return null;
      rowByStatus[cls] = d;
    }
    const sumDelta = Math.round(row.sumMs) - Math.round(prev?.sumMs ?? 0);
    if (sumDelta < 0) return null;
    sumMsDelta += sumDelta;
    if (reqDelta > 0) {
      routes.push({
        route: row.route,
        requests: reqDelta,
        byStatus: rowByStatus,
        avgMs: round1(sumDelta / reqDelta),
      });
    }
  }
  routes.sort((a, b) => b.requests - a.requests || a.route.localeCompare(b.route));

  const fromMs = Date.parse(previous.generatedAt);
  const toMs = Date.parse(current.generatedAt);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;

  return {
    fromCapturedAt: previous.generatedAt,
    toCapturedAt: current.generatedAt,
    spanSec: Math.max(0, Math.round((toMs - fromMs) / 1000)),
    requests: totalDelta,
    byStatus,
    fiveXxRatePct: pct3(byStatus['5xx'], totalDelta),
    avgMs: totalDelta === 0 ? null : round1(sumMsDelta / totalDelta),
    p50Ms: percentileFromBuckets(current.boundsMs, histogramBuckets, totalDelta, 0.5),
    p95Ms: percentileFromBuckets(current.boundsMs, histogramBuckets, totalDelta, 0.95),
    p99Ms: percentileFromBuckets(current.boundsMs, histogramBuckets, totalDelta, 0.99),
    histogram: [
      ...current.boundsMs.map((leMs, i) => ({ leMs, count: histogramBuckets[i] })),
      { leMs: null, count: histogramBuckets[size - 1] },
    ],
    routes: routes.slice(0, WINDOW_TOP_ROUTES),
  };
}
