/**
 * Delivery ETA honesty (Phase 11 product item, session 113).
 *
 * The storefront previously displayed only the curated `avgPrepMinutes`
 * estimate. This module derives an HONEST per-restaurant delivery ETA from
 * real completed orders: the MEDIAN confirmed→completed duration of the
 * LAST `ETA_WINDOW` (20) completed orders, in INTEGER SECONDS. Below
 * `ETA_MIN_SAMPLES` (5) samples the estimate branch stays in charge —
 * 1-2 lucky/unlucky orders must not rewrite the storefront's promise.
 *
 * Rules encoded here (mirrored in ARCHITECTURE.md):
 * - A sample is an order with `status='completed'`, BOTH timestamps set,
 *   and `completedAt > confirmedAt` — garbage (inverted/clock-skew) rows
 *   are EXCLUDED from both the count and the median.
 * - `sampleCount` is the FULL eligible count (not windowed at 20): the UI
 *   tooltip says "based on the last 20" style honesty only when observed.
 * - The seed/curated `avgPrepMinutes` is never overwritten — the ETA is a
 *   READ-TIME derivation, so a backfilled order changes the answer on the
 *   next request with zero writes (the same derivation doctrine as
 *   session 68's `isOpenNow`).
 * - DI-free and date-free: every input arrives via the batched SQL, so the
 *   pure builder below is unit-testable without a DB or a clock.
 */

export const ETA_MIN_SAMPLES = 5;
export const ETA_WINDOW = 20;

/** Fallback estimate when `avgPrepMinutes` itself is unusable (entity default is 30). */
export const ETA_DEFAULT_PREP_MINUTES = 30;

export type DeliveryEtaSource = 'observed' | 'estimate';

export interface DeliveryEtaView {
  /** 'observed' = median of real recent durations; 'estimate' = curated avgPrepMinutes. */
  source: DeliveryEtaSource;
  /** Integer seconds — durations never leave this module as floats. */
  seconds: number;
  /**
   * Eligible completed orders behind the derivation (ALL of them, not the
   * 20-row median window). 0 when nothing eligible exists. <5 always
   * renders with source='estimate'.
   */
  sampleCount: number;
}

/** One grouped row from `DELIVERY_ETA_SQL` (driver may hand back string numerics). */
export interface EtaSqlRow {
  rid: string;
  samples: number | string;
  median_seconds: number | string;
}

/**
 * ONE batched statement per restaurant-detail read (the session-65/66/68
 * no-N+1 contract: a single parameterized query for the whole rows set, never
 * a per-restaurant loop). Positional `$1` is the restaurant-id uuid array —
 * raw SQL through the repository (session 104 rule: positional params only).
 *
 * The CTE ranks eligible orders per restaurant newest-first AND counts them;
 * the outer GROUP BY takes the median over the newest ETA_WINDOW rows while
 * MAX(samples) carries the FULL eligible count out of the window.
 */
export const DELIVERY_ETA_SQL = `
WITH eligible AS (
  SELECT
    o."restaurantId" AS rid,
    EXTRACT(EPOCH FROM (o."completedAt" - o."confirmedAt"))::int AS seconds,
    ROW_NUMBER() OVER (
      PARTITION BY o."restaurantId"
      ORDER BY o."completedAt" DESC, o."id" DESC
    ) AS rn,
    COUNT(*) OVER (PARTITION BY o."restaurantId")::int AS samples
  FROM orders o
  WHERE o.status = 'completed'
    AND o."confirmedAt" IS NOT NULL
    AND o."completedAt" IS NOT NULL
    AND o."completedAt" > o."confirmedAt"
    AND o."restaurantId" = ANY($1::uuid[])
)
SELECT rid, MAX(samples) AS samples, percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) AS median_seconds
FROM eligible
WHERE rn <= ${ETA_WINDOW}
GROUP BY rid
`;

/** Whole minutes -> integer seconds, with the entity's 30-minute default guarding garbage. */
function estimateSeconds(avgPrepMinutes: number | null | undefined): number {
  const raw = typeof avgPrepMinutes === 'number' ? avgPrepMinutes : Number(avgPrepMinutes);
  // 0 is as unusable as garbage for an ETA floor — a "0 minute" promise is a
  // lie either way, so the curated default answers it.
  const minutes =
    Number.isFinite(raw) && raw > 0 ? Math.round(raw) : ETA_DEFAULT_PREP_MINUTES;
  return minutes * 60;
}

/**
 * Pure builder: one SQL row (or none = no eligible orders) + the restaurant's
 * curated estimate -> the view the storefront consumes. NEVER fabricates
 * 'observed': fewer than ETA_MIN_SAMPLES samples always answers 'estimate',
 * and a garbage median falls back to the estimate too.
 */
export function buildDeliveryEta(
  row: EtaSqlRow | undefined,
  avgPrepMinutes: number | null | undefined,
): DeliveryEtaView {
  const samples = row ? Number(row.samples) : 0;
  const safeSamples = Number.isFinite(samples) && samples >= 0 ? Math.floor(samples) : 0;
  const estimate = (count: number): DeliveryEtaView => ({
    source: 'estimate',
    seconds: estimateSeconds(avgPrepMinutes),
    sampleCount: count,
  });
  if (!row || safeSamples < ETA_MIN_SAMPLES) return estimate(safeSamples);
  const median = Number(row.median_seconds);
  if (!Number.isFinite(median) || median <= 0) return estimate(safeSamples);
  return {
    source: 'observed',
    seconds: Math.max(1, Math.round(median)),
    sampleCount: safeSamples,
  };
}
