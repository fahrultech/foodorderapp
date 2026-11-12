import assert from 'node:assert/strict';
import {
  MAX_LINE_QTY,
  authProfile,
  browsePath,
  loadProfile,
  orderPayload,
  planCart,
  restaurantIds,
  thresholds,
} from './load-test.lib.mjs';

assert.deepEqual(restaurantIds({ items: [{ id: 'r1' }, { id: 'r2' }] }), ['r1', 'r2']);
assert.throws(() => restaurantIds({ items: [] }), /restaurant ids/i);
assert.throws(() => restaurantIds({}), /restaurant ids/i);

assert.equal(browsePath(0, 'abc'), '/restaurants?sort=rating&limit=20');
assert.equal(browsePath(1, 'abc'), '/restaurants/meta/cuisines');
assert.equal(browsePath(2, 'abc'), '/restaurants/abc');
assert.equal(browsePath(3, 'abc'), '/restaurants?search=rice&limit=20');
assert.equal(browsePath(4, 'abc'), '/restaurants?sort=rating&limit=20');

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

console.log('load-test contract: ok (browse + auth)');
