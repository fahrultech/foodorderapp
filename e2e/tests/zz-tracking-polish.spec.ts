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
 * Tracking-page delivery polish (Phase 12 product item, session 119).
 *
 * Contract under test: GET /orders/:id embeds `delivery` ONLY while the
 * order is `delivering` — the SSR receipt page renders the assigned
 * driver's FIRST name plus the "usually ~N min left" countdown derived
 * from session 113's per-restaurant ETA; every other status ships no card.
 *
 * Doctrine notes:
 * - The minute value is NEVER an absolute pin: earlier suite specs may
 *   have completed more Warung orders, shifting the 20-row median, and the
 *   countdown shrinks second by second. The DOM is cross-checked against
 *   the API payload the test itself fetched (session-85 shape doctrine),
 *   with a <=1 minute ceil-jitter allowance between the two reads.
 * - The fixture order is created and driven entirely via API with its OWN
 *   proof email, so nothing shared (FO-SEED*) is consumed.
 * - File name sorts after every other zz-* spec: it is the LAST state
 *   consumer in the suite.
 */

const PROOF = 'tracking-polish@example.com';

function tokenSub(token: string): string {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
}

async function driveToDelivering(
  request: any,
  fx: { restaurantId: string; menuItemId: string },
  customerToken: string,
  ownerToken: string,
  driverToken: string,
) {
  const order = await createOrder(request, fx, {
    token: customerToken,
    customerName: 'Tracking Polish Tester',
    contactPhone: '081200001190',
    contactEmail: PROOF,
    deliveryAddress: '1 Countdown Lane, Jakarta',
  });
  // shipped default: pending->confirmed requires a succeeded payment.
  await payOrder(request, customerToken, order.id);
  for (const status of ['confirmed', 'preparing']) {
    const moved = await request.patch(
      `${API}/restaurants/${fx.restaurantId}/orders/${order.id}/status?status=${status}`,
      { headers: bearer(ownerToken) },
    );
    expect(moved.status(), await moved.text()).toBe(200);
  }
  const assigned = await timed('assign-driver', async () =>
    request.patch(`${API}/restaurants/${fx.restaurantId}/orders/${order.id}/driver`, {
      data: { driverId: tokenSub(driverToken) },
      headers: bearer(ownerToken),
    }),
  );
  expect(assigned.status(), await assigned.text()).toBe(200);
  return order;
}

async function moveDelivering(request: any, fx: any, ownerToken: string, orderId: string) {
  const moved = await request.patch(
    `${API}/restaurants/${fx.restaurantId}/orders/${orderId}/status?status=delivering`,
    { headers: bearer(ownerToken) },
  );
  expect(moved.status(), await moved.text()).toBe(200);
}

test.describe('tracking-page delivery polish', () => {
  test('preparing ships no card; after the delivering flip the card names the driver and counts down', async ({
    request,
    page,
  }) => {
    const fx = await warungFixture(request);
    const customerToken = await loginToken(request, 'demo@foodorder.app');
    const ownerToken = await loginToken(request, 'owner@foodorder.app');
    const driverToken = await loginToken(request, 'driver@foodorder.app');
    const order = await driveToDelivering(request, fx, customerToken, ownerToken, driverToken);

    // NEGATIVE GATE (read-only proof first): still `preparing` — the
    // receipt renders, the card does NOT exist, and the API carries no key.
    const apiBefore = await (
      await request.get(`${API}/orders/${order.id}?contactEmail=${PROOF}`)
    ).json();
    expect(apiBefore.status).toBe('preparing');
    expect('delivery' in apiBefore, 'non-delivering receipt must not carry delivery').toBe(false);
    await page.goto(`${WEB}/orders/${order.id}?email=${PROOF}`);
    await expect(page.getByTestId('tracking-delivery')).toHaveCount(0);

    // The flip under test.
    await moveDelivering(request, fx, ownerToken, order.id);

    const api = await (await request.get(`${API}/orders/${order.id}?contactEmail=${PROOF}`)).json();
    const view = api.delivery;
    expect(view, 'delivering receipt must embed delivery').not.toBeNull();
    expect(view.driverFirstName, 'seeded driver "Demo Driver" -> first token').toBe('Demo');
    expect(['observed', 'estimate']).toContain(view.etaSource);
    expect(Number.isInteger(view.sampleCount)).toBe(true);
    if (view.etaSource === 'observed') {
      expect(view.sampleCount).toBeGreaterThanOrEqual(5);
    } else {
      expect(view.sampleCount).toBeLessThan(5);
    }
    expect(Number.isInteger(view.remainingMinutes)).toBe(true);
    expect(view.remainingMinutes).toBeGreaterThanOrEqual(0);

    await page.goto(`${WEB}/orders/${order.id}?email=${PROOF}`);
    const card = page.getByTestId('tracking-delivery');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('tracking-delivery-driver')).toContainText('Demo');
    const etaText = (await page.getByTestId('tracking-delivery-eta').textContent()) ?? '';
    // Copy ladder: real minutes OR the honest floor — never garbage.
    const soon = etaText === 'Arriving any moment now';
    const m = etaText.match(/^Usually ~(\d+) min left$/);
    expect(soon || m, `unexpected eta copy: ${JSON.stringify(etaText)}`).toBeTruthy();
    if (m) {
      expect(Number(m[1])).toBe(view.remainingMinutes);
      expect(Number(m[1])).toBeGreaterThan(0);
    }
  });

  test('ID locale renders the localized driver line and countdown', async ({
    request,
    page,
  }) => {
    const fx = await warungFixture(request);
    const customerToken = await loginToken(request, 'demo@foodorder.app');
    const ownerToken = await loginToken(request, 'owner@foodorder.app');
    const driverToken = await loginToken(request, 'driver@foodorder.app');
    const order = await driveToDelivering(request, fx, customerToken, ownerToken, driverToken);
    await moveDelivering(request, fx, ownerToken, order.id);

    await page.context().addCookies([{ name: 'locale', value: 'id', url: WEB }]);
    await page.goto(`${WEB}/orders/${order.id}?email=${PROOF}`);
    await expect(page.getByTestId('tracking-delivery')).toBeVisible();
    await expect(page.getByTestId('tracking-delivery-driver')).toContainText('Demo');
    const etaText = (await page.getByTestId('tracking-delivery-eta').textContent()) ?? '';
    expect(
      etaText === 'Tiba sebentar lagi' || /^Biasanya sisa ~\d+ mnt$/.test(etaText),
      `unexpected ID eta copy: ${JSON.stringify(etaText)}`,
    ).toBeTruthy();
  });
});
