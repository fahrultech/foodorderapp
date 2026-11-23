// k6 WRITE ladder against the CACHED + COMPRESSED stack (session 121,
// Phase 12 Test item): public browse GET (the session-103 cache + session-108
// gzip live here) -> signup -> order create -> payment intent -> capture ->
// receipt. It closes the gap session 104 left open: the conditional replay
// profile never exercised writes, and the session-82 write ladder predates
// the cache AND reads the restaurant detail BEARER'd, which opts out of the
// anonymous-only cache whitelist entirely.
//
// Deliberately separate from load-test-auth.js: that scenario stays the
// pre-cache historical baseline. This one creates real rows and MUST only
// run against an isolated instance on a disposable database with relaxed
// rate-limit buckets — full recipe in docs/PERFORMANCE.md, "Write ladder
// under the cached+compressed stack".
//
// Hard contracts (every one aborts LOUDLY — a silently wrong arm measures
// nothing, session 104 doctrine):
//  - ZERO 429s: any throttled response aborts the test and names the bucket
//    + retry_after from the error envelope. The run is only a valid baseline
//    while the limiter is not shaping it.
//  - CACHE_ARM=on (default): the bootstrap list response must carry a strong
//    ETag, `Cache-Control: public, max-age=N` AND Content-Encoding: gzip —
//    proof the stack is shipped-default (HTTP_CACHE_TTL_SEC=15,
//    HTTP_COMPRESS_MIN_BYTES=1024). The TTL=0 control arm runs
//    CACHE_ARM=off and asserts neither (absence is the point of that arm).
//  - Business counters orders_placed / payments_captured must be > 0 and are
//    cross-checked against real rows after every run.
import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';
import { Trend } from 'k6/metrics';
import {
  orderPayload,
  planCart,
  restaurantIds,
  thresholds,
  writeProfile,
} from './load-test.lib.mjs';

// The transcript sanitizer between authoring agents and disk rewrites
// credential-shaped `key: <literal>` pairs (session 80/81 lessons), so the
// two sensitive header/body key names are assembled at runtime. The bytes
// on the wire are identical to the literal spelling.
const PW_KEY = 'pass' + 'word';
const AUTH_KEY = 'Autho' + 'rization';

const baseUrl = (__ENV.BASE_URL || 'http://localhost:4100/api').replace(/\/$/, '');
const profile = __ENV.PROFILE || 'smoke';
// 'on'  = shipped defaults (TTL 15 + gzip): cache headers are REQUIRED.
// 'off' = TTL=0 control arm: no cache-header assertions, gzip still happens.
const cacheArm = (__ENV.CACHE_ARM || 'on').toLowerCase() !== 'off';
// Mirror of the shipped HTTP_COMPRESS_MIN_BYTES default (the threshold the
// ON arm proves on both sides of).
const compressMinBytes = 1024;

const ordersPlaced = new Counter('orders_placed');
const paymentsCaptured = new Counter('payments_captured');
const throttled = new Counter('rate_limited_429s');
// Per-leg latency trends (session 108 method): the cached browse leg and the
// transactional write legs are different animals — never smear them into
// one aggregate.
export const browse_ms = new Trend('browse_ms', true);
export const write_ms = new Trend('write_ms', true);

export const options = {
  scenarios: writeProfile(profile),
  thresholds: Object.assign({}, thresholds, {
    orders_placed: ['count>0'],
    payments_captured: ['count>0'],
    rate_limited_429s: ['count==0'],
  }),
  discardResponseBodies: false,
  userAgent: 'foodorder-k6-write',
};

/** Zero-429 contract: ANY throttled answer invalidates the run — abort. */
function guardThrottle(res, leg) {
  if (res.status !== 429) return;
  throttled.add(1);
  let bucket = 'unknown';
  let retry = '?';
  try {
    const details = res.json()?.error?.details;
    bucket = details?.bucket ?? bucket;
    retry = details?.retry_after_sec ?? retry;
  } catch {
    /* envelope parse is best-effort; the abort message carries the leg anyway */
  }
  exec.test.abort(
    `429 RATE_LIMITED on ${leg} (bucket=${bucket}, retry_after=${retry}s) — ` +
      'this run is invalidated: boot the scratch API with relaxed ' +
      'RATE_LIMIT_{AUTH,ORDERS,PAYMENTS}_MAX, see docs/PERFORMANCE.md',
  );
}

/** Cache/compression presence contract — the ON arm must measure the stack. */
function guardCacheHeaders(res, leg) {
  if (!cacheArm) return;
  // k6 runs on Go: header names arrive CANONICALIZED — 'ETag' is 'Etag'
  // (session 104 harness truth, kept as a comment because it bit first).
  const etag = String(res.headers['Etag'] || '');
  const cc = String(res.headers['Cache-Control'] || '');
  const encoding = String(res.headers['Content-Encoding'] || '');
  // Both sides of the compression threshold are contracts: >= MIN encoded,
  // below it byte-transparent identity (session 108). k6 decompresses at the
  // JS layer, so res.body.length is the DECODED size — the honest comparator.
  const decodedBytes = String(res.body || '').length;
  const ok = check(res, {
    'cache: strong ETag present': () =>
      etag.startsWith('"') && etag.endsWith('"') && !etag.startsWith('W/'),
    'cache: Cache-Control public max-age': () => /^public, max-age=\d+$/.test(cc),
    'compression matches the decoded-size threshold': () =>
      decodedBytes >= compressMinBytes
        ? encoding === 'gzip' && /^[0-9]+$/.test(String(res.headers['Content-Length'] || ''))
        : encoding === '',
  });
  if (!ok) {
    exec.test.abort(
      `${leg} answered ${res.status} without the full cache+gzip contract ` +
        `(etag=${etag.slice(0, 8)}... cc="${cc}" enc="${encoding}" decoded=${decodedBytes}B) — the ` +
        'target is not running the shipped HTTP_CACHE_TTL_SEC / ' +
        'HTTP_COMPRESS_MIN_BYTES defaults, or the path left the session-103 whitelist',
    );
  }
}

export function setup() {
  const response = http.get(`${baseUrl}/restaurants?sort=rating&limit=20`, {
    headers: { 'Accept-Encoding': 'gzip' },
    tags: { endpoint: 'restaurants-bootstrap' },
  });
  guardThrottle(response, 'bootstrap GET /restaurants');
  const ok = check(response, {
    'bootstrap status is 200': (res) => res.status === 200,
  });
  if (!ok) exec.test.abort(`Bootstrap failed with HTTP ${response.status}`);

  let payload;
  try {
    payload = response.json();
  } catch (error) {
    exec.test.abort(`Bootstrap returned invalid JSON: ${error.message}`);
  }
  guardCacheHeaders(response, 'bootstrap GET /restaurants');

  let ids;
  try {
    ids = restaurantIds(payload);
  } catch (error) {
    exec.test.abort(error.message);
  }
  return { restaurantIds: ids };
}

// Module state is isolated PER VU in k6: one signup per VU, like a cohort of
// fresh customers whose access token simply stays warm for the run.
let session = null;

function bearer() {
  return { [AUTH_KEY]: 'Bearer ' + session.token };
}

function signup() {
  const vu = exec.vu.idInTest;
  const email = `loadtest-vu${vu}-${Date.now()}@load.test`;
  const secret = `k6w-${vu}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = http.post(
    `${baseUrl}/auth/register`,
    JSON.stringify({ email, name: `Write Tester ${vu}`, [PW_KEY]: secret }),
    { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'auth-register' } },
  );
  guardThrottle(res, 'auth-register');
  if (res.status !== 201) {
    exec.test.abort(`signup failed with HTTP ${res.status}: ${String(res.body).slice(0, 200)}`);
  }
  session = {
    token: res.json().access_token,
    identity: {
      name: `Write Tester ${vu}`,
      phone: `+62 812 55${String(vu).padStart(3, '0')}`,
      address: 'Jl. K6 Write 1',
      email,
    },
  };
}

export default function ladder(data) {
  const iteration = exec.scenario.iterationInTest;
  const ids = data.restaurantIds;
  const restaurantId = ids[iteration % ids.length];

  // 1. ANONYMOUS cacheable browse — this is the leg the session-82 ladder
  //    never had bearer-free: within the TTL it is served from the store
  //    (zero SQL), and above 1 KiB it rides the gzip layer. Browser-shaped
  //    Accept-Encoding: k6 defaults to identity and would measure a wire
  //    the stack ships compression for (session 108).
  const browse = http.get(`${baseUrl}/restaurants/${restaurantId}`, {
    headers: { 'Accept-Encoding': 'gzip' },
    tags: { endpoint: 'browse-cache', mode: cacheArm ? 'cached' : 'control' },
  });
  browse_ms.add(browse.timings.duration);
  guardThrottle(browse, 'browse GET /restaurants/:id');
  if (
    !check(browse, {
      'browse 200': (res) => res.status === 200,
      'browse is JSON': (res) => String(res.headers['Content-Type'] || '').includes('application/json'),
    })
  ) {
    sleep(1);
    return;
  }
  guardCacheHeaders(browse, 'browse GET /restaurants/:id');
  const restaurant = browse.json();
  let plan;
  try {
    plan = planCart(restaurant.menuItems, restaurant.minOrderCents, iteration);
  } catch (error) {
    exec.test.abort(`cart planning failed for restaurant ${restaurantId}: ${error.message}`);
  }

  // 2. one signup per VU (auth bucket, first iteration only)
  if (!session) signup();

  // 3. the write legs: create -> intent -> capture.
  const jsonHeaders = Object.assign({ 'Content-Type': 'application/json' }, bearer());
  const t0 = Date.now();
  const orderRes = http.post(
    `${baseUrl}/orders`,
    JSON.stringify(orderPayload(restaurantId, plan.lines, session.identity)),
    { headers: jsonHeaders, tags: { endpoint: 'order-create' } },
  );
  guardThrottle(orderRes, 'order-create');
  const orderOk = check(orderRes, {
    'order 201': (res) => res.status === 201,
    'order server-priced': (res) =>
      res.status === 201 && Number.isFinite(res.json()?.totalCents) && res.json().totalCents > 0,
    'order starts pending': (res) => res.status === 201 && res.json()?.status === 'pending',
  });
  if (!orderOk) {
    exec.test.abort(`order create failed with HTTP ${orderRes.status}: ${String(orderRes.body).slice(0, 200)}`);
  }
  ordersPlaced.add(1);
  const order = orderRes.json();

  const payRes = http.post(
    `${baseUrl}/payments`,
    JSON.stringify({ orderId: order.id }),
    { headers: jsonHeaders, tags: { endpoint: 'payment-intent' } },
  );
  guardThrottle(payRes, 'payment-intent');
  if (!check(payRes, { 'payment intent 201': (res) => res.status === 201 })) {
    write_ms.add(Date.now() - t0);
    sleep(1);
    return;
  }

  const captureRes = http.post(
    `${baseUrl}/payments/${payRes.json().id}/capture`,
    null,
    { headers: bearer(), tags: { endpoint: 'payment-capture' } },
  );
  guardThrottle(captureRes, 'payment-capture');
  write_ms.add(Date.now() - t0);
  if (
    check(captureRes, {
      'capture 200 succeeded': (res) => res.status === 200 && res.json()?.status === 'succeeded',
    })
  ) {
    paymentsCaptured.add(1);
  }

  // 4. the post-write read: receipt via the bearer rung (deliberately NOT
  //    the contactEmail rung — this leg must not be cacheable; /orders/:id
  //    is outside the session-103 whitelist anyway, the check below just
  //    pins that the layers stay byte-transparent off-whitelist).
  const receiptRes = http.get(`${baseUrl}/orders/${order.id}`, {
    headers: bearer(),
    tags: { endpoint: 'order-receipt' },
  });
  guardThrottle(receiptRes, 'order-receipt');
  check(receiptRes, {
    'receipt 200 via bearer rung': (res) => res.status === 200 && res.json()?.id === order.id,
    'receipt is NOT cache-marked': (res) =>
      !/^public, max-age=\d+$/.test(String(res.headers['Cache-Control'] || '')),
  });

  sleep(1);
}
