import { expect, test } from '@playwright/test';
import { signInUi } from '../helpers/fixtures';

/**
 * Traffic & error-budget panel (session 85) on /admin.
 *
 * Deliberately SHAPE-based, never absolute numbers: GET /api/admin/metrics is
 * cumulative since the API process booted, so counts depend on which specs
 * ran before this one (and on server reuse across runs). Instead the tests
 * cross-check the DOM against the payload the page ITSELF received —
 * captured live via waitForResponse — so the binding between the registry
 * snapshot and the rendered cards/table is what is proven.
 */

async function signInAsAdmin(page: import('@playwright/test').Page) {
  // Session-93 redirect guard is structural now (shared signInUi, 106).
  await signInUi(page, 'admin@foodorder.app', { goto: '/login' });
  await expect(page.getByRole('link', { name: 'Admin' })).toBeVisible();
}

test('admin traffic cards mirror the live /admin/metrics payload', async ({ page }) => {
  await signInAsAdmin(page);

  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/admin/metrics') && res.status() === 200,
    ),
    page.getByRole('link', { name: 'Admin' }).click(),
  ]);
  const payload = await response.json();

  // Contract pin: every field the panel reads must exist on the wire.
  expect(payload.totals).toHaveProperty('requests');
  expect(payload.totals.byStatus).toEqual(
    expect.objectContaining({ '2xx': expect.any(Number), '5xx': expect.any(Number) }),
  );
  expect(Array.isArray(payload.routes)).toBe(true);
  expect(typeof payload.uptimeSec).toBe('number');

  await expect(page.getByRole('heading', { level: 2, name: 'Traffic & error budget' })).toBeVisible();
  await expect(page.getByTestId('traffic-card-requests')).toContainText(
    payload.totals.requests.toLocaleString(),
  );
  // Latency + budget cards render with their contract wording.
  await expect(page.getByTestId('traffic-card-latency')).toContainText('p50');
  await expect(page.getByTestId('traffic-card-budget')).toContainText('budget');

  // The busiest route in the SAME payload must be on the table — the top-15
  // cap never hides routes[0] and the sort is server-side (count desc).
  const busiest = payload.routes[0];
  expect(busiest, 'seed suite always produces tracked traffic').toBeTruthy();
  const table = page.getByTestId('traffic-route-table');
  await expect(table.getByRole('row').filter({ hasText: busiest.route }).first()).toBeVisible();

  // Session 138: the cache dimension is on the WIRE with exactly the four
  // pinned counters, and each strip number mirrors THIS payload (cumulative
  // since boot — absolutes are untestable, the payload↔DOM binding is).
  const cache = payload.totals.cache;
  expect(cache, 'ADMIN snapshot carries the additive cache dimension').toEqual({
    hits: expect.any(Number),
    stores: expect.any(Number),
    evictions: expect.any(Number),
    revalidations: expect.any(Number),
  });
  expect(Object.keys(cache).sort()).toEqual(
    ['evictions', 'hits', 'revalidations', 'stores'],
  );
  await expect(page.getByTestId('traffic-cache-strip')).toBeVisible();
  await expect(page.getByTestId('traffic-cache-hits')).toContainText(cache.hits.toLocaleString());
  await expect(page.getByTestId('traffic-cache-stores')).toContainText(cache.stores.toLocaleString());
  await expect(page.getByTestId('traffic-cache-evictions')).toContainText(cache.evictions.toLocaleString());
  await expect(page.getByTestId('traffic-cache-revalidations')).toContainText(
    cache.revalidations.toLocaleString(),
  );
});

test('route keys stay templated — no raw ids leak into the metrics surface', async ({ page }) => {
  await signInAsAdmin(page);

  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/admin/metrics') && res.status() === 200,
    ),
    page.goto('/admin'),
  ]);
  const payload = await response.json();
  const keys: string[] = payload.routes.map((row: { route: string }) => row.route);
  expect(keys.length).toBeGreaterThan(0);

  // uuid/numeric segments collapse, health probes are excluded by design.
  for (const key of keys) {
    expect(key).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(key).not.toContain('health');
  }

  // This test's own login POST finished (on the API) before the page even
  // navigated — its presence proves the middleware covers real authed traffic
  // with zero reliance on the racy parallel overview call.
  expect(keys.some((key) => key.includes('/api/auth/login'))).toBe(true);
});

// Session 138 (Phase 15): the cache dimension is ADMIN telemetry — the
// session-85 rule generalized to every new global totals field. The OWNER
// rung shares ONE TrafficPanel component with /admin, so the proof is on
// two levels: the scoped payload never carries the key, AND the shared
// panel renders its cards (absence is presence-gated, not a dead section).
//
// Harness note (session-99 trap): the wire body is read INSIDE a page.route
// handler via route.fetch — NOT from a response captured across the
// navigation (waitForResponse bodies are un-json-able once you navigate).
test('cache tallies stay ADMIN-only — the OWNER traffic view never carries or renders them', async ({ page }) => {
  let seen: Record<string, unknown> | null = null;
  await page.route('**/api/restaurants/*/metrics', async (route) => {
    const res = await route.fetch();
    try {
      seen = await res.json();
    } catch {
      /* leave null; the poll below fails loudly */
    }
    await route.fulfill({ response: res });
  });
  await signInUi(page, 'owner@foodorder.app', { goto: '/login' });
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto('/dashboard/analytics');
  await expect(page.getByTestId('traffic-cards')).toBeVisible();
  await expect
    .poll(() => seen, { timeout: 15000, message: 'owner metrics response never intercepted' })
    .not.toBeNull();
  const payload = seen as { scope?: string; totals?: Record<string, unknown> };
  expect(payload.scope).toBe('restaurant');
  expect(payload.totals).not.toHaveProperty('cache');
  await expect(page.getByTestId('traffic-cache-strip')).toHaveCount(0);
});
