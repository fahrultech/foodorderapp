import assert from 'node:assert/strict';
import {
  browsePath,
  loadProfile,
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

console.log('load-test contract: ok');
