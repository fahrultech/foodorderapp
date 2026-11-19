import * as http from 'http';
import { Writable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { Controller, Get, INestApplication, Module, Param, Post, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Logger as PinoInstance } from 'pino';
import { createHttpLoggingMiddleware } from '../logging/http-logging';
import { createRootLogger, PinoLoggerService } from '../logging/pino-logger';
import { requestIdMiddleware } from '../logging/request-id.middleware';
import { RequestMetricsRegistry } from '../metrics/request-metrics';
import { createRequestMetricsMiddleware } from '../metrics/request-metrics.middleware';
import { createBrowseCompressionMiddleware } from './browse-compression';
import { etagFor, HttpCacheStore } from './http-cache';
import { createHttpCacheMiddleware } from './http-cache.middleware';

/**
 * Production middleware chain over a real HTTP server (sessions 103/108):
 *   requestId -> metrics -> pino-http access logging -> browse gzip -> public-read cache
 * Pins the four contracts unit tests CANNOT prove:
 *  1. a revalidated fresh hit answers 304 WITHOUT the handler ever running
 *     (the live zero-SQL claim, mirrored here with handler call counters);
 *  2. served 304s are still VISIBLE to the metrics registry and the access
 *     log — the cache middleware must be registered AFTER both hook their
 *     'finish' listeners (chain placement = main.ts ordering comment);
 *  3. restaurant attribution survives the routing skip: the fabricated
 *     whitelist template keeps the sample on `GET /api/restaurants/:id`
 *     and TOPS UP the bucket WITHOUT minting one for a cold id;
 *  4. everything else (sub-paths, bearer requests, POST, HEAD, non-uuid
 *     segments) is byte-transparent — no Cache-Control ever appears.
 */

const RID = '2f4a5b6c-7d8e-4f90-8a1b-2c3d4e5f6071';
const OTHER_RID = '3a5b6c7d-8e9f-4a01-9b2c-3d4e5f607182';

const calls = { list: 0, detail: 0, menu: 0, search: 0, cuisines: 0 };
let version = 1; // flip to change every body WITHOUT re-booting

@Controller('restaurants')
class RestaurantsProbeController {
  @Get()
  list(): Record<string, unknown> {
    calls.list += 1;
    return { items: [{ id: RID, name: 'Probe Warung' }], total: 1, v: version };
  }

  @Get('meta/cuisines')
  cuisines(): Record<string, unknown> {
    calls.cuisines += 1;
    return { cuisines: ['probe'] };
  }

  @Get(':id')
  one(@Param('id') id: string): Record<string, unknown> {
    calls.detail += 1;
    return { id, v: version };
  }

  @Get(':id/menu')
  menu(@Param('id') id: string): Record<string, unknown> {
    calls.menu += 1;
    return { id, menu: [] };
  }

  @Post()
  create(): Record<string, unknown> {
    return { created: true };
  }
}

@Controller('search')
class SearchProbeController {
  @Get()
  search(@Query('q') q?: string): Record<string, unknown> {
    calls.search += 1;
    return { q: q ?? null, hits: [], v: version };
  }
}

@Module({ controllers: [RestaurantsProbeController, SearchProbeController] })
class ProbeModule {}

interface FullResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  bytes: Buffer;
}

function request(app: INestApplication, method: string, path: string, headers?: Record<string, string>): Promise<FullResponse> {
  return new Promise((resolve, reject) => {
    const server = app.getHttpServer() as http.Server;
    const port = (server.address() as { port: number }).port;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode!, headers: res.headers, bytes, body: bytes.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function bootChain(ttlSec: number, minBytes = 0): Promise<{
  app: INestApplication;
  registry: RequestMetricsRegistry;
  store: HttpCacheStore;
  lines: Record<string, unknown>[];
  root: PinoInstance;
}> {
  const registry = new RequestMetricsRegistry();
  const store = new HttpCacheStore(50);
  const lines: Record<string, unknown>[] = [];
  let buf = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.length > 0) lines.push(JSON.parse(line));
      }
      cb();
    },
  });
  const root = createRootLogger({ level: 'debug', stream });
  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  const app = moduleRef.createNestApplication();
  // EXACT production order (main.ts, sessions 103 + 108): gzip BEFORE the
  // cache (its res.end wrapper must be installed while the cache serves
  // from the store), cache LAST of the four. minBytes=0 keeps the gzip
  // layer inert so the cache-era assertions stay byte-for-byte.
  app.setGlobalPrefix('api');
  app.use(requestIdMiddleware);
  app.use(createRequestMetricsMiddleware(registry));
  app.use(createHttpLoggingMiddleware(root));
  app.use(createBrowseCompressionMiddleware({ minBytes }));
  app.use(createHttpCacheMiddleware({ ttlSec, store }));
  app.useLogger(new PinoLoggerService(root));
  await app.listen(0);
  return { app, registry, store, lines, root };
}

async function drain(root: PinoInstance): Promise<void> {
  await new Promise<void>((resolve) => root.flush(() => resolve()));
  await new Promise((resolve) => setImmediate(resolve));
}

const STRONG_ETAG_RE = /^"[0-9a-f]{32}"$/;

describe('public-read http cache — live middleware chain', () => {
  let app: INestApplication;
  let registry: RequestMetricsRegistry;
  let store: HttpCacheStore;
  let lines: Record<string, unknown>[];
  let root: PinoInstance;

  beforeAll(async () => {
    ({ app, registry, store, lines, root } = await bootChain(60));
    for (const k of Object.keys(calls)) calls[k as keyof typeof calls] = 0;
    version = 1;
  });

  afterAll(async () => {
    await app.close();
  });

  it('miss -> 200 with strong ETag + public max-age; hit within TTL -> served WITHOUT the handler', async () => {
    const first = await request(app, 'GET', '/api/restaurants');
    expect(first.status).toBe(200);
    expect(first.headers.etag).toMatch(STRONG_ETAG_RE);
    expect(first.headers['cache-control']).toBe('public, max-age=60');
    expect(first.headers.vary).toBe('Authorization');
    expect(calls.list).toBe(1);

    const again = await request(app, 'GET', '/api/restaurants');
    expect(again.status).toBe(200);
    expect(again.body).toBe(first.body); // byte-identical from the store
    expect(calls.list).toBe(1); // handler NEVER re-ran within the TTL

    const revalidated = await request(app, 'GET', '/api/restaurants', { 'if-none-match': first.headers.etag! });
    expect(revalidated.status).toBe(304);
    expect(revalidated.body).toBe('');
    expect(revalidated.headers.etag).toBe(first.headers.etag);
    expect(revalidated.headers['cache-control']).toBe('public, max-age=60');
    expect(calls.list).toBe(1); // the live zero-SQL claim, mirrored

    // weak tag from a spec-compliant intermediary must also match
    const weak = await request(app, 'GET', '/api/restaurants', { 'if-none-match': `W/${first.headers.etag}` });
    expect(weak.status).toBe(304);
    expect(calls.list).toBe(1);
  });

  it('served 304s stay visible: metrics samples + access lines incl. the 3xx class', async () => {
    const row = registry.snapshot().routes.find((r) => r.route === 'GET /api/restaurants');
    expect(row).toBeDefined(); // fabricated template, NOT a normalized-url ghost
    expect(row!.requests).toBe(4); // 200 miss + 200 stored + 304 + 304 weak
    expect(row!.byStatus['3xx']).toBe(2);
    expect(row!.byStatus['2xx']).toBe(2);
    await drain(root);
    const access304 = lines.filter(
      (l) => (l.res as { statusCode?: number } | undefined)?.statusCode === 304,
    );
    expect(access304.length).toBe(2);
    for (const l of access304) {
      expect((l.metrics as { status_class?: string }).status_class).toBe('3xx');
    }
  });

  it('restaurant detail: 2xx mints the bucket, a served 304 tops it up, keys never change', async () => {
    const before = registry.snapshot().totals.restaurantKeys;
    const detail = await request(app, 'GET', `/api/restaurants/${RID}`);
    expect(detail.status).toBe(200);
    expect(calls.detail).toBe(1);
    expect(detail.headers.etag).toMatch(STRONG_ETAG_RE);
    expect(registry.snapshot().totals.restaurantKeys).toBe(before + 1);
    expect(registry.restaurantSnapshot(RID).totals.byStatus).toEqual({ '2xx': 1, '3xx': 0, '4xx': 0, '5xx': 0 });

    const reval = await request(app, 'GET', `/api/restaurants/${RID}`, { 'if-none-match': detail.headers.etag! });
    expect(reval.status).toBe(304);
    expect(calls.detail).toBe(1);
    expect(registry.snapshot().totals.restaurantKeys).toBe(before + 1); // top-up, no new key
    const snap = registry.restaurantSnapshot(RID);
    expect(snap.totals.byStatus).toEqual({ '2xx': 1, '3xx': 1, '4xx': 0, '5xx': 0 });
    expect(snap.routes.map((r) => r.route)).toEqual(['GET /api/restaurants/:id']);
  });

  it('sub-paths, sibling routes, bearer requests, POST and HEAD are byte-transparent', async () => {
    const menu = await request(app, 'GET', `/api/restaurants/${RID}/menu`);
    expect(menu.headers['cache-control']).toBeUndefined();

    const cuisines = await request(app, 'GET', '/api/restaurants/meta/cuisines');
    expect(cuisines.headers['cache-control']).toBeUndefined();

    const bad = await request(app, 'GET', '/api/restaurants/not-a-uuid');
    expect(bad.headers['cache-control']).toBeUndefined(); // non-uuid -> the :id handler ran, never cached

    const authed = await request(app, 'GET', '/api/restaurants', { authorization: 'Bearer unit-*-jwt' });
    expect(authed.headers['cache-control']).toBeUndefined();
    expect(calls.list).toBe(2); // bearer request went to the handler

    const post = await request(app, 'POST', '/api/restaurants');
    expect(post.status).toBe(201);
    expect(post.headers['cache-control']).toBeUndefined();

    const head = await request(app, 'HEAD', '/api/restaurants');
    expect(head.headers['cache-control']).toBeUndefined();
  });

  it('search is keyed per URL: different q values are separate entries', async () => {
    const a = await request(app, 'GET', '/api/search?q=bakso');
    const b = await request(app, 'GET', '/api/search?q=pecel');
    expect(a.headers.etag).not.toBe(b.headers.etag);
    expect(calls.search).toBe(2);
    const revalA = await request(app, 'GET', '/api/search?q=bakso', { 'if-none-match': a.headers.etag! });
    expect(revalA.status).toBe(304);
    expect(calls.search).toBe(2);
    expect(store.size).toBeGreaterThanOrEqual(4);
  });

  it('cold-id wildcard revalidation cannot mint: Express-native 304, nothing stored, bucket stays zero', async () => {
    const cold = await request(app, 'GET', `/api/restaurants/${OTHER_RID}`, { 'if-none-match': '*' });
    // RFC 9110: `*` is a conditional success whenever a representation
    // exists — here Express's OWN res.send freshness logic answers 304
    // (weak auto-etag) BEFORE our capture layer ever sees a 200, so the
    // handler read happens but NOTHING is stored and — the session-103
    // mint rule, live — a 3xx cannot create a bucket.
    expect(cold.status).toBe(304);
    expect(cold.headers.etag).toMatch(/^W\/".*"$/);
    expect(registry.restaurantSnapshot(OTHER_RID).totals.requests).toBe(0);

    // The FIRST UNCONDITIONAL 200 goes through our capture: handler runs,
    // the strong tag is minted and the entry is stored — the honest order.
    const warm = await request(app, 'GET', `/api/restaurants/${OTHER_RID}`);
    expect(warm.status).toBe(200);
    expect(warm.headers.etag).toMatch(STRONG_ETAG_RE);
    expect(registry.restaurantSnapshot(OTHER_RID).totals.byStatus['2xx']).toBe(1);
    expect(registry.restaurantSnapshot(OTHER_RID).totals.byStatus['3xx']).toBe(0);
    const before = calls.detail;

    // NOW the fresh revalidation is ours: 304 with the STRONG tag and
    // zero handler work — the bucket only tops up.
    const reval = await request(app, 'GET', `/api/restaurants/${OTHER_RID}`, {
      'if-none-match': warm.headers.etag!,
    });
    expect(reval.status).toBe(304);
    expect(reval.headers.etag).toBe(warm.headers.etag);
    expect(calls.detail).toBe(before);
    expect(registry.restaurantSnapshot(OTHER_RID).totals.byStatus['3xx']).toBe(1);
  });
});

describe('public-read http cache — HTTP_CACHE_TTL_SEC=0 disables the feature (e2e boot path)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await bootChain(0));
    for (const k of Object.keys(calls)) calls[k as keyof typeof calls] = 0;
    version = 1;
  });

  afterAll(async () => {
    await app.close();
  });

  it('every whitelisted read passes fully transparent — no cache headers, handler every time', async () => {
    const a = await request(app, 'GET', '/api/restaurants');
    expect(a.status).toBe(200);
    expect(a.headers['cache-control']).toBeUndefined();
    const b = await request(app, 'GET', '/api/restaurants', { 'if-none-match': a.headers.etag ?? '' });
    expect(b.headers['cache-control']).toBeUndefined();
    expect(calls.list).toBe(2); // both requests hit the handler
  });
});

describe('public-read http cache — TTL expiry + stale revalidation (ttl=1s)', () => {
  let app: INestApplication;
  let registry: RequestMetricsRegistry;
  let root: PinoInstance;

  beforeAll(async () => {
    ({ app, registry, root } = await bootChain(1));
    for (const k of Object.keys(calls)) calls[k as keyof typeof calls] = 0;
    version = 1;
  });

  afterAll(async () => {
    await app.close();
  });

  it('after expiry the handler re-runs; unchanged bytes still answer 304, changed bytes 200 with a NEW etag', async () => {
    const first = await request(app, 'GET', `/api/restaurants/${RID}`);
    expect(first.status).toBe(200);
    const etag1 = first.headers.etag!;
    expect(calls.detail).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Stale revalidation: the DB read HAPPENS (no cheap server-side
    // versioning exists) but identical bytes still skip the transfer.
    // NOTE: every capture RE-STAMPS the entry, so each stale phase below
    // needs its own sleep.
    const staleReval = await request(app, 'GET', `/api/restaurants/${RID}`, { 'if-none-match': etag1 });
    expect(staleReval.status).toBe(304);
    expect(calls.detail).toBe(2);
    expect(staleReval.headers.etag).toBe(etag1);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Same stale rule, unchanged body, NO revalidation -> handler re-runs
    // and the full 200 goes out again.
    const stalePlain = await request(app, 'GET', `/api/restaurants/${RID}`);
    expect(stalePlain.status).toBe(200);
    expect(calls.detail).toBe(3);

    version = 2;
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const changed = await request(app, 'GET', `/api/restaurants/${RID}`, { 'if-none-match': etag1 });
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).toMatch(STRONG_ETAG_RE);
    expect(changed.headers.etag).not.toBe(etag1);
    expect(JSON.parse(changed.body).v).toBe(2);

    // bucket tally across the whole TTL episode: 3 fresh-ish 200s + 1 304,
    // all one minted key
    const snap = registry.restaurantSnapshot(RID);
    expect(snap.totals.byStatus['2xx']).toBe(3);
    expect(snap.totals.byStatus['3xx']).toBe(1);
    expect(snap.routes.find((r) => r.route === 'GET /api/restaurants/:id')!.requests).toBe(4);
  });
});

describe('browse gzip layer over the same chain (session 108 — order IS the contract)', () => {
  let app: INestApplication;
  let registry: RequestMetricsRegistry;
  let root: PinoInstance;
  let lines: Record<string, unknown>[];
  let gzipEtag = '';
  let decodedCapture = '';

  // minBytes=64: the list probe body (~95 B) clears it, the detail probe
  // (~51 B) deliberately does not — one real boot exercises BOTH arms.
  beforeAll(async () => {
    ({ app, registry, root, lines } = await bootChain(60, 64));
    for (const k of Object.keys(calls)) calls[k as keyof typeof calls] = 0;
    version = 1;
  });

  afterAll(async () => {
    await app.close();
  });

  it('gzip capture: encoded 200 whose ETag is the hash of the DECODED bytes', async () => {
    const gz = await request(app, 'GET', '/api/restaurants', { 'accept-encoding': 'gzip' });
    expect(gz.status).toBe(200);
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.headers.etag).toMatch(STRONG_ETAG_RE);
    expect(gz.headers['cache-control']).toBe('public, max-age=60');
    const decoded = gunzipSync(gz.bytes);
    decodedCapture = decoded.toString('utf8');
    gzipEtag = gz.headers.etag!;
    // THE rule of this layer: the validator names the uncompressed payload
    // — what the store hashed and what any encoding round-trips to.
    expect(etagFor(decoded)).toBe(gzipEtag);
    // the encoded length is sent byte-exact (no chunked fallback)
    expect(gz.headers['content-length']).toBe(String(gz.bytes.length));
    const vary = new Set(
      String(gz.headers.vary)
        .split(',')
        .map((p) => p.trim().toLowerCase()),
    );
    expect([...vary].sort()).toEqual(['accept-encoding', 'authorization']);
    expect(calls.list).toBe(1);
  });

  it('identity variant of the SAME stored entry: byte-transparent, SAME ETag, cache Vary stays pinned', async () => {
    const id = await request(app, 'GET', '/api/restaurants');
    expect(id.status).toBe(200);
    expect(id.headers['content-encoding']).toBeUndefined();
    expect(id.headers.etag).toBe(gzipEtag);
    expect(id.headers.vary).toBe('Authorization'); // never extended for an identity response
    expect(Buffer.compare(Buffer.from(id.body, 'utf8'), Buffer.from(decodedCapture, 'utf8'))).toBe(0);
    expect(calls.list).toBe(1); // served from the store — the no-AE preflight left the cache fully in charge
  });

  it('store-served gzip hit re-encodes WITHOUT the handler and decodes identically', async () => {
    const gz2 = await request(app, 'GET', '/api/restaurants', { 'accept-encoding': 'gzip' });
    expect(gz2.status).toBe(200);
    expect(gz2.headers['content-encoding']).toBe('gzip');
    expect(gz2.headers.etag).toBe(gzipEtag);
    expect(gunzipSync(gz2.bytes).toString('utf8')).toBe(decodedCapture);
    expect(calls.list).toBe(1); // ORDER PROOF: registering gzip AFTER the cache would leave this hit identity
  });

  it('gzip revalidation answers 304 with no body and NO Content-Encoding', async () => {
    const reval = await request(app, 'GET', '/api/restaurants', {
      'accept-encoding': 'gzip',
      'if-none-match': gzipEtag,
    });
    expect(reval.status).toBe(304);
    expect(reval.bytes.length).toBe(0);
    expect(reval.headers['content-encoding']).toBeUndefined();
    expect(reval.headers.etag).toBe(gzipEtag);
    expect(calls.list).toBe(1);
  });

  it('below-threshold browse body keeps identity bytes even when gzip is wanted', async () => {
    const detail = await request(app, 'GET', `/api/restaurants/${RID}`, { 'accept-encoding': 'gzip' });
    expect(detail.status).toBe(200);
    expect(detail.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(detail.body).id).toBe(RID);
    expect(detail.headers.etag).toMatch(STRONG_ETAG_RE);
    expect(detail.headers.vary).toBe('Authorization');
  });

  it('scope: non-whitelisted routes and HEAD never encode; bearer opts out of CACHE only, not of encoding', async () => {
    const cuisines = await request(app, 'GET', '/api/restaurants/meta/cuisines', { 'accept-encoding': 'gzip' });
    expect(cuisines.headers['content-encoding']).toBeUndefined();
    expect(cuisines.headers['cache-control']).toBeUndefined();

    const head = await request(app, 'HEAD', '/api/restaurants', { 'accept-encoding': 'gzip' });
    expect(head.headers['content-encoding']).toBeUndefined();
    expect(head.bytes.length).toBe(0);

    const authed = await request(app, 'GET', '/api/restaurants', {
      'accept-encoding': 'gzip',
      authorization: 'Bearer unit-*-jwt',
    });
    expect(authed.status).toBe(200);
    expect(authed.headers['content-encoding']).toBe('gzip');
    // Bearer opts out of the CACHE entirely — no strong validator, only
    // Express's own automatic weak ETag (res.send freshness) remains.
    expect(authed.headers.etag).toMatch(/^W\/"[^"]+"$/);
    expect(authed.headers['cache-control']).toBeUndefined();
    expect(gunzipSync(authed.bytes).toString('utf8')).toContain('Probe Warung');
  });

  it('the gzip variants tally onto the SAME template key for metrics', async () => {
    const row = registry.snapshot().routes.find((r) => r.route === 'GET /api/restaurants');
    expect(row).toBeDefined();
    // capture(2xx) + identity store hit(2xx) + gzip store hit(2xx) + 304(3xx) + bearer(2xx)
    expect(row!.requests).toBe(5);
    expect(row!.byStatus['2xx']).toBe(4);
    expect(row!.byStatus['3xx']).toBe(1);
    await drain(root);
    const access200 = lines.filter((l) => {
      const req = l.req as { method?: string; url?: string } | undefined;
      const res = l.res as { statusCode?: number } | undefined;
      return res?.statusCode === 200 && req?.url === '/api/restaurants' && req?.method === 'GET';
    });
    expect(access200.length).toBe(4); // every encoded GET 200 kept its access line (HEAD excluded)
  });
});
