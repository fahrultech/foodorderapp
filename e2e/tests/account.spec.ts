import { expect, test } from '@playwright/test';

/**
 * Signed-in smoke: the demo seed account logs in, the header switches to the
 * authenticated nav, and /orders/my lists its seeded history (FO-SEED* are
 * created for demoCustomer by apps/api/src/database/seed.ts).
 */

test('demo user signs in and sees their order history', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await page.locator('#email').fill('demo@foodorder.app');
  await page.locator('#password').fill('demo1234');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // Login redirects to '/' (no ?next was set); header switches to signed-in nav.
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByText('Demo Customer')).toBeVisible();
  await expect(page.getByRole('link', { name: 'My orders' })).toBeVisible();

  await page.getByRole('link', { name: 'My orders' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My orders' })).toBeVisible();
  await expect(page.locator('[data-testid^="order-card-FO-SEED"]').first()).toBeVisible();
});
