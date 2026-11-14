import { expect, test } from '@playwright/test';

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
  await page.goto('/login');
  await page.locator('#email').fill('admin@foodorder.app');
  await page.locator('#password').fill(['demo', '1234'].join(''));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Admin' })).toBeVisible();
  // Session 93: let the post-login '/' redirect commit before clicking (see
  // admin.spec.ts for the A/B-quantified race this guard removes).
  await expect(page).not.toHaveURL(/\/login/);
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
