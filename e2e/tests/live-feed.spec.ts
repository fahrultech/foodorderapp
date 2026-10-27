import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Phase 5 "dashboard/order-tracking consume the WS feed (SSE stays the
 * fallback)" — the live transport ladder, proven end to end in a real
 * browser:
 *
 *  - the owner dashboard reaches `data-feed-transport="ws"` (Socket.IO
 *    handshake + subscribe ACK verified — SSE/poll never report 'ws');
 *  - a brand-new guest order surfaces in the owner inbox in <5s: push
 *    latency is ~0.5s (400ms debounce + GET), so the tight timeout is only
 *    reachable via the feed — the 10s poll could never make it;
 *  - a signed-in customer's tracking page follows an owner status change
 *    the same way (WS `subscribe:me` room), without a manual reload.
 *
 * Seed-fixed fixtures: owner@foodorder.app / demo@foodorder.app (pw demo1234),
 * Warung Nusantara (min $10, Nasi Goreng Spesial $18.00). Auth rate limit is
 * 10/min/IP — this file costs 2 UI logins + 2 REST logins, well inside it.
 */

const API = process.env.E2E_API_URL || 'http://localhost:4000/api';

async function loginToken(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${API}/auth/login`, {
    data: { email, password: 'demo1234' },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

/** Find Warung Nusantara + one dish id over the public REST API. */
async function warungFixture(request: APIRequestContext) {
  const list = await (await request.get(`${API}/restaurants?q=Warung`)).json();
  const warung = list.items.find((r: any) => r.name === 'Warung Nusantara');
  expect(warung, 'seed fixture: Warung Nusantara').toBeTruthy();
  const detail = await (await request.get(`${API}/restaurants/${warung.id}`)).json();
  const dish = detail.menuItems.find((m: any) => m.name === 'Nasi Goreng Spesial');
  expect(dish, 'seed fixture: Nasi Goreng Spesial').toBeTruthy();
  return { restaurantId: warung.id as string, menuItemId: dish.id as string };
}

async function createOrder(
  request: APIRequestContext,
  fixture: { restaurantId: string; menuItemId: string },
  token?: string,
) {
  const res = await request.post(`${API}/orders`, {
    data: {
      restaurantId: fixture.restaurantId,
      items: [{ menuItemId: fixture.menuItemId, quantity: 1 }],
      customerName: 'Live Feed Tester',
      contactPhone: '081200003700',
      deliveryAddress: 'Jl. Merdeka No. 37, Jakarta',
    },
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string; code: string };
}

test('owner inbox follows the WebSocket feed — a new order lands in seconds', async ({
  page,
  request,
}) => {
  // UI login (also warms the token the WS handshake uses).
  await page.goto('/login?next=/dashboard');
  await page.locator('#email').fill('owner@foodorder.app');
  await page.locator('#password').fill('demo1234');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Restaurant dashboard' })).toBeVisible();

  // Pin a known restaurant. The switcher only exists once restaurants have
  // loaded (and switching re-subscribes the feed), so wait for it and for the
  // subtitle to confirm the switch before expecting the acked 'ws' transport.
  const switcher = page.locator('label:has-text("Restaurant") select');
  await expect(switcher).toBeVisible({ timeout: 10_000 });
  await switcher.selectOption({ label: 'Warung Nusantara' });
  await expect(page.getByText('Incoming orders for Warung Nusantara')).toBeVisible();
  const pill = page.locator('[data-feed-transport]');
  await expect(pill).toHaveAttribute('data-feed-transport', 'ws', { timeout: 10_000 });

  // Guest order via REST: the gateway fans it to room r:<warung> — the inbox
  // must show it (with the NEW badge) well under the 10s poll interval.
  const fx = await warungFixture(request);
  const order = await createOrder(request, fx);
  const card = page.locator(`[data-testid="inbox-card-${order.code}"]`);
  await expect(card).toBeVisible({ timeout: 5_000 });
  await expect(card.getByText('New')).toBeVisible();
  await expect(pill).toHaveAttribute('data-feed-transport', 'ws');
});

test('customer tracking page follows an owner status change over the feed', async ({
  page,
  request,
}) => {
  const customerToken = await loginToken(request, 'demo@foodorder.app');
  const ownerToken = await loginToken(request, 'owner@foodorder.app');
  const fx = await warungFixture(request);
  const order = await createOrder(request, fx, customerToken);

  // Signed-in via the UI so the tracking page's WS island can authenticate.
  await page.goto('/login');
  await page.locator('#email').fill('demo@foodorder.app');
  await page.locator('#password').fill('demo1234');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);

  await page.goto(`/orders/${order.id}`);
  await expect(page.getByRole('heading', { level: 1, name: `Order ${order.code} placed!` })).toBeVisible();
  const marker = page.locator('[data-feed-transport]');
  await expect(marker).toHaveAttribute('data-feed-transport', 'ws', { timeout: 10_000 });
  await expect(page.getByText('🕐 Pending — waiting for the restaurant to confirm')).toBeVisible();

  // Owner accepts over REST; the event goes to the customer's own WS room and
  // the page must re-render (router.refresh -> server GET) without any reload.
  const patch = await request.patch(
    `${API}/restaurants/${fx.restaurantId}/orders/${order.id}/status?status=confirmed`,
    { headers: { authorization: `Bearer ${ownerToken}` } },
  );
  expect(patch.status(), await patch.text()).toBe(200);

  await expect(page.getByText('✅ Confirmed by the restaurant')).toBeVisible({ timeout: 5_000 });
  await expect(marker).toHaveAttribute('data-feed-transport', 'ws');
});

test('dashboard falls back to the SSE stream when the WebSocket feed is down', async ({
  browser,
  request,
}) => {
  // A context where every WS construction throws: the feed hook can never
  // connect, so shouldOpenSse must open the fallback stream instead — and
  // push must still work end to end. (Prod build: nothing else on the page
  // touches WebSocket.)
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    const Broken = function () {
      throw new Error('WebSocket blocked by test');
    } as unknown as typeof WebSocket;
    window.WebSocket = Broken;
  });
  const page = await ctx.newPage();
  try {
    await page.goto('/login?next=/dashboard');
    await page.locator('#email').fill('owner@foodorder.app');
    await page.locator('#password').fill('demo1234');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Restaurant dashboard' }),
    ).toBeVisible();
    const switcher = page.locator('label:has-text("Restaurant") select');
    await expect(switcher).toBeVisible({ timeout: 10_000 });
    await switcher.selectOption({ label: 'Warung Nusantara' });
    await expect(page.getByText('Incoming orders for Warung Nusantara')).toBeVisible();

    // SSE (not WS) is the live transport, and polling stays idle behind it.
    const pill = page.locator('[data-feed-transport]');
    await expect(pill).toHaveAttribute('data-feed-transport', 'sse', { timeout: 15_000 });

    const fx = await warungFixture(request);
    const order = await createOrder(request, fx);
    const card = page.locator(`[data-testid="inbox-card-${order.code}"]`);
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(pill).toHaveAttribute('data-feed-transport', 'sse');
  } finally {
    await ctx.close();
  }
});
