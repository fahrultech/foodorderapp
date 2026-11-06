import { expect, test, type Page } from '@playwright/test';

/**
 * Menu options/variants on the storefront (Phase 5, session 66): the dish
 * rows of GET /restaurants/:id now embed optionGroups, the cart keeps one
 * line per dish+selection, and the chosen ids ride to checkout where the
 * SERVER re-prices (the UI math below must match it exactly).
 *
 * Seed-fixed contract (apps/api/src/database/seed.ts):
 *   Es Teh Manis $5.00 — Size group (max 1, optional):
 *     Regular +$0.00 · Large +$2.00 · Jumbo +$3.50
 *   Nasi Goreng Spesial $18.00 — Add-ons group (max 3, optional):
 *     Extra egg +$2.00 · Chicken satay (3 pcs) +$5.00 · Fried shallots +$1.50
 *   Warung Nusantara: fee $3.00, min $10.00.
 */

async function openWarungMenu(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: /Warung Nusantara/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Warung Nusantara' })).toBeVisible();
}

function dishRow(page: Page, name: string) {
  return page
    .locator('div.divide-y > div', { has: page.getByRole('heading', { level: 3, name }) })
    .first();
}

test('cart lines per selection flow through checkout onto the receipt', async ({ page }) => {
  await openWarungMenu(page);

  // --- Es Teh with Size: Large (+$2.00) ---
  const tehRow = dishRow(page, 'Es Teh Manis');
  await expect(tehRow.getByRole('button', { name: /Large/ })).toBeVisible();
  await tehRow.getByRole('button', { name: /Large/ }).click();
  await expect(tehRow.getByRole('button', { name: /Large/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(tehRow.getByTestId('options-unit-price')).toHaveText('Unit price: $7.00');
  await tehRow.getByRole('button', { name: 'Add', exact: true }).click();

  // --- Same dish, different selection: Jumbo (+$3.50) becomes a SECOND line ---
  // After the first add the button carries the in-cart count — the label is
  // "Add (1 in cart)" for this dish from now on.
  await tehRow.getByRole('button', { name: /Jumbo/ }).click();
  await expect(tehRow.getByRole('button', { name: /Jumbo/ })).toHaveAttribute('aria-pressed', 'true');
  await tehRow.getByRole('button', { name: 'Add (1 in cart)' }).click();

  // --- Nasi Goreng with two add-ons: Extra egg (+$2.00) + satay (+$5.00) ---
  const nasiRow = dishRow(page, 'Nasi Goreng Spesial');
  await nasiRow.getByRole('button', { name: /Extra egg/ }).click();
  await nasiRow.getByRole('button', { name: /satay/ }).click();
  await expect(nasiRow.getByTestId('options-unit-price')).toHaveText('Unit price: $25.00');
  await nasiRow.getByRole('button', { name: 'Add', exact: true }).click();

  // Badge counts units across all three lines.
  await expect(page.locator('header a[href="/cart"] span')).toHaveText('3');

  // --- Cart: three lines, per-line option rows, server-matching totals ---
  await page.getByRole('link', { name: /Cart/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your cart' })).toBeVisible();
  const largeLine = page
    .locator('div.divide-y > div', { has: page.getByText('Size: Large') })
    .first();
  const jumboLine = page
    .locator('div.divide-y > div', { has: page.getByText('Size: Jumbo') })
    .first();
  const extrasLine = page
    .locator('div.divide-y > div', { has: page.getByText('Add-ons: Extra egg, Chicken satay (3 pcs)') })
    .first();
  await expect(largeLine).toBeVisible();
  await expect(largeLine.getByText('$7.00 each')).toBeVisible();
  await expect(jumboLine.getByText('$8.50 each')).toBeVisible();
  await expect(extrasLine.getByText('$25.00 each')).toBeVisible();
  await expect(page.getByText('Subtotal').locator('..').getByText('$40.50')).toBeVisible();

  // --- Checkout: option rows echo; fee $3.00 -> total $43.50 ---
  await page.getByRole('link', { name: /Checkout/ }).click();
  // Both Es Teh lines (Large + Jumbo) render under the same dish name.
  await expect(page.getByText('1 × Es Teh Manis')).toHaveCount(2);
  await expect(page.getByText('Size: Large')).toBeVisible();
  await expect(page.getByText('Add-ons: Extra egg, Chicken satay (3 pcs)')).toBeVisible();
  await expect(page.getByTestId('checkout-delivery')).toHaveText('$3.00');
  await expect(page.getByTestId('checkout-total')).toHaveText('$43.50');
  await page.getByPlaceholder('Jane Doe').fill('Options E2E');
  await page.getByPlaceholder('+62 812 3456 7890').fill('+62 812 0000 5678');
  await page.getByPlaceholder('Street, number, city, landmarks…').fill('7 Selector Street, Jakarta');
  await page.getByRole('button', { name: /Place order — \$43\.50/ }).click();

  // --- Receipt: server snapshot proves ids+pricing survived the round trip ---
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}\?code=FO-/);
  await expect(page.getByText('Add-ons: Extra egg, Chicken satay (3 pcs)')).toBeVisible();
  await expect(page.getByText('1 × Es Teh Manis')).toHaveCount(2);
  await expect(page.getByText('Size: Large')).toBeVisible();
  await expect(page.getByText('Size: Jumbo')).toBeVisible();
  await expect(page.getByText('Subtotal').locator('..').getByText('$40.50')).toBeVisible();
  await expect(page.getByText('Total', { exact: true }).locator('..').getByText('$43.50')).toBeVisible();

  // Cart emptied after submit.
  await page.goto('/cart');
  await expect(page.getByRole('heading', { level: 1, name: 'Your cart is empty' })).toBeVisible();
});

test('radio picks swap, multi-selects stack, and plain "Add" still works untouched', async ({ page }) => {
  await openWarungMenu(page);
  const tehRow = dishRow(page, 'Es Teh Manis');

  // Radio group (max 1): Jumbo replaces Large, and the unit price follows.
  await tehRow.getByRole('button', { name: /Large/ }).click();
  await tehRow.getByRole('button', { name: /Jumbo/ }).click();
  await expect(tehRow.getByRole('button', { name: /Large/ })).toHaveAttribute('aria-pressed', 'false');
  await expect(tehRow.getByRole('button', { name: /Jumbo/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(tehRow.getByTestId('options-unit-price')).toHaveText('Unit price: $8.50');

  // All three add-ons can be selected at once (max 3): 2.00+5.00+1.50 = +$8.50.
  const nasiRow = dishRow(page, 'Nasi Goreng Spesial');
  await nasiRow.getByRole('button', { name: /Extra egg/ }).click();
  await nasiRow.getByRole('button', { name: /satay/ }).click();
  await nasiRow.getByRole('button', { name: /shallots/ }).click();
  await expect(nasiRow.getByTestId('options-unit-price')).toHaveText('Unit price: $26.50');

  // Optional groups: deselect Jumbo, then "Add" with nothing selected is a
  // plain base-price line — the guard the whole existing suite leans on.
  await tehRow.getByRole('button', { name: /Jumbo/ }).click();
  await expect(tehRow.getByRole('button', { name: /Jumbo/ })).toHaveAttribute('aria-pressed', 'false');
  await tehRow.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('link', { name: /Cart/ }).click();
  const plainLine = page
    .locator('div.divide-y > div', { has: page.getByText('$5.00 each') })
    .first();
  await expect(plainLine).toBeVisible();
  await expect(page.getByText('Subtotal').locator('..').getByText('$5.00')).toBeVisible();
});
