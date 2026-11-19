import { expect, test } from '@playwright/test';
import { signInUi } from '../helpers/fixtures';

/** Read-only admin oversight: role-gated nav plus users/restaurants/orders data. */
test('admin can open the platform overview', async ({ page }) => {
  await signInUi(page, 'admin@foodorder.app', { goto: '/login' });

  await expect(page.getByRole('link', { name: 'Admin' })).toBeVisible();
  // Session-93 race note, now structural: signInUi only returns once the
  // post-login redirect has COMMITTED (session 100/106 contract).
  await page.getByRole('link', { name: 'Admin' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Admin overview' })).toBeVisible();
  await expect(page.getByTestId('admin-count-users')).toContainText('4');
  await expect(page.getByTestId('admin-count-users')).toContainText('1 drivers');
  await expect(page.getByTestId('admin-count-restaurants')).toContainText('6');
  await expect(page.getByTestId('admin-count-orders')).toContainText('10');
  await expect(page.getByRole('heading', { level: 2, name: 'Recent users' })).toBeVisible();
  await expect(page.getByText('admin@foodorder.app')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Recent restaurants' })).toBeVisible();
  await expect(page.getByText('Warung Nusantara', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Recent orders' })).toBeVisible();
  await expect(page.getByText(/FO-SEED/).first()).toBeVisible();
});

test('non-admin accounts do not get an admin navigation entry', async ({ page }) => {
  await signInUi(page, 'owner@foodorder.app', { goto: '/login' });

  await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: 'Admin access required' })).toBeVisible();
});
