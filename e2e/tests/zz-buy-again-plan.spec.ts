import { expect, test } from '@playwright/test';
import {
  API,
  bearer,
  createOrder,
  loginToken,
  signInUi,
  timed,
  warungFixture,
} from '../helpers/fixtures';

/**
 * "Buy again" SERVER-side revalidation (Phase 17, session 149): the button's
 * primary source is now `GET /orders/:id/buy-again-plan` — the receipt ladder
 * revalidated against the CURRENT menu, including the price-drift rung the
 * client ladder never reported. This spec pins the three rungs that matter:
 *
 *  1. LIVE drift: an owner price raise after the order froze surfaces as a
 *     per-line price row and BLOCKS the auto-route (report-keeps-the-shopper);
 *  2. FALLBACK: with the plan route aborted, the session-107 client ladder
 *     still rebuilds the cart and routes a clean plan (never a dead button);
 *  3. the receipt-ladder contract on the wire: owner bearer 200 with CURRENT
 *     prices, denied proofs answer the byte-identical canonical 404, a junk
 *     uuid 400s, and the whole read writes NOTHING back;
 *  4. ID chrome: the drift section renders localized (fulfilled plan keeps
 *     it deterministic).
 *
 * Test 1 mutates the live menu (Nasi Goreng +150) and restores it in finally
 * (same contract as zz-order-again test 3). The order it creates is CANCELLED
 * afterwards, so no spec asserting live order state is poisoned; zz-* naming
 * keeps it out of the way of the seed-absolute specs.
 */

const DEMO = 'demo@foodorder.app';
const OWNER = 'owner@foodorder.app';

test('live price drift rides the plan: reported per line, auto-route blocked', async ({
  page,
  request,
}) => {
  const fx = await warungFixture(request);
  const demoToken = await loginToken(request, DEMO);
  const order = await createOrder(request, fx, {
    token: demoToken,
    customerName: 'Buy Again Plan Tester',
    contactEmail: DEMO,
  });
  // Freeze the order, then bump the CURRENT price by +$1.50. The receipt
  // island (block variant) must report the drift, not silently fold it.
  const cancel = await request.post(`${API}/orders/${order.id}/cancel`, {
    headers: bearer(demoToken),
  });
  expect(cancel.status(), await cancel.text()).toBe(201);
  const ownerToken = await loginToken(request, OWNER);
  await timed('buyAgainPlan.raisePrice', async () => {
    const res = await request.patch(`${API}/menu/items/${fx.menuItemId}`, {
      data: { priceCents: 1950 },
      headers: bearer(ownerToken),
    });
    expect(res.status(), await res.text()).toBe(200);
  });
  try {
    await signInUi(page, DEMO, { goto: '/login?next=/orders/my' });
    await page.goto(`/orders/${order.id}?email=${encodeURIComponent(DEMO)}`);
    await page.locator(`[data-testid="order-again-${order.code}"]`).click();
    const panel = page.locator(`[data-testid="order-again-result-${order.code}"]`);
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const price = panel.getByTestId('order-again-price');
    await expect(price).toHaveCount(1);
    await expect(price).toContainText('Nasi Goreng Spesial: +$1.50 since you ordered');
    // Drift is a report: no auto-route, the continue CTA owns the navigation.
    await expect(page).toHaveURL(new RegExp(`/orders/${order.id}`));
    // The line still FOLDS at today's price (drift never blocks the ride).
    await page.goto('/cart');
    const nasiLine = page
      .locator('div.divide-y > div', { has: page.getByText('Nasi Goreng Spesial') })
      .first();
    await expect(nasiLine.getByText('$19.50 each')).toBeVisible();
  } finally {
    await timed('buyAgainPlan.restorePrice', async () => {
      const res = await request.patch(`${API}/menu/items/${fx.menuItemId}`, {
        data: { priceCents: 1800 },
        headers: bearer(ownerToken),
      });
      expect(res.status()).toBe(200);
    });
  }
});

test('aborted plan route falls back to the client ladder: clean plan still routes', async ({
  page,
}) => {
  await page.route('**/buy-again-plan**', (route) => route.abort());
  await signInUi(page, DEMO, { goto: '/login?next=/orders/my' });
  // FO-SEED8 is a clean CLIENT plan too (live prices, over the min) — the
  // fallback ladder must route identically when the server rung is dead.
  await page.locator('#orders-tab-completed').click();
  const card = page.locator('[data-testid="order-card-FO-SEED8"]');
  await expect(card).toBeVisible();
  await card.locator('[data-testid="order-again-FO-SEED8"]').click();
  await expect(page).toHaveURL(/\/restaurants\/[0-9a-f-]+/, { timeout: 15_000 });
  await expect(page.locator('header a[href="/cart"] span')).toHaveText('1');
});

test('wire contract: owner 200 at CURRENT prices; denials are the byte-identical 404; nothing is written', async ({
  request,
}) => {
  const fx = await warungFixture(request);
  const demoToken = await loginToken(request, DEMO);
  const mine = await (
    await request.get(`${API}/orders/my?status=completed&limit=50`, { headers: bearer(demoToken) })
  ).json();
  const seed8 = mine.items.find((o: { code: string }) => o.code === 'FO-SEED8');
  expect(seed8, 'seed contract: demo owns a completed FO-SEED8').toBeTruthy();
  const detail = await (await request.get(`${API}/restaurants/${fx.restaurantId}`)).json();
  const nasi = detail.menuItems.find((m: { name: string }) => m.name === 'Nasi Goreng Spesial');

  const ok = await request.get(`${API}/orders/${seed8.id}/buy-again-plan`, {
    headers: bearer(demoToken),
  });
  expect(ok.status(), await ok.text()).toBe(200);
  const plan = await ok.json();
  expect(plan.orderCode).toBe('FO-SEED8');
  expect(plan.restaurant).toMatchObject({ id: fx.restaurantId, minOrderCents: 1000 });
  expect(plan.lines).toHaveLength(1);
  expect(plan.lines[0]).toMatchObject({
    quantity: 1,
    currentUnitPriceCents: nasi.priceCents, // CURRENT, whatever it is right now
    priceDeltaCents: 0,
    dish: { id: fx.menuItemId, isAvailable: true },
  });
  expect(plan.skipped).toEqual([]);
  expect(plan.priceDriftCents).toBe(0);

  // Denials are indistinguishable, byte for byte (no existence oracle).
  const unknown = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';
  const foreignProof = await request.get(
    `${API}/orders/${seed8.id}/buy-again-plan?contactEmail=nobody@nowhere.test`,
  );
  expect(foreignProof.status()).toBe(404);
  const unknownId = await request.get(
    `${API}/orders/${unknown}/buy-again-plan?contactEmail=nobody@nowhere.test`,
  );
  expect(unknownId.status()).toBe(404);
  expect(await foreignProof.json()).toEqual(await unknownId.json());

  const junk = await request.get(`${API}/orders/not-a-uuid/buy-again-plan`);
  expect(junk.status()).toBe(400);
  expect((await junk.json()).error.code).toBe('BAD_REQUEST');

  // Zero writes: the receipt read and the ORDER COUNTS both stand where they
  // were (same bearer, same filters -> same page after the plan calls).
  const mineAfter = await (
    await request.get(`${API}/orders/my?status=completed&limit=50`, { headers: bearer(demoToken) })
  ).json();
  expect(mineAfter.total).toBe(mine.total);
  const after = await (await request.get(`${API}/orders/${seed8.id}`, { headers: bearer(demoToken) })).json();
  expect(after.status).toBe('completed');
});

test('ID chrome: the drift section renders localized', async ({ page, request }) => {
  const fx = await warungFixture(request);
  const detail = await (await request.get(`${API}/restaurants/${fx.restaurantId}`)).json();
  const nasi = detail.menuItems.find((m: { name: string }) => m.name === 'Nasi Goreng Spesial');
  const crafted = {
    orderId: '00000000-0000-4000-8000-000000000000',
    orderCode: 'FO-SEED8',
    restaurant: { id: fx.restaurantId, name: 'Warung Nusantara', minOrderCents: 1000 },
    lines: [
      {
        dish: nasi,
        options: [],
        quantity: 1,
        requestedQuantity: 1,
        snapshotUnitPriceCents: 1800,
        currentUnitPriceCents: 1950,
        priceDeltaCents: 150,
      },
    ],
    skipped: [],
    clamped: [],
    addedUnits: 1,
    plannedSubtotalCents: 1950,
    snapshotSubtotalCents: 1800,
    priceDriftCents: 150,
  };
  await page.route('**/buy-again-plan**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(crafted) }),
  );
  await page.context().addCookies([{ name: 'locale', value: 'id', url: 'http://localhost:3000' }]);
  await signInUi(page, DEMO, { goto: '/login?next=/orders/my' });
  await page.locator('#orders-tab-completed').click();
  const card = page.locator('[data-testid="order-card-FO-SEED8"]');
  await expect(card).toBeVisible();
  await card.locator('[data-testid="order-again-FO-SEED8"]').click();
  const panel = page.locator(`[data-testid="order-again-result-FO-SEED8"]`);
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toContainText('Harga berubah sejak Anda memesan');
  await expect(panel.getByTestId('order-again-price')).toContainText('naik');
  await expect(page).toHaveURL(/\/orders\/my/); // drift kept the shopper on the panel
});
