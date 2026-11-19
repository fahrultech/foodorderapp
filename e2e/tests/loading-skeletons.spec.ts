import { expect, Page, test } from '@playwright/test';

/**
 * Session 105 — loading/skeleton pass on /favorites + /addresses (Phase 9
 * UX item). Both pages already gated their empty cards on `loaded`, but the
 * audit found three honest gaps this suite now pins:
 *  - a slow or failing load must paint the skeleton (stable testids, the
 *    established animate-pulse idiom) and never a mid-flight empty card;
 *  - the addresses page rendered "No saved addresses yet" even when the
 *    load FAILED (unlike favorites, the empty card did not check
 *    `loadError` — the session-77/91 error-vs-empty doctrine violated);
 *  - the addresses error banner had no retry affordance; it now carries a
 *    localized Try again (Common.retry, EN/ID already shipped).
 *
 * All row/state assertions run on fully intercepted payloads, so the tests
 * are read-only and seed-safe; only the final step of the retry test hits
 * the real API, asserting honest endings (no error card, no skeleton, never
 * an "Add address" control over an unloaded list).
 */

const DEMO_PASSWORD = ['demo', '1234'].join('');
const FAV_ROUTES = '**/api/users/me/favorites';
const ADDR_ROUTES = '**/api/users/me/addresses';

// Synthetic uuids the seed never creates (well-formed, so the API's own
// 404 is what an unintercepted read would answer — the intercept covers
// every favorites/addresses read these tests make).
const DISH_A = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const DISH_B = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const REST_WARUNG = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';
const ADDR_HOME = '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d';
const ADDR_WORK = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';
const USER_ID = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

function favDish(id: string, name: string, priceCents: number, available: boolean) {
  return {
    menuItemId: id,
    name,
    description: `Synthetic ${name} row (session 105 loading pass).`,
    priceCents,
    category: 'Mains',
    imageUrl: null,
    isAvailable: available,
    prepMinutes: 10,
    restaurantId: REST_WARUNG,
    stock: null,
    restaurantName: 'Warung Nusantara',
    restaurantSlug: 'warung-nusantara',
    restaurantIsOpen: true,
    favoritedAt: '2026-11-05T10:00:00.000Z',
  };
}

function favPayload() {
  return JSON.stringify({
    items: [
      favDish(DISH_A, 'Rendang Loading Pass', 18500, true),
      favDish(DISH_B, 'Gado-Gado Holdup', 12000, false),
    ],
    total: 2,
  });
}

function addrPayload() {
  const base = {
    userId: USER_ID,
    recipientName: 'Loading Tester',
    phone: '+62 812 3456 7890',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
  };
  return JSON.stringify({
    items: [
      { ...base, id: ADDR_HOME, label: 'Home (skeleton pass)', address: 'Jl. Sangsaka 45, Jakarta', isDefault: true },
      { ...base, id: ADDR_WORK, label: 'Work (skeleton pass)', address: 'SCBD Lot 12, Jakarta', isDefault: false },
    ],
    total: 2,
  });
}

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Redirect-COMMIT contract (session 100): never navigate on click-time only.
  await expect(page).not.toHaveURL(/\/login/);
}

async function routeDelayed(page: Page, pattern: string, body: string, delayMs: number) {
  await page.route(pattern, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({ status: 200, contentType: 'application/json', body });
  });
}

test('favorites: a slow load paints the animated skeleton — never the empty card — then the rows', async ({
  page,
}) => {
  await signIn(page, 'demo@foodorder.app');
  await routeDelayed(page, FAV_ROUTES, favPayload(), 900);
  await page.goto('/favorites');

  // During the in-flight window: skeleton only. No empty card, no error.
  const skeleton = page.getByTestId('favorites-skeleton');
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveCount(1); // the 3 pulse rows live inside ONE list
  await expect(skeleton).toHaveAttribute('aria-busy', 'true');
  await expect(skeleton).toHaveAttribute('aria-label', 'Loading saved dishes');
  await expect(page.getByText(/Nothing saved/)).toHaveCount(0);
  await expect(page.getByTestId('favorites-error')).toHaveCount(0);

  // After the payload lands: real rows replace the skeleton.
  await expect(page.getByRole('heading', { name: 'Rendang Loading Pass' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Gado-Gado Holdup' })).toBeVisible();
  await expect(skeleton).toHaveCount(0);
  // The available row exposes its Add button (name per mobile-cart spec's
  // /^Add( |$)/ idiom); the sold-out twin keeps its disabled Add hidden
  // behind the unavailable note — one actionable Add in the payload.
  await expect(page.getByRole('button', { name: /^Add( |$)/ })).toHaveCount(1);
});

test('addresses: a slow load paints the animated skeleton — never the empty card — then the rows', async ({
  page,
}) => {
  await signIn(page, 'demo@foodorder.app');
  await routeDelayed(page, ADDR_ROUTES, addrPayload(), 900);
  await page.goto('/addresses');

  const skeleton = page.getByTestId('addresses-skeleton');
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveAttribute('aria-busy', 'true');
  await expect(skeleton).toHaveAttribute('aria-label', 'Loading addresses');
  await expect(page.getByText('No saved addresses yet.')).toHaveCount(0);
  await expect(page.getByTestId('addresses-error')).toHaveCount(0);

  await expect(page.getByRole('heading', { name: 'Home (skeleton pass)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Work (skeleton pass)' })).toBeVisible();
  await expect(skeleton).toHaveCount(0);
});

test('addresses: a failed load answers the retry card, NEVER the "No saved addresses" empty state', async ({
  page,
}) => {
  await signIn(page, 'demo@foodorder.app');
  await page.route(ADDR_ROUTES, (route) => route.abort());
  await page.goto('/addresses');

  await expect(page.getByTestId('addresses-error')).toBeVisible();
  await expect(page.getByTestId('addresses-error')).toContainText('Cannot reach the API');
  // THE BUG PIN: pre-session-105 the empty card rendered over this failure.
  await expect(page.getByText('No saved addresses yet.')).toHaveCount(0);

  // Retry releases the interception; the honest ending is "loaded": no
  // error card, no skeleton, and no Add control while zero rows are shown.
  await page.unroute(ADDR_ROUTES);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByTestId('addresses-error')).toHaveCount(0);
  await expect(page.getByTestId('addresses-skeleton')).toHaveCount(0);
  if ((await page.getByText('No saved addresses yet.').count()) > 0) {
    await expect(page.getByRole('button', { name: 'Add address', exact: true })).toHaveCount(0);
  } else {
    await expect(page.getByRole('button', { name: 'Add address', exact: true })).toHaveCount(1);
  }
});

test('favorites: a failed load answers the retry card, NEVER the "Nothing saved" empty state', async ({
  page,
}) => {
  await signIn(page, 'demo@foodorder.app');
  await page.route(FAV_ROUTES, (route) => route.abort());
  await page.goto('/favorites');

  await expect(page.getByTestId('favorites-error')).toBeVisible();
  await expect(page.getByTestId('favorites-error')).toContainText('Cannot reach the API');
  await expect(page.getByText(/Nothing saved/)).toHaveCount(0);
  await expect(page.getByText('Rendang')).not.toBeVisible(); // honest: no phantom rows either

  await page.unroute(FAV_ROUTES);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  // Honest ending: the load succeeded, so error and skeleton are gone;
  // the page then shows either the real rows or the honest empty card.
  await expect(page.getByTestId('favorites-error')).toHaveCount(0);
  await expect(page.getByTestId('favorites-skeleton')).toHaveCount(0);
});