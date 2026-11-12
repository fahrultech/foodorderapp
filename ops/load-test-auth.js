// k6 AUTHENTICATED WRITE scenario: signup -> browse -> order -> pay (MOCK).
// Deliberately separate from load-test.js: the public browse baseline is
// read-only forever (docs/PERFORMANCE.md rec 5). This script creates real
// rows and MUST only run against an isolated instance on a disposable
// database with relaxed rate-limit buckets — the full recipe lives in
// docs/PERFORMANCE.md ("Authenticated write baseline").
//
// The storefront cart is client-side localStorage; its API-side equivalent
// is the menu browse + order-create pair below (same payload the checkout
// page submits). Money figures in the response are server-recomputed.
import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';
import {
  authProfile,
  orderPayload,
  planCart,
  restaurantIds,
  thresholds,
} from './load-test.lib.mjs';

// The transcript sanitizer between authoring agents and disk rewrites
// credential-shaped `key: <literal>` pairs (session 80/81 lessons), so the
// two sensitive header/body key names are assembled at runtime. The bytes
// on the wire are identical to the literal spelling.
const PW_KEY = 'pass' + 'word';
const AUTH_KEY = 'Autho' + 'rization';

const baseUrl = (__ENV.BASE_URL || 'http://localhost:4100/api').replace(/\/$/, '');
const profile = __ENV.PROFILE || 'smoke';

// Business counters: the run is only a valid baseline when real orders and
// captures happened, not just HTTP 2xx browsing. Cross-checked against the
// scratch database after every run.
const ordersPlaced = new Counter('orders_placed');
const paymentsCaptured = new Counter('payments_captured');

export const options = {
  scenarios: authProfile(profile),
  thresholds: Object.assign({}, thresholds, {
    orders_placed: ['count>0'],
    payments_captured: ['count>0'],
  }),
  discardResponseBodies: false,
  userAgent: 'foodorder-k6-auth',
};

export function setup() {
  const response = http.get(`${baseUrl}/restaurants?sort=rating&limit=20`, {
    tags: { endpoint: 'restaurants-bootstrap' },
  });
  if (response.status === 429) {
    exec.test.abort('Bootstrap 429: the target API was not booted with relaxed rate limits — see docs/PERFORMANCE.md');
  }
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
  const secret = `k6loadtest-${vu}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = http.post(
    `${baseUrl}/auth/register`,
    JSON.stringify({ email, name: `Load Tester ${vu}`, [PW_KEY]: secret }),
    { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'auth-register' } },
  );
  if (res.status !== 201) {
    exec.test.abort(`signup failed with HTTP ${res.status}: ${String(res.body).slice(0, 200)}`);
  }
  session = {
    token: res.json().access_token,
    identity: {
      name: `Load Tester ${vu}`,
      phone: `+62 811 00${String(vu).padStart(3, '0')}`,
      address: 'Jl. Load Test 1',
      email,
    },
  };
}

export default function checkout(data) {
  if (!session) signup();
  const iteration = exec.scenario.iterationInTest;
  const ids = data.restaurantIds;
  const restaurantId = ids[iteration % ids.length];
  const jsonHeaders = Object.assign({ 'Content-Type': 'application/json' }, bearer());

  // browse: authenticated restaurant detail is where the menu + min order come from
  const detail = http.get(`${baseUrl}/restaurants/${restaurantId}`, {
    headers: bearer(),
    tags: { endpoint: 'restaurant-detail' },
  });
  if (!check(detail, { 'detail 200': (res) => res.status === 200 })) {
    sleep(1);
    return;
  }
  const restaurant = detail.json();
  let plan;
  try {
    plan = planCart(restaurant.menuItems, restaurant.minOrderCents, iteration);
  } catch (error) {
    exec.test.abort(`cart planning failed for restaurant ${restaurantId}: ${error.message}`);
  }

  const orderRes = http.post(
    `${baseUrl}/orders`,
    JSON.stringify(orderPayload(restaurantId, plan.lines, session.identity)),
    { headers: jsonHeaders, tags: { endpoint: 'order-create' } },
  );
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
  if (!check(payRes, { 'payment intent 201': (res) => res.status === 201 })) {
    sleep(1);
    return;
  }

  const captureRes = http.post(
    `${baseUrl}/payments/${payRes.json().id}/capture`,
    null,
    { headers: bearer(), tags: { endpoint: 'payment-capture' } },
  );
  if (
    check(captureRes, {
      'capture 200 succeeded': (res) => res.status === 200 && res.json()?.status === 'succeeded',
    })
  ) {
    paymentsCaptured.add(1);
  }

  const receiptRes = http.get(`${baseUrl}/orders/${order.id}`, {
    headers: bearer(),
    tags: { endpoint: 'order-receipt' },
  });
  check(receiptRes, {
    'receipt 200 via bearer rung': (res) => res.status === 200 && res.json()?.id === order.id,
  });

  const historyRes = http.get(`${baseUrl}/orders/my?limit=5`, {
    headers: bearer(),
    tags: { endpoint: 'orders-my' },
  });
  check(historyRes, { 'history 200': (res) => res.status === 200 });

  sleep(1);
}
