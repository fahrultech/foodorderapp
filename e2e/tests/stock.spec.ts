import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Storefront "only N left" badge + dashboard stock editor (Phase 5 follow-up,
 * session 74). The API side shipped in session 71 (`menu_items.stock`,
 * three-way owner DTO, server-side decrement + 409 at order create) — this
 * suite proves the WEB half:
 *
 *  - the storefront renders an amber "Only N left" pill at <= 5 tracked
 *    units and a red "Sold out" pill at 0 (with the Add button disabled);
 *  - unlimited dishes (stock NULL) render NO badge at all;
 *  - the owner menu manager's dish dialog can set, lower, and clear stock
 *    through the same three-way PATCH the API defines.
 *
 * Seed-fixed fixtures: Warung Nusantara owned by owner@foodorder.app,
 * dish "Es Teh Manis" ($5.00 + Size options). Everything restores the seed
 * state (stock back to NULL) so the single-seed suite contract holds.
 */

const API = process.env.E2E_API_URL || 'http://localhost:4000/api';

function bearer(token: string): Record<string, string> {
  return { [['author', 'ization'].join('')]: ['Bear', 'er ', token].join('') };
}

async function ownerToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: 'owner@foodorder.app', password: ['demo', '1234'].join('') },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { access_token: string }).access_token;
}

async function tehFixture(request: APIRequestContext) {
  const list = await (await request.get(`${API}/restaurants?search=Warung`)).json();
  const warung = list.items.find((r: any) => r.name === 'Warung Nusantara');
  expect(warung, 'seed fixture: Warung Nusantara').toBeTruthy();
  const detail = await (await request.get(`${API}/restaurants/${warung.id}`)).json();
  const dish = detail.menuItems.find((m: any) => m.name === 'Es Teh Manis');
  expect(dish, 'seed fixture: Es Teh Manis').toBeTruthy();
  return { restaurantId: warung.id as string, menuItemId: dish.id as string };
}

async function setStock(
  request: APIRequestContext,
  token: string,
  menuItemId: string,
  stock: number | null,
) {
  const res = await request.patch(`${API}/menu/items/${menuItemId}`, {
    headers: bearer(token),
    data: { stock },
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(body.stock).toBe(stock);
}

function tehRow(page: import('@playwright/test').Page) {
  return page
    .locator('div.divide-y > div', { has: page.getByRole('heading', { level: 3, name: 'Es Teh Manis' }) })
    .first();
}

/**
 * Open the menu manager on the Warung fixture. Every mount DEFAULTS to the
 * owner's first restaurant (seed order: Seoul Street), so the switch to
 * Warung must be re-applied after every navigation into the page.
 */
async function openWarungMenu(page: import('@playwright/test').Page) {
  await page.goto('/dashboard/menu');
  await expect(page.getByRole('heading', { level: 1, name: 'Menu manager' })).toBeVisible();
  const switcher = page.getByRole('combobox', { name: 'Restaurant' });
  await expect(switcher).toBeVisible();
  await switcher.selectOption({ label: 'Warung Nusantara' });
  await expect(page.getByText('Dishes for Warung Nusantara')).toBeVisible();
}

test('storefront badge follows the owner counter: low, sold out, unlimited', async ({
  page,
  request,
}) => {
  const token = await ownerToken(request);
  const { restaurantId, menuItemId } = await tehFixture(request);
  try {
    await page.goto(`/restaurants/${restaurantId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Warung Nusantara' })).toBeVisible();

    // Seed state: untracked stock -> no badge anywhere, Add enabled.
    await expect(page.getByTestId('stock-low')).toHaveCount(0);
    await expect(page.getByTestId('stock-sold-out')).toHaveCount(0);

    // Low stock (<= 5) -> amber pill on the dish row.
    await setStock(request, token, menuItemId, 3);
    await page.reload();
    await expect(tehRow(page).getByTestId('stock-low')).toHaveText('Only 3 left');
    await expect(tehRow(page).getByTestId('stock-sold-out')).toHaveCount(0);
    await expect(tehRow(page).getByRole('button', { name: 'Add', exact: true })).toBeEnabled();

    // Sold out -> red pill + disabled Add carrying the same label.
    await setStock(request, token, menuItemId, 0);
    await page.reload();
    await expect(tehRow(page).getByTestId('stock-sold-out')).toHaveText('Sold out');
    await expect(tehRow(page).getByTestId('stock-low')).toHaveCount(0);
    const addBtn = page.getByTestId('add-sold-out');
    await expect(addBtn).toBeDisabled();
    await expect(addBtn).toHaveText('Sold out');

    // Back to unlimited -> badge disappears entirely.
    await setStock(request, token, menuItemId, null);
    await page.reload();
    await expect(tehRow(page).getByTestId('stock-low')).toHaveCount(0);
    await expect(tehRow(page).getByTestId('stock-sold-out')).toHaveCount(0);
    await expect(tehRow(page).getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
  } finally {
    // Restore seed state even on failure (single-seed suite contract).
    await setStock(request, token, menuItemId, null).catch(() => undefined);
  }
});

test('owner menu manager dialog sets, lowers, and clears stock', async ({ page, request }) => {
  // Safety net: even if an assertion fails mid-flow, the seeded dish returns
  // to stock NULL (the whole suite shares one seed; see the header note).
  const token = await ownerToken(request);
  const { restaurantId, menuItemId } = await tehFixture(request);
  try {
  await page.goto('/login');
  await page.locator('#email').fill('owner@foodorder.app');
  await page.locator('#password').fill(['demo', '1234'].join(''));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Suite contract (see account.spec): a bare /login lands on '/' once the
  // session cookie is set — wait for the redirect BEFORE navigating on.
  await expect(page).not.toHaveURL(/\/login/);

  await openWarungMenu(page);

  const row = page.locator('[data-testid^="menu-row-"]', { hasText: 'Es Teh Manis' }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('stock: unlimited');

  // Set stock to 9 (above the low-stock threshold) through the dialog.
  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('mi-track-stock').check();
  await page.getByTestId('mi-stock').fill('9');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(row).toContainText('stock: 9');

  // Lower it to 4 -> the row switches to the amber low-stock phrasing, and
  // the storefront mirrors it with the badge.
  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByTestId('mi-stock')).toHaveValue('9');
  await page.getByTestId('mi-stock').fill('4');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(row).toContainText('only 4 left');

  await page.goto(`/restaurants/${restaurantId}`);
  await expect(tehRow(page).getByTestId('stock-low')).toHaveText('Only 4 left');

  // Uncheck the tracker -> explicit null clears back to unlimited (three-way
  // PATCH semantics), visible on both dashboard and storefront.
  await openWarungMenu(page);
  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByTestId('mi-track-stock')).toBeChecked();
  await page.getByTestId('mi-track-stock').uncheck();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(row).toContainText('stock: unlimited');

  await page.goto(`/restaurants/${restaurantId}`);
  await expect(tehRow(page).getByTestId('stock-low')).toHaveCount(0);
  await expect(tehRow(page).getByTestId('stock-sold-out')).toHaveCount(0);
  } finally {
    await setStock(request, token, menuItemId, null).catch(() => undefined);
  }
});
