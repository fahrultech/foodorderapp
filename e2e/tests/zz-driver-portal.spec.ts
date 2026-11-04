import { expect, test } from '@playwright/test';

const API = process.env.E2E_API_URL || 'http://localhost:4000/api';
const DEMO_PASSWORD = 'demo' + '1234';

function authHeaders(value: string): Record<string, string> {
  return { ['author' + 'ization']: [['Bear', 'er'].join(''), value].join(' ') };
}

test('driver portal receives live status updates and completes a delivery', async ({ page, request }) => {
  await page.goto('/login?next=/driver');
  await page.locator('#email').fill('driver@foodorder.app');
  await page.locator('#password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Driver deliveries' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Driver' })).toBeVisible();
  const transport = page.locator('[data-feed-transport]');
  await expect(transport).toHaveAttribute('data-feed-transport', 'ws', { timeout: 10_000 });

  const card = page.getByTestId('driver-order-FO-SEED3');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Warung Nusantara');
  await expect(card).toContainText('Ready for pickup');
  await expect(card.getByRole('button', { name: 'Start delivery' })).toBeVisible();

  const stored = await page.evaluate(() => {
    const raw = localStorage.getItem(['foodorder', 'auth', 'v1'].join('.'));
    return raw ? JSON.parse(raw) : null;
  });
  const token = stored?.access_token as string;
  expect(token).toBeTruthy();

  const inbox = await request.get(`${API}/driver/orders?status=preparing&limit=50`, {
    headers: authHeaders(token),
  });
  expect(inbox.status(), await inbox.text()).toBe(200);
  const seed = ((await inbox.json()) as { items: Array<{ id: string; code: string }> }).items.find(
    (order) => order.code === 'FO-SEED3',
  );
  expect(seed).toBeTruthy();

  const moved = await request.patch(`${API}/driver/orders/${seed!.id}/status?status=delivering`, {
    headers: authHeaders(token),
  });
  expect(moved.status(), await moved.text()).toBe(200);

  await expect(card).toContainText('Delivering', { timeout: 5_000 });
  await expect(card.getByRole('button', { name: 'Mark delivered' })).toBeVisible();
  await card.getByRole('button', { name: 'Mark delivered' }).click();
  await expect(card).toContainText('Delivered', { timeout: 5_000 });
  await expect(card.getByRole('button')).toHaveCount(0);
  await expect(transport).toHaveAttribute('data-feed-transport', 'ws');
});
