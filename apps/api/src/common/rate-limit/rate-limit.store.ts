/**
 * Rate-limit storage.
 *
 * The only implementation today is in-memory (single node). The seam is the
 * `RateLimitStore` interface: a Redis/multi-node store can replace it without
 * touching the guard, decorators, or response shapes.
 */

export interface RateLimitVerdict {
  /** False → the caller must be rejected with 429. */
  allowed: boolean;
  /** Requests permitted within the window. */
  limit: number;
  /** Requests left *after* this one (0 when blocked). */
  remaining: number;
  /** Ms until a slot frees up. Meaningful only when `allowed` is false. */
  retryAfterMs: number;
  /** Epoch ms when the current window usage is expected to reset. */
  resetAtMs: number;
}

export interface RateLimitStore {
  /**
   * Record one hit for `key` against `limit`/`windowMs` and return the
   * verdict. `nowMs` is injectable so specs test sliding behaviour without
   * sleeping; production callers omit it.
   */
  check(key: string, limit: number, windowMs: number, nowMs?: number): RateLimitVerdict;
  /** Forget everything (test helper; ops restarts are naturally clean). */
  reset(): void;
  /** Keys currently holding hits (introspection for tests/observability). */
  activeKeys(): string[];
}

interface Bucket {
  /** Ascending hit timestamps (ms epoch) still inside the window. */
  hits: number[];
  /** Window this bucket was first created with (for sweep math). */
  windowMs: number;
}

/**
 * Sliding-window log: one timestamp array per key, exact for our traffic
 * scale (hits expire within the window, so arrays stay ≤ limit entries).
 *
 * Memory hygiene: expired hits are dropped on every check, and a lazy sweep
 * (at most once per minute) deletes whole buckets whose newest hit has aged
 * out — idle clients never leak keys forever.
 */
export class SlidingWindowLogStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private nextSweepAtMs = 0;

  check(key: string, limit: number, windowMs: number, nowMs?: number): RateLimitVerdict {
    const now = nowMs ?? Date.now();
    if (now >= this.nextSweepAtMs) {
      this.sweep(now);
      this.nextSweepAtMs = now + Math.max(windowMs, 60_000);
    }

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { hits: [], windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.windowMs !== windowMs) {
      // Operator changed the window mid-run: rebase so old hits cannot
      // linger under a shorter new window.
      bucket.windowMs = windowMs;
    }

    // Drop hits that fell out of the window (oldest first; hits ascend).
    const floor = now - windowMs;
    let expired = 0;
    while (expired < bucket.hits.length && bucket.hits[expired] <= floor) expired++;
    if (expired > 0) bucket.hits.splice(0, expired);

    if (bucket.hits.length >= limit) {
      const retryAfterMs = Math.max(1, bucket.hits[0] + windowMs - now);
      return { allowed: false, limit, remaining: 0, retryAfterMs, resetAtMs: now + retryAfterMs };
    }

    bucket.hits.push(now);
    return {
      allowed: true,
      limit,
      remaining: limit - bucket.hits.length,
      retryAfterMs: 0,
      resetAtMs: now + windowMs,
    };
  }

  reset(): void {
    this.buckets.clear();
    this.nextSweepAtMs = 0;
  }

  activeKeys(): string[] {
    return [...this.buckets.keys()];
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const newest = bucket.hits[bucket.hits.length - 1];
      if (newest === undefined || newest + bucket.windowMs <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
