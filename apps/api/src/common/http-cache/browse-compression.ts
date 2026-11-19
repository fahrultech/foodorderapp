/**
 * Gzip layer for the public browse payloads (session 108, Phase 10
 * "response compression").
 *
 * Registered BEFORE the session-103 cache middleware (the order is the
 * contract, see main.ts): this wrapper installs itself on res.end first,
 * so EVERY 200 on a whitelisted path flows through it — the handler
 * response captured into the store AND the bytes later SERVED FROM THE
 * STORE. The cache keeps storing UNCOMPRESSED bodies and its strong
 * ETag stays the sha256 of those exact bytes, which yields the two
 * correctness rules this file exists to pin:
 *
 * - the ETag is IDENTICAL across the gzip and identity variants and is
 *   always the hash of the DECODED bytes — revalidation round-trips are
 *   encoding-blind (RFC 9110 semantics: a strong validator promises the
 *   same semantic payload; a lossless encoding preserves exactly that);
 * - `Accept-Encoding` is appended to `Vary` ONLY on responses this layer
 *   actually encoded. The cache's `Vary: Authorization` stays byte-pinned
 *   for identity clients, below-threshold bodies and non-200s.
 *
 * Scope is EXACTLY the three whitelisted reads (single source of truth:
 * `cacheTargetOf`) — GET only, application/json 2xx only, buffered body
 * >= minBytes only. Identity clients (no `Accept-Encoding: gzip` — e.g.
 * plain curl) and everything else never even get their res patched:
 * byte-transparent.
 *
 * Deliberately hand-rolled instead of the `compression` package: the
 * wrapper must interleave with the cache's own res.end patching, keep a
 * byte-exact Content-Length for the encoded body (the package streams
 * chunked instead), and hold to the explicit whitelist — the same
 * DI-free, unit-testable doctrine as every other layer in this folder.
 *
 * Knob: HTTP_COMPRESS_MIN_BYTES — unset/garbage -> default 1024, `0` ->
 * feature OFF. Same doctrine as resolveTtlSec: an ops typo must neither
 * crash boot nor silently disable a perf feature through a "0-ish" value.
 */
import { gzipSync } from 'node:zlib';
import type { NextFunction, Request, Response } from 'express';
import { cacheTargetOf } from './http-cache';

export const DEFAULT_COMPRESS_MIN_BYTES = 1024;

/**
 * Safety valve: a whitelisted response larger than this is flushed
 * UNCOMPRESSED (buffering a pathological body to gzip it is worse than
 * not gzipping it). The three browse payloads are single res.json calls
 * in the tens of kilobytes; this only bounds the worst case.
 */
export const MAX_COMPRESS_BUFFER_BYTES = 2 * 1024 * 1024;

/** resolveTtlSec doctrine — see the header comment. */
export function resolveMinBytes(raw: string | number | undefined | null): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_COMPRESS_MIN_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_COMPRESS_MIN_BYTES;
  return Math.floor(n);
}

/**
 * Does this request accept gzip? Absent header means identity-only
 * (RFC: no `Accept-Encoding` = only `identity` is acceptable) — which is
 * exactly what keeps curl-without---compressed byte-transparent. Token
 * matching is case-insensitive; `q=0` rejects a token; `*` accepts.
 */
export function clientAcceptsGzip(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value || value.trim() === '') return false;
  for (const part of value.split(',')) {
    const [tokenRaw, ...params] = part.trim().split(';');
    const token = tokenRaw.trim().toLowerCase();
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*(\d*\.?\d+)\s*$/.exec(p);
      if (m) q = Number(m[1]);
    }
    if (q <= 0) continue;
    if (token === 'gzip' || token === 'x-gzip' || token === '*') return true;
  }
  return false;
}

export interface CompressDecisionInput {
  path: string;
  statusCode: number;
  contentType: string;
  byteLength: number;
  minBytes: number;
  acceptsGzip: boolean;
}

/** The full rule in one pure function — everything the middleware does
 *  beyond moving bytes hinges on this answer. 4xx/5xx never encode (an
 *  error body is not a browse payload); HEAD naturally lands below the
 *  threshold because Express suppresses its body. */
export function shouldCompressBrowse(input: CompressDecisionInput): boolean {
  if (input.minBytes <= 0) return false;
  if (!input.acceptsGzip) return false;
  if (input.statusCode !== 200) return false;
  if (cacheTargetOf(input.path) === null) return false;
  if (!input.contentType.includes('application/json')) return false;
  return input.byteLength >= input.minBytes && input.byteLength <= MAX_COMPRESS_BUFFER_BYTES;
}

/** Append `Accept-Encoding` to an existing Vary without duplicating it. */
function varyWithAcceptEncoding(existing: unknown): string {
  const raw = Array.isArray(existing) ? existing.join(', ') : existing === undefined ? '' : String(existing);
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === 'accept-encoding')) {
    return parts.join(', ');
  }
  parts.push('Accept-Encoding');
  return parts.join(', ');
}

export interface BrowseCompressionOptions {
  minBytes: number;
}

export function createBrowseCompressionMiddleware(options: BrowseCompressionOptions) {
  const { minBytes } = options;

  return function browseCompression(req: Request, res: Response, next: NextFunction): void {
    // Pre-flight short-circuits keep every non-gzip client and every
    // non-whitelisted route on the UNPATCHED stack (byte-transparent).
    if (minBytes <= 0 || req.method !== 'GET') {
      next();
      return;
    }
    const path = req.path ?? (req.url ?? '/').split('?')[0];
    if (cacheTargetOf(path) === null || !clientAcceptsGzip(req.headers['accept-encoding'])) {
      next();
      return;
    }

    const chunks: Buffer[] = [];
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    // Single-response buffering by contract: these three routes answer
    // with exactly one res.json. The cache middleware (registered after
    // us, hence INSIDE this wrapper) forwards the SAME final body via
    // originalEnd, so the two wrappers never double-count bytes.
    res.write = function (chunk?: unknown, encodingOrCb?: unknown, cb?: unknown): boolean {
      let encoding: unknown;
      let callback: unknown = cb;
      if (typeof encodingOrCb === 'function') {
        callback = encodingOrCb;
      } else {
        encoding = encodingOrCb;
      }
      if (chunk !== undefined && chunk !== null && chunk !== '') {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
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
        chunks.push(
          Buffer.isBuffer(chunk)
            ? chunk
            : typeof chunk === 'string'
              ? Buffer.from(chunk, (typeof encoding === 'string' ? encoding : 'utf8') as BufferEncoding)
              : Buffer.from(String(chunk)),
        );
      }
      const body = Buffer.concat(chunks);
      const contentType = String(res.getHeader('content-type') ?? '');
      const decision = shouldCompressBrowse({
        path,
        statusCode: res.statusCode,
        contentType,
        byteLength: body.length,
        minBytes,
        acceptsGzip: true,
      });

      if (decision) {
        const encoded = gzipSync(body);
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', encoded.length);
        res.setHeader('Vary', varyWithAcceptEncoding(res.getHeader('vary')));
        if (typeof callback === 'function') (callback as () => void)();
        return originalEnd(encoded);
      }

      if (typeof callback === 'function') (callback as () => void)();
      return body.length > 0 ? originalEnd(body) : originalEnd();
    } as typeof res.end;

    next();
  };
}
