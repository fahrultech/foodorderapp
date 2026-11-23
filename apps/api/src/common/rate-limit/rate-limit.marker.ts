/**
 * The guard-throttle marker (session 123, Phase 13 rate-limit telemetry).
 *
 * `RateLimitGuard` stamps a request it BLOCKS with the bucket name BEFORE
 * throwing the 429. The request-metrics middleware reads the stamp at
 * response-finish time and only then counts a `throttled` sample — so the
 * counter means "THE GUARD actually shed this request", not "some response
 * happened to carry status 429". A hypothetical future 429 producer outside
 * the guard is therefore never silently folded into limiter pressure, and
 * a guard rejection whose response never reaches 429 (filter rewrite,
 * transport error) never inflates it either: the middleware demands BOTH
 * the marker and the final 429 status.
 *
 * DI-free on purpose (same doctrine as the metrics registry): the guard
 * module owns the key, the metrics module imports the reader, neither can
 * form a cycle through Nest providers.
 */

const RATE_LIMITED_BUCKET_KEY = '__foodorderRateLimitedBucket';

/** Called by RateLimitGuard immediately before throwing the RATE_LIMITED 429. */
export function markRateLimited(req: unknown, bucket: string): void {
  if (req && typeof req === 'object') {
    (req as Record<string, unknown>)[RATE_LIMITED_BUCKET_KEY] = bucket;
  }
}

/** The bucket the guard blocked this request under, or null when never throttled. */
export function rateLimitedBucketOf(req: unknown): string | null {
  if (!req || typeof req !== 'object') return null;
  const value = (req as Record<string, unknown>)[RATE_LIMITED_BUCKET_KEY];
  return typeof value === 'string' ? value : null;
}
