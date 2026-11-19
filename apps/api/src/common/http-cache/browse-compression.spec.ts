import { gunzipSync, gzipSync } from 'node:zlib';
import {
  DEFAULT_COMPRESS_MIN_BYTES,
  MAX_COMPRESS_BUFFER_BYTES,
  clientAcceptsGzip,
  createBrowseCompressionMiddleware,
  resolveMinBytes,
  shouldCompressBrowse,
} from './browse-compression';
import { etagFor } from './http-cache';

/**
 * Unit contract for the session-108 gzip layer. The pure rule first:
 * the middleware itself runs over a real chain in
 * http-cache.integration.spec.ts (ordering with the cache is the part
 * unit mocks cannot prove).
 */

const OK = {
  path: '/api/restaurants',
  statusCode: 200,
  contentType: 'application/json; charset=utf-8',
  byteLength: 4096,
  minBytes: 1024,
  acceptsGzip: true,
};

describe('resolveMinBytes — HTTP_COMPRESS_MIN_BYTES doctrine', () => {
  it('unset/empty -> default; 0 -> off; negative/garbage -> default', () => {
    expect(resolveMinBytes(undefined)).toBe(DEFAULT_COMPRESS_MIN_BYTES);
    expect(resolveMinBytes(null)).toBe(DEFAULT_COMPRESS_MIN_BYTES);
    expect(resolveMinBytes('')).toBe(DEFAULT_COMPRESS_MIN_BYTES);
    expect(resolveMinBytes('   ')).toBe(DEFAULT_COMPRESS_MIN_BYTES);
    expect(resolveMinBytes('0')).toBe(0);
    expect(resolveMinBytes('512')).toBe(512);
    expect(resolveMinBytes('2048.9')).toBe(2048); // floored
    expect(resolveMinBytes('-1')).toBe(DEFAULT_COMPRESS_MIN_BYTES);
    expect(resolveMinBytes('abc')).toBe(DEFAULT_COMPRESS_MIN_BYTES);
    expect(resolveMinBytes('Infinity')).toBe(DEFAULT_COMPRESS_MIN_BYTES);
  });
});

describe('clientAcceptsGzip — negotiation', () => {
  it('absent or blank header means identity-only', () => {
    expect(clientAcceptsGzip(undefined)).toBe(false);
    expect(clientAcceptsGzip('')).toBe(false);
    expect(clientAcceptsGzip('  ')).toBe(false);
  });

  it('gzip / x-gzip / * accepted, case-insensitive, array folded', () => {
    expect(clientAcceptsGzip('gzip')).toBe(true);
    expect(clientAcceptsGzip('GZIP')).toBe(true);
    expect(clientAcceptsGzip('x-gzip')).toBe(true);
    expect(clientAcceptsGzip('*')).toBe(true);
    expect(clientAcceptsGzip('br, gzip')).toBe(true);
    expect(clientAcceptsGzip('identity;q=0, *;q=0.5')).toBe(true);
    expect(clientAcceptsGzip(['deflate', 'gzip'])).toBe(true);
  });

  it('only-non-gzip or q=0 rejections answer identity', () => {
    expect(clientAcceptsGzip('br')).toBe(false);
    expect(clientAcceptsGzip('identity')).toBe(false);
    expect(clientAcceptsGzip('gzip;q=0')).toBe(false);
    expect(clientAcceptsGzip('gzip;q=0.0')).toBe(false);
    expect(clientAcceptsGzip('*;q=0')).toBe(false);
    expect(clientAcceptsGzip('deflate, gzip;q=0')).toBe(false);
  });

  it('a live token after a dead one still wins (browser-ish header)', () => {
    expect(clientAcceptsGzip('gzip;q=0, br;q=1')).toBe(false); // br is not gzip
    expect(clientAcceptsGzip('br;q=0, gzip')).toBe(true);
  });
});

describe('shouldCompressBrowse — the whole rule, one table', () => {
  it('the canonical case compresses', () => {
    expect(shouldCompressBrowse(OK)).toBe(true);
  });

  it('every other dimension vetoes', () => {
    expect(shouldCompressBrowse({ ...OK, minBytes: 0 })).toBe(false); // feature off
    expect(shouldCompressBrowse({ ...OK, acceptsGzip: false })).toBe(false);
    expect(shouldCompressBrowse({ ...OK, statusCode: 304 })).toBe(false);
    expect(shouldCompressBrowse({ ...OK, statusCode: 400 })).toBe(false); // error body never encodes
    expect(shouldCompressBrowse({ ...OK, statusCode: 500 })).toBe(false);
    expect(shouldCompressBrowse({ ...OK, contentType: 'text/html' })).toBe(false);
    expect(shouldCompressBrowse({ ...OK, byteLength: 1023 })).toBe(false); // threshold is >=
    expect(shouldCompressBrowse({ ...OK, byteLength: 1024 })).toBe(true);
    expect(shouldCompressBrowse({ ...OK, byteLength: MAX_COMPRESS_BUFFER_BYTES })).toBe(true);
    expect(shouldCompressBrowse({ ...OK, byteLength: MAX_COMPRESS_BUFFER_BYTES + 1 })).toBe(false);
    expect(shouldCompressBrowse({ ...OK, path: '/api/restaurants/meta/cuisines' })).toBe(false);
    expect(shouldCompressBrowse({ ...OK, path: '/api/orders' })).toBe(false);
    expect(
      shouldCompressBrowse({ ...OK, path: '/api/restaurants/2f4a5b6c-7d8e-4f90-8a1b-2c3d4e5f6071' }),
    ).toBe(true); // the uuid detail read is whitelisted
    expect(
      shouldCompressBrowse({ ...OK, path: '/api/restaurants/not-a-uuid' }),
    ).toBe(false);
  });
});

describe('gzip round trip keeps the ETag contract meaningful', () => {
  it('decoding an encoded body reproduces the exact bytes the store hashed', () => {
    const body = Buffer.from(JSON.stringify({ items: Array.from({ length: 80 }, (_, i) => ({ name: `dish-${i}` })) }));
    const etag = etagFor(body); // what the cache stores as validator
    const encoded = gzipSync(body);
    expect(Buffer.compare(gunzipSync(encoded), body)).toBe(0);
    // the shared-strong-etag rule: the validator names the DECODED payload,
    // so etagFor(gunzip(encoded)) === etag — never weakened, never re-hashed.
    expect(etagFor(gunzipSync(encoded))).toBe(etag);
  });
});

describe('createBrowseCompressionMiddleware pre-flight short-circuits', () => {
  // Header rewriting itself is pinned over the real HTTP chain in
  // http-cache.integration.spec.ts; the unit half proves the patch is
  // NEVER INSTALLED outside the rule (byte-transparency for identity
  // clients is a property of the unpatched stack, not of a polite wrapper).

  function fakeReqRes(method: string, path: string, headers: Record<string, string> = {}) {
    const req = { method, path, url: path, headers } as never;
    const res = {
      patched: false,
      statusCode: 200,
      getHeader: () => undefined,
      setHeader: () => res,
      write: () => true,
      end: () => res,
    };
    return { req, res };
  }

  it('minBytes=0 -> pure next(), res untouched', () => {
    const mw = createBrowseCompressionMiddleware({ minBytes: 0 });
    const { req, res } = fakeReqRes('GET', '/api/restaurants', { 'accept-encoding': 'gzip' });
    const originalEnd = res.end;
    let nextCalled = 0;
    mw(req, res as never, () => (nextCalled += 1));
    expect(nextCalled).toBe(1);
    expect(res.end).toBe(originalEnd);
  });

  it('identity client, non-whitelisted path, POST and HEAD-style routes all skip patching', () => {
    const mw = createBrowseCompressionMiddleware({ minBytes: 1024 });
    for (const [method, path, headers] of [
      ['GET', '/api/restaurants', {}], // no Accept-Encoding
      ['GET', '/api/restaurants', { 'accept-encoding': 'br' }], // no gzip in it
      ['GET', '/api/orders', { 'accept-encoding': 'gzip' }], // not a browse path
      ['POST', '/api/restaurants', { 'accept-encoding': 'gzip' }], // not a GET
    ] as const) {
      const { req, res } = fakeReqRes(method, path, { ...headers });
      const originalEnd = res.end;
      mw(req, res as never, () => undefined);
      expect(res.end).toBe(originalEnd);
    }
  });

  it('the whitelisted gzip GET DOES patch res.write/res.end', () => {
    const mw = createBrowseCompressionMiddleware({ minBytes: 1024 });
    const { req, res } = fakeReqRes('GET', '/api/search', { 'accept-encoding': 'gzip' });
    const originalEnd = res.end;
    let nextCalled = 0;
    mw(req, res as never, () => (nextCalled += 1));
    expect(nextCalled).toBe(1);
    expect(res.end).not.toBe(originalEnd);
  });
});
