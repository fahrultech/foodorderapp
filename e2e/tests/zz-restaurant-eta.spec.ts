import { expect, test } from '@playwright/test';
import {
  API,
  WEB,
  bearer,
  createOrder,
  loginToken,
  payOrder,
  timed,
  warungFixture,
} from '../helpers/fixtures';

/**
 * Delivery ETA honesty (session 113, Phase 11 product item).
 *
 * Doctrine notes:
 * - The restaurant page is force-dynamic SSR: its data fetch is NOT a browser
 *   request, so `page.route` cannot feed it — the observed state is produced
 *   with REAL completed orders through the paid+status ladder (session 44's
 *   shipped gate default). Checkout IS client-side, so the synthetic
 *   interception (session 91/102 recipe) is honest there.
 * - The pill minute value is NEVER an absolute pin: earlier suite specs can
 *   legitimately have completed more Warung orders by now, which shifts the
 *   20-row median. The DOM is cross-checked against the API payload the
 *   test itself fetches (session-85 shape doctrine); serial workers +
 *   HTTP_CACHE_TTL_SEC=0 boot make the two reads provably equal.
 * - File name sorts AFTER every seed-absolute and state-consuming spec
 *   (admin, owner-analytics, pay-order, zz-driver-portal): the two orders it
 *   completes only ever feed its own expectations.
 */

async function detailReq(request: any, id: string) {
  const res = await request.get(`${API}/restaurants/${id}`);
  expect(res.status()).toBe(200);
  return res.json();
}

async function completeOrder(
  request: any,
  customerToken: string,
  ownerToken: string,
  fx: { restaurantId: string; menuItemId: string },
) {
  const order = await createOrder(request, fx, {
    token: customerToken,
    customerName: 'ETA Tester',
    contactPhone: '081200001130',
    contactEmail: 'eta@example.com',
    deliveryAddress: '1 Median Row, Jakarta',
  });
  await payOrder(request, customerToken, order.id);
  for (const status of ['confirmed', 'preparing', 'delivering', 'completed']) {
    const moved = await request.patch(
      `${API}/restaurants/${fx.restaurantId}/orders/${order.id}/status?status=${status}`,
      { headers: bearer(ownerToken) },
    );
    expect(moved.status(), await moved.text()).toBe(200);
  }
  return order;
}

test.describe('delivery ETA honesty', () => {
  test('detail embeds deliveryEta, list rows never carry it, ladder invariants hold', async ({
    request,
  }) => {
    const fx = await warungFixture(request);
    const detail = await detailReq(request, fx.restaurantId);
    const eta = detail.deliveryEta;
    expect(eta, 'GET /restaurants/:id must embed deliveryEta').not.toBeNull();
    expect(['observed', 'estimate']).toContain(eta.source);
    expect(Number.isInteger(eta.seconds)).toBe(true);
    expect(eta.seconds).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(eta.sampleCount)).toBe(true);
    expect(eta.sampleCount).toBeGreaterThanOrEqual(0);
    // The two proven branches pin DIFFERENT invariants — the sample floor is
    // the whole point, so whichever the server answers must be self-consistent.
    if (eta.source === 'estimate') {
      expect(eta.sampleCount).toBeLessThan(5);
      expect(eta.seconds).toBe(Math.round(detail.avgPrepMinutes) * 60);
    } else {
      expect(eta.sampleCount).toBeGreaterThanOrEqual(5);
    }

    // Contract: the LIST payload stays byte-unchanged (session-79's 3-
    // statement list contract; the ETA rides the detail read only).
    const list = await (await request.get(`${API}/restaurants?limit=50`)).json();
    expect(list.items.length).toBeGreaterThan(0);
    for (const item of list.items) {
      expect('deliveryEta' in item, `list item ${item.slug} must not carry deliveryEta`).toBe(
        false,
      );
    }
  });

  test('completing paid orders flips the SSR page to an observed pill matching the API', async ({
    request,
    page,
  }) => {
    const fx = await warungFixture(request);
    const customerToken = await loginToken(request, 'demo@foodorder.app');
    const ownerToken = await loginToken(request, 'owner@foodorder.app');
    await timed('eta-complete-order-1', async () =>
      completeOrder(request, customerToken, ownerToken, fx),
    );
    await timed('eta-complete-order-2', async () =>
      completeOrder(request, customerToken, ownerToken, fx),
    );

    const detail = await detailReq(request, fx.restaurantId);
    expect(detail.deliveryEta?.source, '5th+ completed sample must answer observed').toBe(
      'observed',
    );
    expect(detail.deliveryEta.sampleCount).toBeGreaterThanOrEqual(5);
    const minutes = Math.max(1, Math.round(detail.deliveryEta.seconds / 60));

    await page.goto(`${WEB}/restaurants/${fx.restaurantId}`);
    const pill = page.getByTestId('eta-observed');
    await expect(pill).toBeVisible();
    // DOM == the API payload this test read (serial worker, TTL=0 boot: the
    // server-rendered fetch and this one cannot disagree).
    await expect(pill).toHaveText(new RegExp(`^⏱ Usually ~${minutes} min$`));
    await expect(pill).toHaveAttribute(
      'title',
      new RegExp(`Based on ${detail.deliveryEta.sampleCount} recent completed deliveries$`),
    );
    await expect(page.getByTestId('eta-estimate')).toHaveCount(0);
  });

  test('checkout renders the observed ETA row from the restaurant read', async ({
    request,
    page,
  }) => {
    const fx = await warungFixture(request);
    await page.goto(`${WEB}/restaurants/${fx.restaurantId}`);
    await page.getByRole('button', { name: /^Add( |$)/ }).first().click();
    const detail = await detailReq(request, fx.restaurantId);
    const synthetic = {
      ...detail,
      deliveryEta: { source: 'observed', seconds: 25 * 60, sampleCount: 30 },
    };
    await page.route(`**/api/restaurants/${fx.restaurantId}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(synthetic),
      }),
    );
    await page.goto(`${WEB}/checkout`);
    const row = page.getByTestId('checkout-eta');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Delivery time');
    await expect(row).toContainText('usually ~25 min');
  });

  test('ID locale: observed pill and checkout row are localized', async ({
    context,
    request,
    page,
  }) => {
    const fx = await warungFixture(request);
    await context.addCookies([{ name: 'locale', value: 'id', url: WEB }]);

    // Observed state persists from the second test (serial single worker).
    await page.goto(`${WEB}/restaurants/${fx.restaurantId}`);
    const pill = page.getByTestId('eta-observed');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText(/^⏱ Biasanya ~\d+ mnt$/);
    await expect(pill).toHaveAttribute('title', /^Berdasarkan \d+ pengiriman selesai terbaru$/);

    // Session 95 doctrine: with the ID cookie the CTA is 'Tambah', not 'Add'.
    await page.getByRole('button', { name: /^(Tambah|Add)( |$)/ }).first().click();
    const detail = await detailReq(request, fx.restaurantId);
    const synthetic = {
      ...detail,
      deliveryEta: { source: 'observed', seconds: 15 * 60, sampleCount: 12 },
    };
    await page.route(`**/api/restaurants/${fx.restaurantId}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(synthetic),
      }),
    );
    await page.goto(`${WEB}/checkout`);
    const row = page.getByTestId('checkout-eta');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Waktu pengiriman');
    await expect(row).toContainText('biasanya ~15 mnt');
  });
});
