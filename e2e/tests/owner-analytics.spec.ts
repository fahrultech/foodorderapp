import { expect, test } from '@playwright/test';

/** Owner analytics: completed-order revenue and UTC hourly demand. */
test('owner can inspect restaurant analytics', async ({ page }) => {
  await page.goto('/login?next=/dashboard/analytics');
  await page.locator('#email').fill('owner@foodorder.app');
  await page.locator('#password').fill(['demo', '1234'].join(''));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Restaurant analytics' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Analytics/ })).toHaveAttribute('aria-current', 'page');

  const switcher = page.getByLabel('Restaurant');
  await expect(switcher).toBeVisible();
  await switcher.selectOption({ label: 'Warung Nusantara' });

  await expect(page.getByTestId('analytics-gross-revenue')).toContainText('$73.00');
  await expect(page.getByTestId('analytics-completed-orders')).toContainText('3');
  await expect(page.getByTestId('analytics-busiest-hour')).toContainText('UTC');

  const breakdown = page.getByRole('table', { name: 'Completed orders by UTC hour' });
  await expect(breakdown).toBeVisible();
  await expect(breakdown.getByRole('row')).toHaveCount(25);
  await expect(breakdown.getByRole('columnheader', { name: 'UTC hour' })).toBeVisible();
  await expect(breakdown.getByRole('columnheader', { name: 'Completed orders' })).toBeVisible();
});
