import { expect, Page, test } from '@playwright/test';

/**
 * Session 91 — kitchen display + driver inbox states audit (the portal
 * half of the session-77 doctrine):
 *  - a FAILED load never renders the empty state over missing data;
 *  - API-down answers the localized offline card (`api-offline` parity
 *    with the storefront), other failures a plain retry card;
 *  - the zero-order kitchen board says "all clear" instead of three
 *    disconnected dashed boxes;
 *  - the new state furniture is EN/ID localized like the storefront.
 *
 * Read-only by design: everything is proven with `page.route`
 * interception, so no test mutates the seeded state the later
 * `zz-driver-portal` spec consumes (FO-SEED3 stays untouched).
 */

const DEMO_PASSWORD = 'demo' + '1234';

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Suite contract (account.spec): bare /login lands on '/' once signed in.
  await expect(page).not.toHaveURL(/\/login/);
}

function ordersPage() {
  return JSON.stringify({ items: [], total: 0, page: 1, limit: 50 });
}

function restaurantOrdersPage() {
  return JSON.stringify({
    items: [],
    total: 0,
    page: 1,
    limit: 50,
    counts: {
      pending: 0,
      confirmed: 0,
      preparing: 0,
      delivering: 0,
      completed: 0,
      cancelled: 0,
    },
  });
}

test('driver inbox: a dead API answers the offline card, NEVER the "No deliveries assigned" empty state', async ({
  page,
}) => {
  await signIn(page, 'driver@foodorder.app');
  await page.route('**/api/driver/orders**', (route) => route.abort());
  await page.goto('/driver');

  await expect(page.getByTestId('api-offline')).toBeVisible();
  await expect(page.getByTestId('driver-empty')).toHaveCount(0);
  // The offline body names the server, not the driver's schedule.
  await expect(page.getByTestId('api-offline')).toContainText(/FoodOrder API/i);

  // Release the route and retry in-page: the real seeded inbox returns.
  await page.unroute('**/api/driver/orders**');
  await page.getByTestId('api-offline').getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('api-offline')).toHaveCount(0);
  await expect(page.getByTestId('driver-order-FO-SEED3')).toBeVisible();
});

test('driver inbox: a 4xx failure is a plain retry card, not the offline card', async ({
  page,
}) => {
  await signIn(page, 'driver@foodorder.app');
  await page.route('**/api/driver/orders**', (route) =>
    route.fulfill({
      status: 418,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'TEAPOT', message: 'no deliveries for you', details: null } }),
    }),
  );
  await page.goto('/driver');

  await expect(page.getByTestId('portal-load-failed')).toBeVisible();
  await expect(page.getByTestId('api-offline')).toHaveCount(0);
  await expect(page.getByTestId('driver-empty')).toHaveCount(0);
  await expect(page.getByTestId('portal-load-failed')).toContainText('no deliveries for you');
  await page.unroute('**/api/driver/orders**');
});

test('driver inbox: an EMPTY load is honestly the localized empty card', async ({ page }) => {
  await signIn(page, 'driver@foodorder.app');
  await page.route('**/api/driver/orders**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: ordersPage() }),
  );
  await page.goto('/driver');

  await expect(page.getByTestId('driver-empty')).toBeVisible();
  await expect(page.getByTestId('driver-empty')).toContainText('No deliveries assigned');
  await expect(page.getByTestId('api-offline')).toHaveCount(0);
  await expect(page.getByTestId('portal-load-failed')).toHaveCount(0);
  await page.unroute('**/api/driver/orders**');
});

test('kitchen board: an all-quiet restaurant shows ONE all-clear banner + per-lane quiet', async ({
  page,
}) => {
  await signIn(page, 'owner@foodorder.app');
  await page.route('**/api/restaurants/*/orders**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: restaurantOrdersPage(),
    }),
  );
  await page.goto('/dashboard/kitchen');

  await expect(page.getByTestId('kitchen-board-empty')).toBeVisible();
  await expect(page.getByTestId('kitchen-board-empty')).toContainText('All clear');
  for (const lane of ['confirmed', 'preparing', 'delivering']) {
    await expect(page.getByTestId(`kitchen-lane-empty-${lane}`)).toBeVisible();
  }
  await page.unroute('**/api/restaurants/*/orders**');
});

test('kitchen board: a failed orders load replaces the lanes with the failure card', async ({
  page,
}) => {
  await signIn(page, 'owner@foodorder.app');
  await page.route('**/api/restaurants/*/orders**', (route) =>
    route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'UPSTREAM', message: 'bad gateway', details: null } }),
    }),
  );
  await page.goto('/dashboard/kitchen');

  // 5xx is DOWNNESS: the offline card answers, and no lane may claim quiet.
  await expect(page.getByTestId('api-offline')).toBeVisible();
  await expect(page.getByTestId('kitchen-board')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-board-empty')).toHaveCount(0);

  // Release + retry: the real seeded board comes back.
  await page.unroute('**/api/restaurants/*/orders**');
  await page.getByTestId('api-offline').getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('kitchen-board')).toBeVisible();
});

test('kitchen board: a dead restaurant LIST load also answers the offline card, not three empty lanes', async ({
  page,
}) => {
  await signIn(page, 'owner@foodorder.app');
  await page.route('**/api/restaurants/mine**', (route) => route.abort());
  await page.goto('/dashboard/kitchen');

  await expect(page.getByTestId('api-offline')).toBeVisible();
  await expect(page.getByTestId('kitchen-board')).toHaveCount(0);
  await expect(page.getByTestId('kitchen-no-restaurant')).toHaveCount(0);

  await page.unroute('**/api/restaurants/mine**');
  await page.getByTestId('api-offline').getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('kitchen-board')).toBeVisible();
});

test('portal states follow the storefront locale (Indonesian offline + empty cards)', async ({
  page,
}) => {
  // Sign in first (the login page is English chrome), then flip the
  // httpOnly `locale` cookie the SSR/next-intl config reads.
  await signIn(page, 'driver@foodorder.app');
  await page.context().addCookies([
    {
      name: 'locale',
      value: 'id',
      url: process.env.E2E_WEB_URL || 'http://localhost:3000',
    },
  ]);

  await page.route('**/api/driver/orders**', (route) => route.abort());
  await page.goto('/driver');
  await expect(page.getByTestId('api-offline')).toContainText('Server kami sedang tidak dapat dijangkau');
  await page.unroute('**/api/driver/orders**');

  // Empty inbox localized too.
  await page.route('**/api/driver/orders**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: ordersPage() }),
  );
  await page.goto('/driver');
  await expect(page.getByTestId('driver-empty')).toContainText('Belum ada pengiriman yang ditugaskan');
  await page.unroute('**/api/driver/orders**');
});
