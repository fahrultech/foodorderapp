import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 5 "web pay button" (session 43): the order receipt page offers
 * Pay (POST /payments intent -> POST /payments/:id/capture, mock settles
 * synchronously) and the receipt reflects payment status from
 * GET /orders/:id/payments — including after a reload, proving the paid
 * state is server truth, not component-local.
 *
 * Seed-fixed values (apps/api/src/database/seed.ts):
 *   Warung Nusantara — Nasi Goreng Spesial $18.00, fee $3.00, min $10.00.
 *   One Nasi Goreng => total $21.00. Demo login: demo@foodorder.app.
 * Checkout orders are GUEST-owned (the order POST carries no token), which
 * is the API's documented "payable by any signed-in payer" branch — so the
 * demo account can pay its own just-placed guest order.
 */

async function addOneNasiGoreng(page: Page) {
  await page.goto('/restaurants');
  await page.goto('/');
  await page.getByRole('link', { name: /Warung Nusantara/ }).first().click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Warung Nusantara' }),
  ).toBeVisible();
  const row = page
    .locator('div.divide-y > div', {
      has: page.getByRole('heading', { level: 3, name: 'Nasi Goreng Spesial' }),
    })
    .first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Add', exact: true }).click();
}

async function fillCheckoutAndSubmit(page: Page) {
  await page.getByRole('link', { name: /Checkout/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeVisible();
  await expect(page.getByTestId('checkout-delivery')).toHaveText('$3.00');
  await expect(page.getByTestId('checkout-total')).toHaveText('$21.00');
  await page.getByPlaceholder('Jane Doe').fill('Pay E2E');
  await page.getByPlaceholder('+62 812 3456 7890').fill('+62 812 0000 9999');
  await page.getByPlaceholder('Street, number, city, landmarks…').fill('9 Payment Lane, Jakarta');
  await page.getByRole('button', { name: /Place order — \$21\.00/ }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}\?code=FO-/);
}

test('signed-in customer pays at checkout and the receipt stays paid after reload', async ({
  page,
}) => {
  await test.step('log in as the demo customer', async () => {
    await page.goto('/login');
    await page.locator('#email').fill('demo@foodorder.app');
    await page.locator('#password').fill('demo1234');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Demo Customer')).toBeVisible();
  });

  await addOneNasiGoreng(page);
  await page.getByRole('link', { name: /Cart/ }).click();
  await fillCheckoutAndSubmit(page);

  await test.step('checkout hands over with ?pay=1 and the elevated pay card', async () => {
    await expect(page).toHaveURL(/&pay=1/);
    await expect(page.getByTestId('payment-panel')).toBeVisible();
    await expect(page.getByTestId('payment-unpaid')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Payment' })).toBeVisible();
  });

  await test.step('one click: intent + capture -> paid receipt', async () => {
    await expect(page.getByTestId('pay-button')).toHaveText('Pay $21.00');
    await page.getByTestId('pay-button').click();
    await expect(page.getByTestId('payment-paid')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('payment-paid')).toContainText('Paid — $21.00 via mock');
    await expect(page.getByTestId('pay-button')).toHaveCount(0);
  });

  await test.step('reload proves the paid state comes from GET /orders/:id/payments', async () => {
    await page.reload();
    await expect(page.getByTestId('payment-paid')).toBeVisible();
    await expect(page.getByTestId('pay-button')).toHaveCount(0);
  });
});

test('guest receipt shows the sign-in hint instead of a dead pay button', async ({ page }) => {
  await addOneNasiGoreng(page);
  await page.getByRole('link', { name: /Cart/ }).click();
  await fillCheckoutAndSubmit(page);

  // No session -> no payment endpoints -> the panel must say so and offer
  // the sign-in path (guest orders are payable by any signed-in account).
  await expect(page).not.toHaveURL(/pay=1/);
  await expect(page.getByTestId('payment-panel')).toBeVisible();
  await expect(page.getByTestId('payment-signin-hint')).toBeVisible();
  await expect(
    page.getByTestId('payment-signin-hint').getByRole('link', { name: 'Sign in' }),
  ).toBeVisible();
  await expect(page.getByTestId('pay-button')).toHaveCount(0);
});
