import { expect, test } from '@playwright/test';

const CART_KEY = ['foodorder', 'cart', 'v1'].join('.');

const CART_LINES = [
  {
    menuItemId: '00000000-0000-4000-8000-000000000099',
    name: 'Offline Nasi Goreng',
    priceCents: 1800,
    quantity: 2,
    restaurantId: '00000000-0000-4000-8000-000000000098',
    restaurantName: 'Cached Kitchen',
  },
];

test('storefront exposes install metadata and keeps a visited cart usable offline', async ({
  page,
  context,
  request,
}) => {
  const manifestResponse = await request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    name: 'FoodOrder',
    short_name: 'FoodOrder',
    start_url: '/',
    display: 'standalone',
  });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ src: '/icons/icon-192.png', sizes: '192x192' }),
      expect.objectContaining({ src: '/icons/icon-512.png', sizes: '512x512' }),
    ]),
  );

  await page.addInitScript(
    ({ key, lines }) => localStorage.setItem(key, JSON.stringify(lines)),
    { key: CART_KEY, lines: CART_LINES },
  );
  await page.goto('/cart');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible();
  await expect(page.getByText('Offline Nasi Goreng')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)))
    .toBe(true);

  // Let the controlling worker observe one full cart load, including the
  // route's hashed Next.js assets, before severing the network.
  await page.reload();
  await expect(page.getByText('Offline Nasi Goreng')).toBeVisible();

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible();
  await expect(page.getByText('Offline Nasi Goreng')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Cart changes stay on this device');
  await page.getByRole('button', { name: 'Increase quantity' }).click();
  await expect(page.getByText('$54.00')).toHaveCount(2);
});
