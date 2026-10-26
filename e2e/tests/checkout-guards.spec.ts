import { expect, test } from '@playwright/test';

/**
 * Checkout guardrails + empty states. Seed-fixed: Seoul Street has
 * deliveryFee $3.50 / min order $10.00 and Bungeoppang at $6.00 (Snacks).
 */

test('below-minimum cart blocks the submit button with a real gap amount', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /Seoul Street/ }).first().click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Seoul Street' }),
  ).toBeVisible();

  const row = page
    .locator('div.divide-y > div', { has: page.getByRole('heading', { level: 3, name: 'Bungeoppang' }) })
    .first();
  await row.getByRole('button', { name: 'Add', exact: true }).click();

  await page.getByRole('link', { name: /Cart/ }).click();
  await expect(page.getByText('From Seoul Street')).toBeVisible();
  await expect(page.getByText('Bungeoppang')).toBeVisible();
  await page.getByRole('link', { name: /Checkout/ }).click();

  // Client preview mirrors the server rule: fee loaded, minimum not met.
  await expect(page.getByTestId('checkout-delivery')).toHaveText('$3.50');
  const alert = page.getByRole('alert').filter({ hasText: 'minimum order' });
  await expect(alert).toContainText('has a minimum order of $10.00. Add $4.00 more');
  const submit = page.getByRole('button', { name: 'Below minimum order' });
  await expect(submit).toBeDisabled();
});

test('empty cart and empty checkout render their guard states', async ({ page }) => {
  await page.goto('/cart');
  await expect(page.getByRole('heading', { level: 1, name: 'Your cart is empty' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Find food' })).toBeVisible();

  await page.goto('/checkout');
  await expect(page.getByRole('heading', { level: 1, name: 'Nothing to check out' })).toBeVisible();
});
