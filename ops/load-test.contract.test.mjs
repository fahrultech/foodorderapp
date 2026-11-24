import assert from 'node:assert/strict';
import {
  MAX_LINE_QTY,
  MIXED_LEGS,
  REPLAYS_PER_ITERATION,
  authProfile,
  browsePath,
  cacheBrowsePath,
  isStrongEtag,
  loadProfile,
  mixSearchUrl,
  mixedLegKind,
  mixedProfile,
  orderPayload,
  planCart,
  restaurantIds,
  revalidateProfile,
  thresholds,
  writeProfile,
} from './load-test.lib.mjs';

assert.deepEqual(restaurantIds({ items: [{ id: 'r1' }, { id: 'r2' }] }), ['r1', 'r2']);
assert.throws(() => restaurantIds({ items: [] }), /restaurant ids/i);
assert.throws(() => restaurantIds({}), /restaurant ids/i);

assert.equal(browsePath(0, 'abc'), '/restaurants?sort=rating&limit=20');
assert.equal(browsePath(1, 'abc'), '/restaurants/meta/cuisines');
assert.equal(browsePath(2, 'abc'), '/restaurants/abc');
assert.equal(browsePath(3, 'abc'), '/restaurants?search=rice&limit=20');
assert.equal(browsePath(4, 'abc'), '/search?q=nasi&limit=10');
assert.equal(browsePath(5, 'abc'), '/restaurants?sort=rating&limit=20');

const smoke = loadProfile('smoke');
assert.equal(smoke.browse.executor, 'constant-vus');
assert.equal(smoke.browse.vus, 1);
assert.equal(smoke.browse.duration, '15s');

const load = loadProfile('load');
assert.equal(load.browse.executor, 'ramping-vus');
assert.deepEqual(load.browse.stages, [
  { duration: '30s', target: 10 },
  { duration: '1m', target: 25 },
  { duration: '1m', target: 25 },
  { duration: '30s', target: 0 },
]);
assert.throws(() => loadProfile('unknown'), /profile/i);

assert.equal(thresholds.http_req_failed[0], 'rate<0.01');
assert.equal(thresholds.http_req_duration[0], 'p(95)<500');
assert.equal(thresholds.checks[0], 'rate>0.99');

// --- authenticated write scenario (session 82) ------------------------------

assert.equal(MAX_LINE_QTY, 50, 'must mirror CreateOrderItemDto @Max(50)');

const menu = [
  { id: 'cheap', priceCents: 500, isAvailable: true },
  { id: 'mid', priceCents: 20000, isAvailable: true },
  { id: 'gone', priceCents: 30000, isAvailable: false },
];
// cheapest rotated-first dish: quantity grows to clear the minimum
assert.deepEqual(planCart(menu, 1000, 0).lines, [{ menuItemId: 'cheap', quantity: 2 }]);
// offset rotates the starting dish so iterations spread across the menu
assert.deepEqual(planCart(menu, 1000, 1).lines, [{ menuItemId: 'mid', quantity: 1 }]);
// unavailable dishes are never picked, whatever the offset
for (let i = 0; i < 4; i += 1) {
  assert.ok(planCart(menu, 1, i).lines.every((l) => l.menuItemId !== 'gone'));
}
// per-line cap spills onto a second line
const spill = planCart(
  [
    { id: 'a', priceCents: 100, isAvailable: true },
    { id: 'b', priceCents: 10000, isAvailable: true },
  ],
  6000,
  0,
);
assert.deepEqual(spill.lines, [
  { menuItemId: 'a', quantity: 50 },
  { menuItemId: 'b', quantity: 1 },
]);
assert.equal(spill.subtotalCents, 15000);
// impossible menu and empty menu are fixture drift, not perf results
assert.throws(() => planCart([{ id: 'x', priceCents: 100, isAvailable: true }], 6000), /cannot reach min/i);
assert.throws(() => planCart([{ id: 'x', priceCents: 100, isAvailable: false }], 1), /orderable/i);
assert.throws(() => planCart([], 1), /orderable/i);
assert.throws(() => planCart(undefined, 1), /orderable/i);
// sold-out rows (stock 0) are excluded
assert.throws(() => planCart([{ id: 'z', priceCents: 900, isAvailable: true, stock: 0 }], 1), /orderable/i);

const payload = orderPayload('r1', [{ menuItemId: 'm1', quantity: 2 }], {
  name: 'LT',
  phone: '+62 811 00001',
  email: 'lt@load.test',
  address: 'Jl. Load Test 1',
});
assert.equal(payload.restaurantId, 'r1');
assert.deepEqual(payload.items, [{ menuItemId: 'm1', quantity: 2 }]);
assert.equal(payload.customerName, 'LT');
assert.equal(payload.contactEmail, 'lt@load.test');
// no client-supplied money survives the DTO surface
assert.ok(!('totalCents' in payload) && !('deliveryFeeCents' in payload) && !('promoCode' in payload));

const authSmoke = authProfile('smoke');
assert.equal(authSmoke.checkout.executor, 'constant-vus');
assert.equal(authSmoke.checkout.vus, 1);
const authLoad = authProfile('load');
assert.equal(authLoad.checkout.executor, 'ramping-vus');
assert.deepEqual(authLoad.checkout.stages, [
  { duration: '20s', target: 5 },
  { duration: '40s', target: 10 },
  { duration: '1m', target: 10 },
  { duration: '20s', target: 0 },
]);
assert.throws(() => authProfile('unknown'), /profile/i);

// --- conditional-GET replay scenario (session 104) ---------------------------

assert.equal(REPLAYS_PER_ITERATION, 2);

// The replay rotation must cover EVERY route template session 103
// whitelisted in cacheTargetOf — session 126 added the fourth URL shape,
// /api/search (the rotation previously only "searched" through the list
// `search=` filter, a DIFFERENT route; meta/cuisines can never 304 and
// stays OUT).
assert.equal(cacheBrowsePath(0, 'abc'), '/restaurants?sort=rating&limit=20');
assert.equal(cacheBrowsePath(1, 'abc'), '/restaurants/abc');
assert.equal(cacheBrowsePath(2, 'abc'), '/restaurants?search=rice&limit=20');
assert.equal(cacheBrowsePath(3, 'abc'), '/search?q=nasi&limit=10');
assert.equal(cacheBrowsePath(4, 'abc'), '/restaurants?sort=rating&limit=20');
for (let i = 0; i < 12; i += 1) {
  const p = cacheBrowsePath(i, 'abc');
  assert.ok(!p.includes('/meta/'), `replay path ${p} is not cache-whitelisted`);
}
// Mirror of the cacheTargetOf EXACT-PATH truth (query string stripped):
// every replay path must map to one of the three whitelisted templates —
// '/api/restaurants', '/api/restaurants/<uuid>' or '/api/search'. Anything
// else would be a transparent pass-through whose replay 200s and fails the
// profile's own abort contract; the pin catches the mistake at test time.
const contractIds = [
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  'ffffffff-1111-2222-3333-444444444444',
];
const CACHE_TEMPLATES = new Set(['/restaurants', '/search']);
for (let i = 0; i < 12; i += 1) {
  const p = cacheBrowsePath(i, contractIds[i % 2]);
  const pathOnly = p.split('?')[0];
  if (CACHE_TEMPLATES.has(pathOnly)) continue;
  assert.ok(pathOnly.startsWith('/restaurants/'), `replay path ${p} matches no whitelist template`);
  assert.equal(pathOnly.split('/').length, 3, `replay path ${p} is a sub-path`);
}
// session-103 cacheTargetOf truth: '/restaurants/<id>' is only a cache target
// when the id is a uuid — the replay profile must never hand it anything else.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
for (let i = 0; i < 12; i += 1) {
  const p = cacheBrowsePath(i, contractIds[i % 2]);
  const seg = p.startsWith('/restaurants/') ? p.slice('/restaurants/'.length) : null;
  assert.ok(seg === null || UUID_RE.test(seg), `replay detail path ${p} is not uuid-gated`);
}

// isStrongEtag mirrors etagFor: quoted, no W/ prefix (session 103 emits
// '"<sha256-32hex>"'; Express's weak auto-etag must NOT pass).
assert.equal(isStrongEtag('"0123456789abcdef0123456789abcdef"'), true);
assert.equal(isStrongEtag('W/"0123456789abcdef0123456789abcdef"'), false);
assert.equal(isStrongEtag('"a"'), true, 'quoted and non-empty is a strong tag');
assert.equal(isStrongEtag('unquoted'), false);
assert.equal(isStrongEtag(undefined), false);
assert.equal(isStrongEtag('""'), false);

const condSmoke = revalidateProfile('smoke');
assert.equal(condSmoke.revalidate.executor, 'constant-vus');
assert.equal(condSmoke.revalidate.vus, 1);
assert.equal(condSmoke.revalidate.duration, '15s');
const condLoad = revalidateProfile('load');
assert.equal(condLoad.revalidate.executor, 'ramping-vus');
assert.deepEqual(
  condLoad.revalidate.stages,
  loadProfile('load').browse.stages,
  'revalidate load must keep the browse VU shape for comparable latency columns',
);
assert.throws(() => revalidateProfile('unknown'), /profile/i);

// --- write ladder over the cached+compressed stack (session 121) -----------

const writeSmoke = writeProfile('smoke');
assert.equal(writeSmoke.ladder.executor, 'constant-vus');
assert.equal(writeSmoke.ladder.vus, 1);
assert.equal(writeSmoke.ladder.duration, '30s');
const writeLoad = writeProfile('load');
assert.equal(writeLoad.ladder.executor, 'ramping-vus');
assert.deepEqual(writeLoad.ladder.stages, [
  { duration: '20s', target: 3 },
  { duration: '40s', target: 5 },
  { duration: '1m', target: 5 },
  { duration: '20s', target: 0 },
], 'write ladder plateau stays MODEST (5 VUs) — roadmap Phase 12 wording');
assert.throws(() => writeProfile('unknown'), /profile/i);
// The write ladder reuses the same pure cart/payload helpers as the auth
// scenario — pin that the rotation dish plan is byte-stable across both.
assert.deepEqual(
  planCart(menu, 1000, 0),
  planCart(menu, 1000, 0),
  'planCart must stay deterministic for cross-baseline comparability',
);

// --- mixed hit/miss RATIO scenario (session 128, Phase 14 #1) --------------

assert.deepEqual(MIXED_LEGS, ['capture', 'revalidate', 'recycle']);
// The leg cycle is one of each class per iteration in exactly this order:
// 'capture' FIRST (the ETag the other two legs reuse comes from it), and
// the long-run composition is a 1:1:1 miss/revalidation/served fleet —
// the "intermediate" session 104 left open.
assert.equal(mixedLegKind(0), 'capture');
assert.equal(mixedLegKind(1), 'revalidate');
assert.equal(mixedLegKind(2), 'recycle');
assert.equal(mixedLegKind(3), 'capture', 'cycle wraps to capture');
for (let i = 0; i < 60; i += 1) {
  const kinds = [0, 1, 2].map((l) => mixedLegKind(i * 3 + l)).join(',');
  assert.equal(kinds, 'capture,revalidate,recycle', `iteration ${i} leg order`);
}

// Discovery URL: unique q keyed on (runTag, vu, iteration) — the ONLY
// whitelisted template with an unbounded key space is /api/search (the
// bounded store's eviction behavior is the point at load rate). Byte-stable
// for identical inputs, and NEVER carrying meta/ or a sub-path.
assert.equal(mixSearchUrl('k128run', 3, 17), '/search?q=k128run.3.17&limit=5');
assert.equal(mixSearchUrl('k128run', 3, 17), mixSearchUrl('k128run', 3, 17));
assert.notEqual(mixSearchUrl('k128run', 3, 17), mixSearchUrl('k128run', 3, 18));
assert.notEqual(mixSearchUrl('k128run', 3, 17), mixSearchUrl('k128run', 4, 17));
for (const args of [
  ['', 1, 1],
  ['Bad-Tag', 1, 1],
  ['UPPER', 1, 1],
  [null, 1, 1],
  ['tag.dotted', 1, 1],
]) {
  assert.throws(
    () => mixSearchUrl(...args),
    /RUN_TAG/i,
    `runTag ${JSON.stringify(args[0])} must fail loudly, not silently warm the cache`,
  );
}
const UUID_MIRROR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
for (let i = 0; i < 30; i += 1) {
  const p = mixSearchUrl('k128pin', i % 25, i);
  assert.ok(p.startsWith('/search?q='), `mixed discovery path ${p} is not search-shaped`);
  assert.ok(!p.includes('/meta/'), `mixed path ${p} is not cache-whitelisted`);
  assert.ok(!UUID_MIRROR.test(p.split('?')[0].slice('/search'.length)), 'no sub-path');
}

const mixedSmoke = mixedProfile('smoke');
assert.equal(mixedSmoke.mixed.executor, 'constant-vus');
assert.equal(mixedSmoke.mixed.vus, 1);
assert.equal(mixedSmoke.mixed.duration, '15s');
const mixedLoad = mixedProfile('load');
assert.equal(mixedLoad.mixed.executor, 'ramping-vus');
assert.deepEqual(
  mixedLoad.mixed.stages,
  loadProfile('load').browse.stages,
  'mixed load must keep the browse VU shape for comparable latency columns',
);
assert.throws(() => mixedProfile('unknown'), /profile/i);

console.log('load-test contract: ok (browse + auth + conditional + write + mixed)');
