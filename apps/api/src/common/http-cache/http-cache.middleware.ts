import type { NextFunction, Request, Response } from 'express';
import {
  type CacheTarget,
  HttpCacheStore,
  cacheTargetOf,
  etagFor,
  etagMatches,
} from './http-cache';

/**
 * Public-read HTTP cache middleware (session 103).
 *
 * Handles GET /api/restaurants, GET /api/restaurants/:id (uuid) and
 * GET /api/search for ANONYMOUS requests:
 *
 * - Fresh entry (within TTL) + matching If-None-Match  -> 304, the handler
 *   NEVER runs (zero SQL — proven live via the query logger).
 * - Fresh entry, no (or non-matching) If-None-Match    -> 200 served
 *   straight from the store, again zero SQL.
 * - Miss / stale entry -> handler runs, the JSON 200 body is captured,
 *   hashed and stored; a stale revalidation whose recomputed ETag still
 *   matches If-None-Match answers 304 without sending the bytes (the DB
 *   read already happened — honest, that is what TTL expiry means).
 * - Anything else (POST, bearer'd request, sub-path, 4xx/5xx) is fully
 *   transparent: no headers are touched except Express's own defaults.
 *
 * ORDER-SENSITIVE: register LAST, after the metrics AND the pino-http
 * middlewares. Both hook `res.on('finish')` when THEY run for a request;
 * when this middleware short-circuits before routing, only requests that
 * passed through both are logged/counted — which is exactly the placement
 * that keeps served 304s visible in the metrics and the access log.
 *
 * Attribution on the short-circuit path: Express never routed the request,
 * so `req.route` would be absent and the finish-time template resolution
 * (session 98 contract) would degrade the sample to a normalized url and
 * drop restaurant attribution. This middleware therefore stamps
 * `req.route.path` with the EXACT controller template it whitelisted —
 * explicit attribution from a whitelist, never a url-shape heuristic.
 */
export interface HttpCacheMiddlewareOptions {
  ttlSec: number;
  store: HttpCacheStore;
}

const CACHE_CONTROL_NO_VARIANT = new Set(['content-length', 'content-type', 'transfer-encoding']);

function toBuffer(chunk: unknown, encoding?: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, (typeof encoding === 'string' ? encoding : 'utf8') as BufferEncoding);
  }
  return Buffer.from(String(chunk));
}

function setCacheHeaders(res: Response, etag: string, ttlSec: number): void {
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', `public, max-age=${ttlSec}`);
  // The anonymous response is what this store caches; declaring the
  // dimension keeps any downstream cache honest if the route ever grows
  // a bearer-derived field (the middleware itself already opts out then).
  res.setHeader('Vary', 'Authorization');
}

function markTemplate(req: Request, target: CacheTarget): void {
  // Only when routing did NOT happen; a captured response keeps the REAL
  // req.route the Express router set. The value is the route PATH template
  // — routeKeyOf adds the METHOD itself at finish time (session 98
  // composition), exactly like a matched request would.
  if (!(req as { route?: unknown }).route) {
    (req as { route?: { path: string } }).route = { path: target.routePath };
  }
}

export function createHttpCacheMiddleware(options: HttpCacheMiddlewareOptions) {
  const { ttlSec, store } = options;
  const ttlMs = ttlSec * 1000;

  return function httpCacheMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (ttlSec <= 0 || req.method !== 'GET' || req.headers.authorization !== undefined) {
      next();
      return;
    }
    const target = cacheTargetOfRequest(req);
    if (!target) {
      next();
      return;
    }

    const urlKey = req.url; // path + query — different filters, different entries
    const entry = store.get(urlKey);
    const fresh = entry !== undefined && Date.now() - entry.storedAtMs < ttlMs;

    if (fresh && entry) {
      markTemplate(req, target);
      if (etagMatches(req.headers['if-none-match'], entry.etag)) {
        res.statusCode = 304;
        setCacheHeaders(res, entry.etag, ttlSec);
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', entry.contentType);
      res.setHeader('Content-Length', entry.body.length);
      setCacheHeaders(res, entry.etag, ttlSec);
      res.end(entry.body);
      return;
    }

    // Miss or stale: run the handler, capture the bytes, store + validate.
    const chunks: Buffer[] = [];
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    res.write = function (chunk?: unknown, encodingOrCb?: unknown, cb?: unknown): boolean {
      let encoding: unknown;
      let callback: unknown = cb;
      if (typeof encodingOrCb === 'function') {
        callback = encodingOrCb;
      } else {
        encoding = encodingOrCb;
      }
      if (chunk !== undefined && chunk !== null && chunk !== '') {
        chunks.push(toBuffer(chunk, encoding));
      }
      if (typeof callback === 'function') (callback as () => void)();
      return true;
    } as typeof res.write;

    res.end = function (chunk?: unknown, encodingOrCb?: unknown, cb?: unknown): Response {
      let encoding: unknown;
      let callback: unknown = cb;
      if (typeof chunk === 'function') {
        callback = chunk;
        chunk = undefined;
      } else if (typeof encodingOrCb === 'function') {
        callback = encodingOrCb;
      } else {
        encoding = encodingOrCb;
      }
      if (chunk !== undefined && chunk !== null && chunk !== '') {
        chunks.push(toBuffer(chunk, encoding));
      }
      const body = Buffer.concat(chunks);
      const contentType = String(res.getHeader('content-type') ?? '');

      if (res.statusCode === 200 && contentType.includes('application/json')) {
        const etag = etagFor(body);
        store.set(urlKey, { etag, body, contentType, storedAtMs: Date.now() });
        setCacheHeaders(res, etag, ttlSec);
        if (etagMatches(req.headers['if-none-match'], etag)) {
          // Stale revalidation with an unchanged body: handler DID read
          // (unavoidable without cheap server-side versioning), the
          // response only skips the bytes.
          res.statusCode = 304;
          for (const header of CACHE_CONTROL_NO_VARIANT) res.removeHeader(header);
          if (typeof callback === 'function') (callback as () => void)();
          return originalEnd();
        }
        if (typeof callback === 'function') (callback as () => void)();
        return originalEnd(body);
      }

      if (typeof callback === 'function') (callback as () => void)();
      return body.length > 0 ? originalEnd(body) : originalEnd();
    } as typeof res.end;

    next();
  };
}

function cacheTargetOfRequest(req: Request): CacheTarget | null {
  const path = req.path ?? (req.url ?? '/').split('?')[0];
  return cacheTargetOf(path);
}
