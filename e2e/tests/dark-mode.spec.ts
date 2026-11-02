import { expect, test } from '@playwright/test';

test('dark mode is accessible, applies to the storefront, and persists', async ({ page }) => {
  await page.goto('/');

  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: 'Use dark theme' })).toBeVisible();

  await page.getByRole('button', { name: 'Use dark theme' }).click();

  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Use light theme' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe('rgb(28, 25, 23)');

  const firstRestaurant = page.getByRole('link', { name: /Warung Nusantara/ }).first();
  await expect
    .poll(() => firstRestaurant.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe('rgb(41, 37, 36)');

  await firstRestaurant.click();
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await page.getByRole('button', { name: 'Use light theme' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe('rgb(250, 250, 249)');
});
