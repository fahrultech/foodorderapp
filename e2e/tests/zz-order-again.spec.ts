import { expect, test, type Page } from '@playwright/test';
import {
  API,
  bearer,
  loginToken,
  payOrder,
  signInUi,
  timed,
  warungFixture,
} from '../helpers/fixtures';

/**
 * "Order again" (Phase 10, session 107): one click on a COMPLETED order —
 * history card or receipt — refills the cart from the FROZEN snapshot via the
 * lib/order-again ladder. The suite pins the honest edges:
 *
 *  - clean plans route straight to the restaurant page (FO-SEED8 = 1x Nasi
 *    Goreng Spesial $18.00 ≥ $10.00 min);
 *  - a below-minimum plan reports instead of routing (FO-SEED9 = 1x Es Teh
 *    Manis $5.00 < $10.00);
 *  - a dish the owner hid since the order is SKIPPED AND REPORTED while the
 *    frozen option selection rides at CURRENT prices;
 *  - a foreign cart always goes through the inline replace confirmation
 *    (cancel keeps the old cart untouched);
 *  - the ID chrome renders localized.
 *
 * History assertions ride the Completed FILTER TAB (pinned via the stable
 * #orders-tab-completed id, locale-agnostic): earlier zz-* specs legitimately
 * grow the demo account's unfiltered history, so the absolute page-1
 * position of a seed card is not a fair pin. The tab keeps this spec
 * fresh-seed-safe (4 completed rows max).
 *
 * Test 3 mutates the live menu (hides Es Teh Manis via the owner API) and
 * restores it in-test — the toggle would otherwise poison later runs of any
 * spec that orders that dish.
 */

const DEMO = 'demo@foodorder.app';
const OWNER = 'owner@foodorder.app';

async function showCompletedOnly(page: Page) {
  await page.locator('#orders-tab-completed').click();
  await expect(page.locator('#orders-tab-completed')).toHaveAttribute('aria-selected', 'true');
}

async function menuDish(request: import('@playwright/test').APIRequestContext, name: string) {
  const fx = await warungFixture(request);
  const detail = await (await request.get(`${API}/restaurants/${fx.restaurantId}`)).json();
  const dish = detail.menuItems.find((m: { name: string }) => m.name === name);
  return { ...fx, dish };
}

test('clean completed order: one click refills the cart and routes to the restaurant', async ({
  page,
}) => {
  await signInUi(page, DEMO, { goto: '/login?next=/orders/my' });
  await showCompletedOnly(page);
  const card = page.locator('[data-testid="order-card-FO-SEED8"]');
  await expect(card).toBeVisible();
  await card.locator('[data-testid="order-again-FO-SEED8"]').click();
  // Clean plan (no skips, no clamp, subtotal over the min) -> auto-route.
  await expect(page).toHaveURL(/\/restaurants\/[0-9a-f-]+/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Warung Nusantara' })).toBeVisible();
  // Seed contract (verified against the live receipt payload): FO-SEED8 =
  // 1x Nasi Goreng Spesial $18.00 — one unit, over the $10.00 min.
  await expect(page.locator('header a[href="/cart"] span')).toHaveText('1');
});

test('below-minimum replay reports honestly instead of silently routing', async ({ page }) => {
  await signInUi(page, DEMO, { goto: '/login?next=/orders/my' });
  await showCompletedOnly(page);
  const card = page.locator('[data-testid="order-card-FO-SEED9"]');
  await expect(card).toBeVisible();
  await card.locator('[data-testid="order-again-FO-SEED9"]').click();
  const panel = page.locator('[data-testid="order-again-result-FO-SEED9"]');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toContainText('Added 1 item to your cart');
  await expect(panel.getByTestId('order-again-below-min')).toHaveText(
    "Cart subtotal $5.00 is below this restaurant's $10.00 minimum order.",
  );
  // No auto-route — the shopper acknowledges via the explicit continue CTA.
  await expect(page).toHaveURL(/\/orders\/my/);
  await panel.getByTestId('order-again-continue').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Warung Nusantara' })).toBeVisible();
});

test('hidden dish is skipped-and-named while the frozen options ride at current prices', async ({
  page,
  request,
}) => {
  const nasi = await menuDish(request, 'Nasi Goreng Spesial');
  const teh = await menuDish(request, 'Es Teh Manis');
  const eggId = nasi.dish.optionGroups[0].choices.find((c: { name: string }) => c.name === 'Extra egg').id;
  const largeId = teh.dish.optionGroups[0].choices.find((c: { name: string }) => c.name === 'Large').id;

  const demoToken = await loginToken(request, DEMO);
  const order = await timed('orderAgain.createOrder', async () => {
    const res = await request.post(`${API}/orders`, {
      data: {
        restaurantId: nasi.restaurantId,
        items: [
          { menuItemId: nasi.dish.id, quantity: 2, optionChoiceIds: [eggId] },
          { menuItemId: teh.dish.id, quantity: 1, optionChoiceIds: [largeId] },
        ],
        customerName: 'Order Again Tester',
        contactPhone: '081200001070',
        contactEmail: DEMO,
        deliveryAddress: '12 Repeater Street, Jakarta',
      },
      headers: bearer(demoToken),
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()) as { id: string; code: string };
  });
  await payOrder(request, demoToken, order.id);
  const ownerToken = await loginToken(request, OWNER);
  for (const status of ['confirmed', 'preparing', 'delivering', 'completed']) {
    await timed(`orderAgain.setStatus(${status})`, async () => {
      const res = await request.patch(
        `${API}/restaurants/${nasi.restaurantId}/orders/${order.id}/status?status=${status}`,
        { headers: bearer(ownerToken) },
      );
      expect(res.status(), await res.text()).toBe(200);
    });
  }

  // Hide the tea AFTER the order froze — the ladder must now report it.
  await timed('orderAgain.hideTea', async () => {
    const res = await request.patch(`${API}/menu/items/${teh.dish.id}/availability`, {
      data: { isAvailable: false },
      headers: bearer(ownerToken),
    });
    expect(res.status()).toBe(200);
  });

  try {
    await signInUi(page, DEMO, { goto: '/login?next=/orders/my' });
    await showCompletedOnly(page);
    const card = page.locator(`[data-testid="order-card-${order.code}"]`);
    await expect(card).toBeVisible(); // newest first on the Completed tab
    await card.locator(`[data-testid="order-again-${order.code}"]`).click();

    const panel = page.locator(`[data-testid="order-again-result-${order.code}"]`);
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel).toContainText('Added 2 items to your cart'); // 2x nasi, tea skipped
    const skip = panel.getByTestId('order-again-skipped');
    await expect(skip).toHaveCount(1);
    await expect(skip).toContainText('Es Teh Manis');
    await expect(skip).toContainText('currently unavailable');

    // The receipt page shows the SAME island (guest-proof read via the email
    // proof the fixture stored) — click again from there: the cart MERGES
    // (2 more nasi units onto the matching lineKey -> 4 units on one line).
    await page.goto(`/orders/${order.id}?email=${encodeURIComponent(DEMO)}`);
    await page.locator(`[data-testid="order-again-${order.code}"]`).click();
    const rpanel = page.locator(`[data-testid="order-again-result-${order.code}"]`);
    await expect(rpanel).toBeVisible({ timeout: 15_000 });
    await expect(rpanel).toContainText('currently unavailable');

    await page.goto('/cart');
    const nasiLine = page
      .locator('div.divide-y > div', { has: page.getByText('Add-ons: Extra egg') })
      .first();
    await expect(nasiLine).toBeVisible();
    await expect(nasiLine.getByText('$20.00 each')).toBeVisible(); // CURRENT price, not the snapshot
    await expect(page.getByText('Size: Large')).toHaveCount(0); // the skipped tea never rides
  } finally {
    await timed('orderAgain.restoreTea', async () => {
      const res = await request.patch(`${API}/menu/items/${teh.dish.id}/availability`, {
        data: { isAvailable: true },
        headers: bearer(ownerToken),
      });
      expect(res.status()).toBe(200);
    });
  }
});

test('foreign cart: replace is confirmed first and cancel keeps it untouched', async ({ page }) => {
  // Build a Seoul Street cart through the real UI (a NAMED dish - the
  // below absence-check must not guess which row `.first()` happened to be).
  await page.goto('/');
  await page.getByRole('link', { name: /Seoul Street/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Seoul Street' })).toBeVisible();
  const tteokRow = page
    .locator('div.divide-y > div', { has: page.getByRole('heading', { level: 3, name: 'Tteokbokki' }) })
    .first();
  await tteokRow.getByRole('button', { name: /^Add( |$)/ }).click();
  await expect(page.locator('header a[href="/cart"] span')).toHaveText('1');

  await signInUi(page, DEMO, { goto: '/login?next=/orders/my' });
  await showCompletedOnly(page);
  const card = page.locator('[data-testid="order-card-FO-SEED8"]');
  await expect(card).toBeVisible();
  await card.locator('[data-testid="order-again-FO-SEED8"]').click();

  const ask = page.locator('[data-testid="order-again-replace-FO-SEED8"]');
  await expect(ask).toBeVisible({ timeout: 15_000 });
  await expect(ask).toContainText('Your cart holds dishes from Seoul Street.');
  await ask.getByTestId('order-again-replace-cancel').click();
  await expect(ask).toHaveCount(0);
  await expect(page).toHaveURL(/\/orders\/my/);
  // Cancel left the Seoul cart fully intact.
  await page.goto('/cart');
  await expect(page.getByText('Tteokbokki')).toBeVisible();
  await expect(page.getByText('Nasi Goreng Spesial')).toHaveCount(0);

  // Second attempt, this time confirming: the Warung line REPLACES the cart
  // (badge stays 1 unit, but a different dish) and the clean plan routes.
  await page.goto('/orders/my');
  await showCompletedOnly(page);
  await card.locator('[data-testid="order-again-FO-SEED8"]').click();
  await expect(ask).toBeVisible({ timeout: 15_000 });
  await ask.getByTestId('order-again-replace-confirm').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Warung Nusantara' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('header a[href="/cart"] span')).toHaveText('1');
  await page.goto('/cart');
  await expect(page.getByText('Nasi Goreng Spesial')).toBeVisible();
  await expect(page.getByText('Tteokbokki')).toHaveCount(0);
});

test('ID chrome: the same ladder speaks Indonesian', async ({ page }) => {
  await page.context().addCookies([{ name: 'locale', value: 'id', url: 'http://localhost:3000' }]);
  await signInUi(page, DEMO, { goto: '/login?next=/orders/my' });
  await showCompletedOnly(page);
  const card = page.locator('[data-testid="order-card-FO-SEED9"]');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('order-again-FO-SEED9')).toHaveText('Pesan lagi');
  await card.getByTestId('order-again-FO-SEED9').click();
  const panel = page.locator('[data-testid="order-again-result-FO-SEED9"]');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toContainText('1 item ditambahkan ke keranjang Anda');
  await expect(panel.getByTestId('order-again-below-min')).toContainText(
    'Subtotal keranjang $5.00 di bawah minimum pesanan restoran ini sebesar $10.00.',
  );
  await expect(panel.getByTestId('order-again-continue')).toHaveText('Ke Warung Nusantara');
});
