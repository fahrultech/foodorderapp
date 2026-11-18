import {
  DEFAULT_HTTP_CACHE_TTL_SEC,
  HttpCacheStore,
  MAX_HTTP_CACHE_ENTRIES,
  cacheTargetOf,
  etagFor,
  etagMatches,
  parseIfNoneMatch,
  resolveTtlSec,
  type CacheEntry,
} from './http-cache';

/**
 * Unit contract for the public-read HTTP cache core (session 103).
 * The LIVE behaviour (304 without running the handler, metrics visibility)
 * is pinned by http-cache.integration.spec.ts over the real middleware
 * chain; this file pins the pure logic the middleware is built on.
 */

const RID = '2f4a5b6c-7d8e-4f90-8a1b-2c3d4e5f6071';

describe('resolveTtlSec — HTTP_CACHE_TTL_SEC doctrine', () => {
  it('unset/empty/garbage/negative fall back to the default; 0 means off', () => {
    expect(resolveTtlSec(undefined)).toBe(DEFAULT_HTTP_CACHE_TTL_SEC);
    expect(resolveTtlSec(null)).toBe(DEFAULT_HTTP_CACHE_TTL_SEC);
    expect(resolveTtlSec('')).toBe(DEFAULT_HTTP_CACHE_TTL_SEC);
    expect(resolveTtlSec('   ')).toBe(DEFAULT_HTTP_CACHE_TTL_SEC);
    expect(resolveTtlSec('abc')).toBe(DEFAULT_HTTP_CACHE_TTL_SEC);
    expect(resolveTtlSec('-5')).toBe(DEFAULT_HTTP_CACHE_TTL_SEC);
    expect(resolveTtlSec('Infinity')).toBe(DEFAULT_HTTP_CACHE_TTL_SEC);
    expect(resolveTtlSec('0')).toBe(0);
    expect(resolveTtlSec('30')).toBe(30);
    expect(resolveTtlSec('7.9')).toBe(7); // floor, never throw
  });
});

describe('cacheTargetOf — the EXPLICIT whitelist', () => {
  it('covers exactly the three public browse reads (plus optional trailing slash)', () => {
    expect(cacheTargetOf('/api/restaurants')).toEqual({ routePath: '/api/restaurants', restaurantId: null });
    expect(cacheTargetOf('/api/restaurants/')).toEqual({ routePath: '/api/restaurants', restaurantId: null });
    expect(cacheTargetOf('/api/search')).toEqual({ routePath: '/api/search', restaurantId: null });
    expect(cacheTargetOf(`/api/restaurants/${RID}`)).toEqual({
      routePath: '/api/restaurants/:id',
      restaurantId: RID,
    });
  });

  it('lowercases the uuid (bucket-key invariant, session 98)', () => {
    const upper = RID.toUpperCase();
    expect(cacheTargetOf(`/api/restaurants/${upper}`)?.restaurantId).toBe(RID);
  });

  it('rejects sub-paths, non-uuid segments, sibling routes and deeper shapes', () => {
    expect(cacheTargetOf(`/api/restaurants/${RID}/menu`)).toBeNull();
    expect(cacheTargetOf(`/api/restaurants/${RID}/reviews`)).toBeNull();
    expect(cacheTargetOf('/api/restaurants/meta/cuisines')).toBeNull();
    expect(cacheTargetOf('/api/restaurants/mine')).toBeNull();
    expect(cacheTargetOf('/api/restaurants/not-a-uuid')).toBeNull();
    expect(cacheTargetOf('/api/restaurants')).not.toBeNull();
    expect(cacheTargetOf('/api/search/extra')).toBeNull();
    expect(cacheTargetOf('/api/orders')).toBeNull();
    expect(cacheTargetOf('/api/health')).toBeNull();
    expect(cacheTargetOf('/api/docs-json')).toBeNull();
  });
});

describe('etagFor — strong hash over the exact bytes', () => {
  it('is deterministic, quoted, and body-sensitive', () => {
    const a = etagFor(Buffer.from('{"x":1}'));
    expect(a).toBe(etagFor(Buffer.from('{"x":1}')));
    expect(a).toMatch(/^"[0-9a-f]{32}"$/); // strong tag, never W/
    expect(a).not.toBe(etagFor(Buffer.from('{"x":2}')));
  });
});

describe('If-None-Match matching — RFC 9110 weak comparison', () => {
  const stored = etagFor(Buffer.from('body'));

  it('accepts the exact tag, a W/-prefixed tag and a comma list', () => {
    expect(etagMatches(stored, stored)).toBe(true);
    expect(etagMatches(`W/${stored}`, stored)).toBe(true);
    expect(etagMatches(`"other", ${stored}`, stored)).toBe(true);
    expect(etagMatches(` ${stored} , "x" `, stored)).toBe(true);
  });

  it('treats * as a wildcard match and rejects non-matches/absence', () => {
    expect(etagMatches('*', stored)).toBe(true);
    expect(etagMatches('"different"', stored)).toBe(false);
    expect(etagMatches(undefined, stored)).toBe(false);
    expect(etagMatches('', stored)).toBe(false);
    expect(parseIfNoneMatch(undefined)).toBeNull();
    expect(parseIfNoneMatch('*')).toEqual(['*']);
  });

  it('joins duplicate header lines (node hands arrays for repeated headers)', () => {
    expect(etagMatches(['"junk"', stored], stored)).toBe(true);
  });
});

describe('HttpCacheStore — bounded URL-keyed store', () => {
  const entry = (ms: number, body: string): CacheEntry => ({
    etag: `"e${ms}"`,
    body: Buffer.from(body),
    contentType: 'application/json; charset=utf-8',
    storedAtMs: ms,
  });

  it('get/set round-trip by exact URL key', () => {
    const store = new HttpCacheStore(10);
    store.set('/api/restaurants?limit=10', entry(1, 'a'));
    expect(store.get('/api/restaurants?limit=10')?.body.toString()).toBe('a');
    expect(store.get('/api/restaurants?limit=20')).toBeUndefined();
  });

  it('evicts the OLDEST-stored entry at the cap (re-set keeps its stamp)', () => {
    const store = new HttpCacheStore(2);
    store.set('u1', entry(100, 'a'));
    store.set('u2', entry(200, 'b'));
    store.set('u1', entry(150, 'a2')); // refresh VALUE only; storedAtMs 150 still newer than u2's 200? no: 150 < 200
    store.set('u3', entry(300, 'c')); // full -> evict oldest (u1 @150)
    expect(store.size).toBe(2);
    expect(store.get('u1')).toBeUndefined();
    expect(store.get('u2')?.body.toString()).toBe('b');
    expect(store.get('u3')?.body.toString()).toBe('c');
  });

  it('MAX_HTTP_CACHE_ENTRIES is the documented cap', () => {
    expect(MAX_HTTP_CACHE_ENTRIES).toBe(500);
  });
});
