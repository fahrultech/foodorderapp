export const thresholds = Object.freeze({
  http_req_failed: ['rate<0.01'],
  http_req_duration: ['p(95)<500', 'p(99)<1000'],
  checks: ['rate>0.99'],
});

const profiles = Object.freeze({
  smoke: Object.freeze({
    browse: Object.freeze({
      executor: 'constant-vus',
      vus: 1,
      duration: '15s',
      gracefulStop: '5s',
    }),
  }),
  load: Object.freeze({
    browse: Object.freeze({
      executor: 'ramping-vus',
      startVUs: 0,
      stages: Object.freeze([
        Object.freeze({ duration: '30s', target: 10 }),
        Object.freeze({ duration: '1m', target: 25 }),
        Object.freeze({ duration: '1m', target: 25 }),
        Object.freeze({ duration: '30s', target: 0 }),
      ]),
      gracefulRampDown: '10s',
      gracefulStop: '10s',
    }),
  }),
});

export function loadProfile(name) {
  const profile = profiles[name];
  if (!profile) {
    throw new Error(`Unknown load-test profile: ${name}. Expected smoke or load.`);
  }
  return profile;
}

export function restaurantIds(payload) {
  const ids = payload?.items
    ?.map((item) => item?.id)
    .filter((id) => typeof id === 'string' && id.length > 0);
  if (!ids?.length) throw new Error('No restaurant ids found in bootstrap response.');
  return ids;
}

export function browsePath(iteration, restaurantId) {
  const paths = [
    '/restaurants?sort=rating&limit=20',
    '/restaurants/meta/cuisines',
    `/restaurants/${restaurantId}`,
    '/restaurants?search=rice&limit=20',
  ];
  return paths[iteration % paths.length];
}

// ---------------------------------------------------------------------------
// Authenticated WRITE scenario (session 82). The cart on the storefront is
// client-side localStorage, so its API-side equivalent is the menu browse +
// order-create pair the checkout page submits. The pure parts (cart planning,
// payload shape, profiles) live here so load-test.contract.test.mjs pins them
// under `node --test` — the same reason the browse helpers live here.
// ---------------------------------------------------------------------------

/** Mirrors CreateOrderItemDto's @Max(50) — keep the two in lockstep. */
export const MAX_LINE_QTY = 50;

const AUTH_PROFILES = Object.freeze({
  smoke: Object.freeze({
    checkout: Object.freeze({
      executor: 'constant-vus',
      vus: 1,
      duration: '30s',
      gracefulStop: '5s',
    }),
  }),
  load: Object.freeze({
    checkout: Object.freeze({
      executor: 'ramping-vus',
      startVUs: 0,
      // Write-path iterations are heavier than browse (a transactional
      // order + two payment calls + stock guard), so the plateau is 10 VUs,
      // not the public browse profile's 25.
      stages: Object.freeze([
        Object.freeze({ duration: '20s', target: 5 }),
        Object.freeze({ duration: '40s', target: 10 }),
        Object.freeze({ duration: '1m', target: 10 }),
        Object.freeze({ duration: '20s', target: 0 }),
      ]),
      gracefulRampDown: '10s',
      gracefulStop: '15s',
    }),
  }),
});

export function authProfile(name) {
  const profile = AUTH_PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown auth load-test profile: ${name}. Expected smoke or load.`);
  }
  return profile;
}

/**
 * Pure: pick order lines from a restaurant-detail payload that clear the
 * restaurant's minOrderCents (integer cents — the server recomputes every
 * money figure regardless). Dishes spell the availability flag `isAvailable`
 * on this API; `available`/`stock` are tolerated for future payloads.
 * `offset` rotates the starting dish so consecutive iterations spread load
 * across the menu instead of hammering one row (one dish per line, quantity
 * capped at MAX_LINE_QTY, spilling to a second line when needed).
 * Throws when the menu cannot satisfy the minimum — that is fixture drift,
 * not a perf result, and the caller aborts the test on it.
 */
export function planCart(menuItems, minOrderCents, offset = 0) {
  const pool = (Array.isArray(menuItems) ? menuItems : []).filter(
    (m) =>
      m &&
      typeof m.id === 'string' &&
      m.id.length > 0 &&
      Number.isFinite(m.priceCents) &&
      m.priceCents > 0 &&
      m.isAvailable !== false &&
      m.available !== false &&
      m.stock !== 0,
  );
  if (!pool.length) throw new Error('No orderable dishes in menu payload');
  const start = ((offset % pool.length) + pool.length) % pool.length;
  const rotated = pool.slice(start).concat(pool.slice(0, start));
  const target = Math.max(Number.isFinite(minOrderCents) ? minOrderCents : 0, 1);
  const lines = [];
  let subtotalCents = 0;
  for (const dish of rotated) {
    if (subtotalCents >= target) break;
    const need = target - subtotalCents;
    const quantity = Math.min(MAX_LINE_QTY, Math.max(1, Math.ceil(need / dish.priceCents)));
    lines.push({ menuItemId: dish.id, quantity });
    subtotalCents += quantity * dish.priceCents;
  }
  if (subtotalCents < target) {
    throw new Error(
      `Menu cannot reach min order ${target} cents within per-line cap ${MAX_LINE_QTY}`,
    );
  }
  return { lines, subtotalCents };
}

/**
 * Pure: CreateOrderDto body for a signed-in test customer. Deliberately
 * carries NO money fields — subtotal/fee/total/promo are recomputed
 * server-side (see OrdersService.create). The contact triple is required
 * unless the flow switches to a saved deliveryAddressId.
 */
export function orderPayload(restaurantId, lines, identity) {
  return {
    restaurantId,
    items: lines,
    customerName: identity.name,
    contactPhone: identity.phone,
    contactEmail: identity.email,
    deliveryAddress: identity.address,
  };
}

// ---------------------------------------------------------------------------
// Conditional-GET replay scenario (session 104, PERFORMANCE.md rec 6). The
// public browse profile never sends If-None-Match — k6 does not implement an
// HTTP cache — so the session-103 ETag layer only saves server-side SQL there.
// This scenario measures the 304 path head-on: one unconditional GET captures
// the ETag, then replays it, and every replay MUST be a 304 (read-only
// fixture, so the bytes never change).
// ---------------------------------------------------------------------------

/**
 * Pure: pick a replayable browse path. These MUST stay exactly the three
 * URL shapes session 103 whitelisted in `cacheTargetOf` (restaurant list,
 * uuid detail, list-with-search). `/restaurants/meta/cuisines` is a SUB-PATH
 * the whitelist deliberately excludes — it can never answer 304, so slipping
 * it in here would make the honest 304 checks below fail at runtime, not
 * silently measure the wrong thing. The contract test pins that invariant.
 */
export function cacheBrowsePath(iteration, restaurantId) {
  const paths = [
    '/restaurants?sort=rating&limit=20',
    `/restaurants/${restaurantId}`,
    '/restaurants?search=rice&limit=20',
  ];
  return paths[iteration % paths.length];
}

/** Number of If-None-Match replays issued after each capture request. */
export const REPLAYS_PER_ITERATION = 2;

/**
 * Pure: a STRONG ETag is a quoted entity-tag without the `W/` prefix —
 * exactly what session 103's `etagFor` emits (`"<sha256-32hex>"`). A weak
 * tag would mean Express's auto-etag leaked past our layer (cold `*` case),
 * which is not what this profile is measuring.
 */
export function isStrongEtag(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('"') &&
    value.endsWith('"') &&
    value.length > 2 &&
    !value.startsWith('W/')
  );
}

const REVALIDATE_PROFILES = Object.freeze({
  smoke: Object.freeze({
    revalidate: Object.freeze({
      executor: 'constant-vus',
      vus: 1,
      duration: '15s',
      gracefulStop: '5s',
    }),
  }),
  load: Object.freeze({
    revalidate: Object.freeze({
      executor: 'ramping-vus',
      startVUs: 0,
      // Same VU shape as the public browse load profile so the latency
      // columns compare directly; each iteration carries
      // 1 + REPLAYS_PER_ITERATION requests.
      stages: Object.freeze([
        Object.freeze({ duration: '30s', target: 10 }),
        Object.freeze({ duration: '1m', target: 25 }),
        Object.freeze({ duration: '1m', target: 25 }),
        Object.freeze({ duration: '30s', target: 0 }),
      ]),
      gracefulRampDown: '10s',
      gracefulStop: '10s',
    }),
  }),
});

export function revalidateProfile(name) {
  const profile = REVALIDATE_PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown revalidate load-test profile: ${name}. Expected smoke or load.`);
  }
  return profile;
}
