/**
 * Public-read HTTP cache core (session 103, Phase 9 "Perf: HTTP caching").
 *
 * DI-free and dependency-light (like the metrics registry) so it is
 * trivially unit-testable and shareable between the middleware and specs:
 *
 * - ONLY the three public browse reads are eligible (`cacheTargetOf`):
 *   the restaurant list, the restaurant detail (uuid-gated) and the
 *   cross-restaurant search. Everything else — owner/ADMIN routes, the
 *   ':id/menu' and ':id/reviews' sub-resources, health — passes through
 *   with zero headers touched. The pattern list is EXPLICIT, never a
 *   url heuristic: matching here doubles as the attribution contract
 *   (the middleware stamps the matched TEMPLATE onto the request for
 *   the finish-time metrics resolution — the session-98 rule that
 *   attribution is template-driven survives because these ARE the
 *   controller templates of the three whitelisted routes).
 * - Anonymous requests only. None of the three responses carries any
 *   bearer-derived field TODAY (they have no guards at all), but caching
 *   per-URL under a bearer would silently break the day someone adds one
 *   — an `authorization` header simply opts out of the whole feature.
 * - Responses are byte-identical JSON for a URL within the TTL, so the
 *   strong ETag is sha256 over the exact bytes; If-None-Match revalidation
 *   inside the TTL answers 304 WITHOUT running the handler — zero SQL,
 *   which the live smoke proves through the query logger.
 * - The store is bounded (evict-oldest) — hostile URL floods cannot grow
 *   it unboundedly; eviction only costs a re-read, never correctness.
 */
import { createHash } from 'node:crypto';

export const DEFAULT_HTTP_CACHE_TTL_SEC = 15;

/** Hard cap on distinct cached URLs; oldest entry is evicted on overflow. */
export const MAX_HTTP_CACHE_ENTRIES = 500;

/**
 * Env parsing for HTTP_CACHE_TTL_SEC — same doctrine as the metrics knobs:
 * - unset / empty → default 15 s
 * - `0` → feature DISABLED (every request passes through untouched)
 * - negative / garbage → default (an ops typo must never crash boot, and
 *   must never silently make a "0-ish" value disable a perf feature)
 */
export function resolveTtlSec(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_HTTP_CACHE_TTL_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_HTTP_CACHE_TTL_SEC;
  return Math.floor(n);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CacheTarget {
  /**
   * The Express route PATH template this URL maps to — EXACTLY one of the
   * three. Stored WITHOUT the method prefix because the finish-time
   * `routeKeyOf` composes `METHOD + baseUrl + route.path` itself (the same
   * composition session 98 pinned for matched routes).
   */
  routePath: '/api/restaurants' | '/api/restaurants/:id' | '/api/search';
  /** Lowercased uuid for the detail route, null for the two collection reads. */
  restaurantId: string | null;
}

/**
 * Strict path matcher (query string already stripped by Express `req.path`).
 * Mirrors Express non-strict routing: the route itself, or it plus ONE
 * trailing slash. Anything deeper (`/api/restaurants/<uuid>/menu`) or any
 * non-uuid segment (`/api/restaurants/meta/cuisines` — its own route) is
 * deliberately NOT a cache target.
 */
export function cacheTargetOf(path: string): CacheTarget | null {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (trimmed === '/api/restaurants') {
    return { routePath: '/api/restaurants', restaurantId: null };
  }
  if (trimmed === '/api/search') {
    return { routePath: '/api/search', restaurantId: null };
  }
  if (trimmed.startsWith('/api/restaurants/')) {
    const seg = trimmed.slice('/api/restaurants/'.length);
    if (seg.includes('/')) return null;
    if (!UUID_RE.test(seg)) return null;
    return { routePath: '/api/restaurants/:id', restaurantId: seg.toLowerCase() };
  }
  return null;
}

/** Strong, quoted ETag over the exact response bytes. */
export function etagFor(body: Buffer): string {
  return `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
}

/**
 * Parse an If-None-Match header into comparable tags: weak `W/` prefixes
 * are stripped (RFC 9110 weak comparison), `*` is kept as-is. Returns null
 * when the header is absent/blank (a plain GET, not a revalidation).
 */
export function parseIfNoneMatch(raw: string | string[] | undefined): string[] | null {
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (!value || value.trim() === '') return null;
  if (value.trim() === '*') return ['*'];
  const tags = value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith('W/') ? t.slice(2).trim() : t));
  return tags.length > 0 ? tags : null;
}

export function etagMatches(raw: string | string[] | undefined, storedEtag: string): boolean {
  const tags = parseIfNoneMatch(raw);
  if (!tags) return false;
  return tags.includes('*') || tags.includes(storedEtag);
}

export interface CacheEntry {
  etag: string;
  body: Buffer;
  contentType: string;
  storedAtMs: number;
}

/**
 * URL-keyed entry store with a hard cap. The key is the FULL request url
 * (path + query): different filters are different representations, and a
 * benign case like `?limit=10` vs `?limit=010` merely costs one extra
 * entry — never a wrong body, because every entry was captured from the
 * handler itself.
 */
export class HttpCacheStore {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly maxEntries: number = MAX_HTTP_CACHE_ENTRIES) {}

  get(urlKey: string): CacheEntry | undefined {
    return this.entries.get(urlKey);
  }

  set(urlKey: string, entry: CacheEntry): void {
    if (!this.entries.has(urlKey) && this.entries.size >= this.maxEntries) {
      // Evict the oldest-stored entry (Map iteration is insertion-ordered,
      // but re-sets refresh the value WITHOUT re-ordering — so scan for
      // the true oldest instead of trusting position).
      let oldestKey: string | null = null;
      let oldestMs = Infinity;
      for (const [key, existing] of this.entries) {
        if (existing.storedAtMs < oldestMs) {
          oldestMs = existing.storedAtMs;
          oldestKey = key;
        }
      }
      if (oldestKey !== null) this.entries.delete(oldestKey);
    }
    this.entries.set(urlKey, entry);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
