import { expect, test, type APIRequestContext } from '@playwright/test';
import { API, createOrder, loginToken, signInUi, warungFixture } from '../helpers/fixtures';

/**
 * Phase 6 receipt ownership fix, end to end: the order uuid alone must NOT
 * render a receipt. The proof email stored at checkout (or a bearer for
 * owner/ADMIN) is what unlocks `GET /orders/:id`, and the storefront's
 * OrderVerify island is the fallback for links that lost their `?email=`.
 *
 * These tests create their OWN orders over the API (like live-feed does) —
 * no seed-state mutation, so they stay green across repeat runs.
 */

test('guest receipt: bare link verifies, wrong email stays 404-shaped, right email unlocks', async ({
  page,
  request,
}) => {
  const fx = await warungFixture(request);
  const order = await createOrder(request, fx, { contactEmail: 'guest-access@example.com' });

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
  const token = await loginToken(request, 'demo@foodorder.app');
  const fx = await warungFixture(request);
  const order = await createOrder(request, fx, { token, contactEmail: 'demo@foodorder.app' });

  await signInUi(page, 'demo@foodorder.app', { goto: '/login' });
  await expect(page).not.toHaveURL(/\/login/);

  await page.goto(`/orders/${order.id}`);
  await expect(
    page.getByRole('heading', { level: 1, name: `Order ${order.code} placed!` }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/email=demo%40foodorder.app/);
});
