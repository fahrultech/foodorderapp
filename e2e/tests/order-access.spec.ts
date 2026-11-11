import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Phase 6 receipt ownership fix, end to end: the order uuid alone must NOT
 * render a receipt. The proof email stored at checkout (or a bearer for
 * owner/ADMIN) is what unlocks `GET /orders/:id`, and the storefront's
 * OrderVerify island is the fallback for links that lost their `?email=`.
 *
 * These tests create their OWN orders over the API (like live-feed does) —
 * no seed-state mutation, so they stay green across repeat runs.
 */

const API = process.env.E2E_API_URL || 'http://localhost:4000/api';

async function loginToken(request: APIRequestContext, email: string, password: string) {
  const res = await request.post(`${API}/auth/login`, { data: { email, password } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).access_token as string;
}

async function warungNasiGoreng(request: APIRequestContext) {
  const list = await (await request.get(`${API}/restaurants`)).json();
  const warung = list.items.find((r: any) => r.name === 'Warung Nusantara');
  expect(warung, 'seed fixture: Warung Nusantara').toBeTruthy();
  const detail = await (await request.get(`${API}/restaurants/${warung.id}`)).json();
  const dish = detail.menuItems.find((m: any) => m.name === 'Nasi Goreng Spesial');
  expect(dish, 'seed fixture: Nasi Goreng Spesial').toBeTruthy();
  return { restaurantId: warung.id as string, menuItemId: dish.id as string };
}

async function placeOrder(
  request: APIRequestContext,
  fx: { restaurantId: string; menuItemId: string },
  opts: { token?: string; contactEmail: string },
) {
  const res = await request.post(`${API}/orders`, {
    data: {
      restaurantId: fx.restaurantId,
      items: [{ menuItemId: fx.menuItemId, quantity: 1 }],
      customerName: 'Access E2E',
      contactPhone: '081200007600',
      deliveryAddress: 'Jl. Verification 76, Jakarta',
      contactEmail: opts.contactEmail,
    },
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string; code: string };
}

test('guest receipt: bare link verifies, wrong email stays 404-shaped, right email unlocks', async ({
  page,
  request,
}) => {
  const fx = await warungNasiGoreng(request);
  const order = await placeOrder(request, fx, { contactEmail: 'guest-access@example.com' });

  await page.goto(`/orders/${order.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Order not found' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Is this your order?' })).toBeVisible();

  await page.locator('#order-verify-email').fill('wrong@example.com');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByTestId('order-verify-failed')).toBeVisible();
  await expect(page).not.toHaveURL(/email=/);

  await page.locator('#order-verify-email').fill('GUEST-ACCESS@example.com');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page).toHaveURL(/\?email=/);
  await expect(
    page.getByRole('heading', { level: 1, name: `Order ${order.code} placed!` }),
  ).toBeVisible();
});

test('signed-in customer opening the BARE receipt link is auto-unlocked via the bearer rung', async ({
  page,
  request,
}) => {
  const token = await loginToken(request, 'demo@foodorder.app', 'demo1234');
  const fx = await warungNasiGoreng(request);
  const order = await placeOrder(request, fx, { token, contactEmail: 'demo@foodorder.app' });

  await page.goto('/login');
  await page.locator('#email').fill('demo@foodorder.app');
  await page.locator('#password').fill('demo1234');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);

  await page.goto(`/orders/${order.id}`);
  await expect(
    page.getByRole('heading', { level: 1, name: `Order ${order.code} placed!` }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/email=demo%40foodorder.app/);
});
