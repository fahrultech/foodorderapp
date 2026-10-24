import {
  RateLimitStore,
  SlidingWindowLogStore,
} from './rate-limit.store';

const W = 60_000; // window used across most cases

describe('SlidingWindowLogStore', () => {
  let store: SlidingWindowLogStore;

  beforeEach(() => {
    store = new SlidingWindowLogStore();
  });

  it('implements the RateLimitStore interface', () => {
    const asInterface: RateLimitStore = store;
    expect(typeof asInterface.check).toBe('function');
  });

  it('allows up to the limit and reports a shrinking remaining count', () => {
    const t0 = 1_000_000;
    const first = store.check('k', 3, W, t0);
    expect(first).toMatchObject({ allowed: true, limit: 3, remaining: 2, retryAfterMs: 0 });
    expect(store.check('k', 3, W, t0 + 1).remaining).toBe(1);
    expect(store.check('k', 3, W, t0 + 2).remaining).toBe(0);
  });

  it('blocks the request that exceeds the limit', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) store.check('k', 3, W, t0 + i);
    const blocked = store.check('k', 3, W, t0 + 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it('computes retryAfterMs from the oldest hit in the window', () => {
    const t0 = 1_000_000;
    store.check('k', 2, W, t0);
    store.check('k', 2, W, t0 + 10_000);
    // Oldest hit (t0) expires at t0+W; ask at t0+W-1000 → exactly 1000 ms.
    const blocked = store.check('k', 2, W, t0 + W - 1000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000);
    expect(blocked.resetAtMs).toBe(t0 + W);
  });

  it('slides the window: expired hits free slots without blocking', () => {
    const t0 = 1_000_000;
    store.check('k', 2, W, t0);
    store.check('k', 2, W, t0 + 5);
    expect(store.check('k', 2, W, t0 + 10).allowed).toBe(false);
    // t0 has now fallen out of the window (hits expire once now - hit > W...
    // strictly: hit <= now - W), so exactly one more is allowed.
    const after = store.check('k', 2, W, t0 + W);
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(0); // t0+5 still counts
    expect(store.check('k', 2, W, t0 + W + 1).allowed).toBe(false);
  });

  it('keys are independent of each other', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(store.check('a', 5, W, t0).allowed).toBe(true);
    expect(store.check('a', 5, W, t0).allowed).toBe(false);
    expect(store.check('b', 5, W, t0).allowed).toBe(true);
  });

  it('resetAtMs is now + window for allowed requests', () => {
    const t0 = 1_000_000;
    expect(store.check('k', 1, W, t0).resetAtMs).toBe(t0 + W);
  });

  it('rebuckets when the configured window changes for a key', () => {
    const t0 = 1_000_000;
    store.check('k', 1, 120_000, t0);
    // Same key under a much shorter window: the old hit must not linger and
    // keep blocking forever under the new (shorter) semantics.
    const later = store.check('k', 1, 10_000, t0 + 15_000);
    expect(later.allowed).toBe(true);
  });

  it('keeps one hit per call — blocked requests are not recorded', () => {
    const t0 = 1_000_000;
    store.check('k', 1, W, t0);
    // Blocked probes must NOT extend the window further.
    store.check('k', 1, W, t0 + 30_000);
    store.check('k', 1, W, t0 + 45_000);
    expect(store.check('k', 1, W, t0 + W).allowed).toBe(true);
  });

  it('sweeps fully-idle buckets so keys cannot accumulate', () => {
    const t0 = 1_000_000;
    store.check('idle-a', 5, 1_000, t0);
    store.check('idle-b', 5, 1_000, t0);
    expect(store.activeKeys().length).toBe(2);
    // A far-future check triggers the periodic sweep; both buckets expired.
    store.check('fresh', 5, 1_000, t0 + 10 * 60_000);
    expect(store.activeKeys()).toEqual(['fresh']);
  });

  it('uses the wall clock when nowMs is omitted', () => {
    const before = Date.now();
    const verdict = store.check('wall', 5, W);
    expect(verdict.allowed).toBe(true);
    expect(verdict.resetAtMs).toBeGreaterThanOrEqual(before + W);
  });

  it('reset() clears all state', () => {
    const t0 = 1_000_000;
    store.check('k', 1, W, t0);
    expect(store.check('k', 1, W, t0).allowed).toBe(false);
    store.reset();
    expect(store.activeKeys()).toEqual([]);
    expect(store.check('k', 1, W, t0).allowed).toBe(true);
  });
});
