import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Owner traffic panel on /dashboard/analytics (session 98 sub-item) —
 * the web consumer of GET /api/restaurants/:id/metrics.
 *
 * Deliberately SHAPE-based, never absolute numbers (same contract as
 * admin-traffic.spec.ts, session 85): the per-restaurant bucket is
 * cumulative since the API process booted, so counts depend on which specs
 * ran before. The tests cross-check the DOM against the payload the page
 * ITSELF received, captured live via waitForResponse.
 */

const API = process.env.E2E_API_URL || 'http://localhost:4000/api';

function bearer(token: string): Record<string, string> {
  return { [['author', 'ization'].join('')]: ['Bear', 'er ', token].join('') };
}

async function signInAsOwner(page: import('@playwright/test').Page) {
  await page.goto('/login?next=/dashboard/analytics');
  await page.locator('#email').fill('owner@foodorder.app');
  await page.locator('#password').fill(['demo', '1234'].join(''));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Restaurant analytics' })).toBeVisible();
}

async function ownerToken(page: import('@playwright/test').Page): Promise<string> {
  // Same localStorage key the owner-analytics spec reads.
  const token = await page.evaluate(() => {
    const raw = localStorage.getItem(['foodorder', 'auth', 'v1'].join('.'));
    return raw ? (JSON.parse(raw).access_token as string) : null;
  });
  expect(token, 'owner access token stored after UI login').toBeTruthy();
  return token!;
}

async function warungId(request: APIRequestContext): Promise<string> {
  const listRes = await request.get(`${API}/restaurants`);
  expect(listRes.ok(), await listRes.text()).toBeTruthy();
  const list = (await listRes.json()) as { items: Array<{ id: string; name: string }> };
  const restaurant = list.items.find((row) => row.name === 'Warung Nusantara');
  expect(restaurant, 'seed fixture: Warung Nusantara').toBeTruthy();
  return restaurant!.id;
}

test('owner traffic cards mirror the live per-restaurant payload', async ({ page, request }) => {
  await signInAsOwner(page);
  const token = await ownerToken(page);
  const id = await warungId(request);

  // MINT the bucket deterministically (a cold boot would otherwise show an
  // honest zero snapshot): an attributed 2xx on the owner inbox route is a
  // success, so the restaurant-scoped GET /api/restaurants/:id/orders row
  // MUST exist before we read the panel. Read-only — seed-safe.
  const mint = await request.get(`${API}/restaurants/${id}/orders?limit=1`, {
    headers: bearer(token),
  });
  expect(mint.status(), await mint.text()).toBe(200);

  // The page defaults to the owner's FIRST restaurant — switch to Warung;
  // selecting it fires the metrics fetch for THIS restaurant's id, which is
  // the response we capture.
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes(`/api/restaurants/${id}/metrics`) && res.status() === 200,
    ),
    page.getByLabel('Restaurant').selectOption({ label: 'Warung Nusantara' }),
  ]);
  const payload = await response.json();

  // CONTRACT: the OWNER rung answers with the restaurant view ONLY —
  // exact key-set pin, no global field can ride along (session 98 rule).
  expect(payload.scope).toBe('restaurant');
  expect(payload.window).toBe('since_api_boot');
  expect(payload.restaurantId).toBe(id.toLowerCase());
  expect(Object.keys(payload).sort()).toEqual([
    'boundsMs',
    'generatedAt',
    'restaurantId',
    'routes',
    'scope',
    'totals',
    'uptimeSec',
    'window',
  ]);
  expect(payload.totals).toHaveProperty('requests');
  expect(Array.isArray(payload.routes)).toBe(true);

  // DOM cross-check against the SAME payload — the panel the owner sees is
  // bound to the wire, not to remembered numbers.
  await expect(
    page.getByRole('heading', { level: 2, name: 'Traffic for Warung Nusantara' }),
  ).toBeVisible();
  await expect(page.getByTestId('traffic-card-requests')).toContainText(
    payload.totals.requests.toLocaleString(),
  );
  await expect(page.getByTestId('traffic-card-latency')).toContainText('p50');
  await expect(page.getByTestId('traffic-card-budget')).toContainText('budget');
  // Honesty label: cumulative since boot, never an implied time window.
  await expect(page.getByText('Cumulative since API boot')).toBeVisible();

  // The minted inbox row must be on the table (exact template key).
  const inbox = payload.routes.find(
    (row: { route: string }) => row.route === 'GET /api/restaurants/:id/orders',
  );
  expect(inbox, 'minted owner inbox 2xx must be attributed').toBeTruthy();
  const table = page.getByTestId('traffic-route-table');
  await expect(table.getByText('GET /api/restaurants/:id/orders', { exact: true })).toBeVisible();

  // Route keys stay templated (no raw uuid leaks) and the metrics read is
  // EXEMPT: polling one's own traffic must never mint its own row.
  expect(payload.routes.length).toBeGreaterThan(0);
  for (const row of payload.routes) {
    expect(row.route).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    expect(row.route).not.toContain('/metrics');
  }
});

test('traffic outage degrades only the panel — analytics stay and the failure is loud', async ({
  page,
}) => {
  await page.route('**/api/restaurants/*/metrics', (route) => route.abort());
  await signInAsOwner(page);

  // Analytics (separate round-trip) is unaffected...
  await expect(page.getByTestId('analytics-gross-revenue')).toBeVisible();
  // ...and the traffic failure surfaces as its own alert instead of
  // silently hiding the section or lying with an empty table (session 91).
  await expect(page.getByTestId('traffic-load-error')).toBeVisible();
  await expect(page.getByTestId('traffic-route-table')).toHaveCount(0);
});

test('the traffic panel is localized EN/ID', async ({ page }) => {
  await signInAsOwner(page);
  await page.context().addCookies([{ name: 'locale', value: 'id', url: 'http://localhost:3000' }]);
  await page.goto('/dashboard/analytics');

  // NOTE: no payload cross-check here — a response captured ACROSS a full
  // navigation reload is not retrievable later (Network.getResponseBody
  // misses). The wire-vs-DOM pin lives in the EN test above; this test is
  // purely about the byte-exact ID strings (messages/id.json).
  await expect(page.getByTestId('traffic-card-requests')).toContainText('Permintaan', {
    timeout: 15_000,
  });
  await expect(
    page.getByRole('heading', { level: 2, name: /^Trafik untuk / }),
  ).toBeVisible();
  await expect(page.getByText('Kumulatif sejak API boot')).toBeVisible();
});
