import { expect, test } from '@playwright/test';

/**
 * Phase 6 storefront states audit: dead links and a dead API must answer
 * DIFFERENTLY (404 vs offline card), a no-results search must name the
 * active filters and offer a way out, and a failed favorites load must
 * show why instead of lying "Nothing saved yet".
 *
 * Scope note: browser-level `page.route` only intercepts CLIENT-side
 * fetches — the SSR pages (home/restaurant) fetch inside the Next server,
 * so their offline branches are proven by curl smokes (see DEVLOG), not
 * here. These tests cover the surfaces the browser itself requests.
 */

// Well-formed uuid the seed never creates -> the API's own 404, not a
// ParseUUIDPipe 400. Both must render the not-found page, this pins the
// API-answered half of the split.
const UNKNOWN_UUID = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

test('dead restaurant link answers 404 — not the offline card', async ({ page }) => {
  const res = await page.goto(`/restaurants/${UNKNOWN_UUID}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId('api-offline')).toHaveCount(0);
  await expect(page.getByText(/could not be found/i)).toBeVisible();
});

test('home search with no results names the query and offers a clear-filters escape', async ({
  page,
}) => {
  await page.goto('/?q=zzznotathing');
  await expect(page.getByText('No matches')).toBeVisible();
  await expect(page.getByText(/zzznotathing/)).toBeVisible();
  await page.getByRole('link', { name: /Clear search & filters/ }).click();
  await expect(page).toHaveURL(/\/$/);
  // Escape hatch actually escapes: the seeded grid is back.
  await expect(page.getByText('Warung Nusantara')).toBeVisible();
});

test('favorites shows a failure card with retry instead of lying "Nothing saved"', async ({
  page,
}) => {
  await page.goto('/login');
  await page.locator('#email').fill('demo@foodorder.app');
  await page.locator('#password').fill(['demo', '1234'].join(''));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Suite contract (account.spec): bare /login lands on '/' once signed in.
  await expect(page).not.toHaveURL(/\/login/);

  // Kill the browser-side favorites fetch, then hard-navigate so the
  // app-wide FavoritesProvider re-boots and its load fails for real.
  await page.route('**/api/users/me/favorites', (route) => route.abort());
  await page.goto('/favorites');

  await expect(page.getByTestId('favorites-error')).toBeVisible();
  await expect(page.getByTestId('favorites-error')).toContainText('Cannot reach the API');
  await expect(page.getByText(/Nothing saved/)).toHaveCount(0);

  // Retry with the route released brings the real list (or empty card) back.
  await page.unroute('**/api/users/me/favorites');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('favorites-error')).toHaveCount(0);
});
