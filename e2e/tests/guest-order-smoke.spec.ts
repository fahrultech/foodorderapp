import { expect, test, type Page } from '@playwright/test';

/**
 * The roadmap smoke flow end to end, as a guest:
 * browse home -> search -> restaurant detail -> menu search -> add dishes
 * -> cart (qty stepper) -> checkout (live fee + WARUNGHEMAT promo) -> place
 * order -> order confirmation page -> cart emptied.
 *
 * Every assertion is against SEED-fixed values (apps/api/src/database/seed.ts):
 * Warung Nusantara: fee $3.00, min $10.00, 5 dishes —
 *   Nasi Goreng Spesial $18.00, Es Teh Manis $5.00.
 *   Displayed rating is 4.0 · 2 reviews (the 4.8 column default is recomputed
 *   server-side by the seeded FO-SEED8/9 reviews (5★ + 3★) during `npm run seed`).
 * WARUNGHEMAT: $5 off, min subtotal $30.00, Warung only.
 * Math: 2 x 1800 + 500 = 4100 -> promo -500 + fee 300 = 3900 ($39.00).
 * If a test fails, check the seed BEFORE the UI — these numbers are the
 * contract between seed data and this suite.
 */

/** Add a dish (by its <h3> name) to the cart from the restaurant page. */
async function addDish(page: Page, name: string) {
  const row = page
    .locator('div.divide-y > div', { has: page.getByRole('heading', { level: 3, name }) })
    .first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Add', exact: true }).click();
}

test('guest browses, orders, and lands on the confirmation page', async ({ page }) => {
  // --- Home: SSR list from the live API ---
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Order from local restaurants' }),
  ).toBeVisible();
  const warungCard = page.getByRole('link', { name: /Warung Nusantara/ }).first();
  await expect(warungCard).toBeVisible();
  await expect(page.getByRole('link', { name: /Seoul Street/ }).first()).toBeVisible();

  // --- Global search filters the SSR list ---
  await page.getByPlaceholder('Search restaurants or dishes…').fill('seoul');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/\/\?q=seoul/);
  await expect(page.getByRole('link', { name: /Seoul Street/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Warung Nusantara/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Clear ✕' }).click();
  await expect(warungCard).toBeVisible();

  // --- Restaurant detail: header facts come from the seeded row ---
  await warungCard.click();
  await expect(page).toHaveURL(/\/restaurants\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Warung Nusantara' })).toBeVisible();
  await expect(page.getByText('★ 4.0 · 2 reviews')).toBeVisible();
  await expect(page.getByText('$3.00 delivery')).toBeVisible();
  await expect(page.getByText('Min order $10.00')).toBeVisible();

  // --- Menu search within the restaurant (client-side) ---
  const menuSearch = page.locator('#menu-search');
  await menuSearch.fill('rendang');
  await expect(page.getByText(/1 of 5 dishes match/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: 'Rendang Daging' })).toBeVisible();
  await menuSearch.press('Escape');
  await expect(page.getByText('5 dishes')).toBeVisible();

  // --- Add dishes; the header badge counts units ---
  const badge = page.locator('header a[href="/cart"] span');
  await addDish(page, 'Nasi Goreng Spesial');
  await expect(badge).toHaveText('1');
  await addDish(page, 'Es Teh Manis');
  await expect(badge).toHaveText('2');

  // --- Cart: stepper raises Nasi Goreng to 2 -> subtotal 2*18.00 + 5.00 ---
  await page.getByRole('link', { name: /Cart/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your cart' })).toBeVisible();
  await expect(page.getByText('From Warung Nusantara')).toBeVisible();
  const nasiLine = page
    .locator('div.divide-y > div', { has: page.getByText('Nasi Goreng Spesial') })
    .first();
  await nasiLine.getByRole('button', { name: 'Increase quantity' }).click();
  await expect(badge).toHaveText('3');
  await expect(nasiLine.getByText('$36.00')).toBeVisible();
  await expect(page.getByText('Subtotal').locator('..').getByText('$41.00')).toBeVisible();

  // --- Checkout: live server fee, then the promo engine via its UI ---
  await page.getByRole('link', { name: /Checkout/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeVisible();
  await expect(page.getByText('2 × Nasi Goreng Spesial')).toBeVisible();
  await expect(page.getByText('1 × Es Teh Manis')).toBeVisible();
  await expect(page.getByTestId('checkout-delivery')).toHaveText('$3.00');
  await expect(page.getByTestId('checkout-total')).toHaveText('$44.00');

  await page.getByTestId('checkout-promo-input').fill('WARUNGHEMAT');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByTestId('checkout-promo')).toHaveText('-$5.00');
  await expect(page.getByTestId('checkout-total')).toHaveText('$39.00');
  await expect(page.getByRole('button', { name: /Place order — \$39\.00/ })).toBeEnabled();

  // --- Place the order (guest: server prices from its own cart) ---
  await page.getByPlaceholder('Jane Doe').fill('E2E Tester');
  await page.getByPlaceholder('+62 812 3456 7890').fill('+62 812 0000 1234');
  await page.getByPlaceholder('Street, number, city, landmarks…').fill('1 Test Street, Jakarta');
  await page.getByPlaceholder('e.g. no chili, gate code 1234').fill('extra kerupuk');
  await page.getByRole('button', { name: /Place order — \$39\.00/ }).click();

  // --- Order confirmation page ---
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}\?code=FO-/);
  await expect(page.getByRole('heading', { level: 1, name: /Order FO-[A-Z0-9]+ placed!/ })).toBeVisible();
  await expect(page.getByText('🕐 Pending — waiting for the restaurant to confirm')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Order progress' })).toBeVisible();
  await expect(page.getByText('Order sent to the restaurant')).toBeVisible();
  await expect(page.getByText('2 × Nasi Goreng Spesial')).toBeVisible();
  await expect(page.getByText('1 × Es Teh Manis')).toBeVisible();
  await expect(page.getByText('Promo (WARUNGHEMAT)')).toBeVisible();
  await expect(page.getByText('-$5.00')).toBeVisible();
  await expect(page.getByText('Delivering to:').locator('..')).toContainText('1 Test Street, Jakarta');
  await expect(page.getByText('E2E Tester · +62 812 0000 1234')).toBeVisible();

  // --- Cart was cleared by the successful submit ---
  await page.goto('/cart');
  await expect(page.getByRole('heading', { level: 1, name: 'Your cart is empty' })).toBeVisible();
});
