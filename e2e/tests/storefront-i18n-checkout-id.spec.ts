import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Session 94 — storefront i18n sweep #2 (checkout / cart / receipt) ID proof.
 * Mirrors the doctrine of the portal sweeps: assert the LOCALIZED chrome in
 * an ID context (locale cookie), create own orders over the API only (no
 * seed-state mutation, no submit from the browser), and never depend on
 * absolute seed counters. EN regression is covered by the untouched existing
 * specs — every EN message value is byte-pinned against them.
 */

const API = process.env.E2E_API_URL || 'http://localhost:4000/api';
const WEB = process.env.E2E_WEB_URL || 'http://localhost:3000';

async function idContext(page: import('@playwright/test').Page) {
  await page.context().addCookies([{ name: 'locale', value: 'id', url: WEB }]);
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

test('ID cart + checkout chrome: every label, hint, summary row and CTA is Indonesian', async ({
  page,
}) => {
  await idContext(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Warung Nusantara/ }).first().click();
  // Pin the row to Nasi Goreng ($18.00 — clears the seeded $10 minimum).
  const row = page
    .locator('div.divide-y > div', {
      has: page.getByRole('heading', { level: 3, name: 'Nasi Goreng Spesial' }),
    })
    .first();
  await row.getByRole('button', { name: 'Tambah', exact: true }).click();

  await page.getByRole('link', { name: /Keranjang/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Keranjang Anda' })).toBeVisible();
  await expect(page.getByText('Dari Warung Nusantara')).toBeVisible();
  await expect(page.getByText('$18.00 per porsi')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kurangi jumlah' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tambah jumlah' })).toBeVisible();
  // The shared 'Subtotal' word + the localized fee note, same DOM shape as EN.
  await expect(page.getByText('Subtotal').locator('..')).toContainText(
    'ongkir ditambahkan saat checkout',
  );
  await expect(page.getByRole('button', { name: 'Kosongkan keranjang' })).toBeVisible();

  await page.getByRole('link', { name: /Checkout/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeVisible();
  for (const label of [
    'Nama Anda',
    'Telepon',
    'Email kontak',
    'Alamat pengiriman',
    'Catatan untuk restoran',
    'Kode promo',
  ]) {
    await expect(page.getByLabel(label)).toBeVisible();
  }
  // Localized placeholders + the receipt-proof email hint.
  await expect(page.getByPlaceholder('Budi Santoso')).toBeVisible();
  await expect(page.getByPlaceholder('mis. tanpa cabai, kode gerbang 1234')).toBeVisible();
  await expect(page.getByText('Menjaga halaman struk tetap milik Anda')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Ringkasan pesanan' })).toBeVisible();
  await expect(page.getByText('Ongkir', { exact: true })).toBeVisible();
  // Live server pricing under the ID chrome: $18 + $3 fee, above the minimum.
  await expect(page.getByRole('button', { name: 'Buat pesanan — $21.00' })).toBeEnabled();
});

test('ID receipt: header, status pill, timeline, payment card and footer are Indonesian', async ({
  page,
  request,
}) => {
  const fx = await warungNasiGoreng(request);
  const res = await request.post(`${API}/orders`, {
    data: {
      restaurantId: fx.restaurantId,
      items: [{ menuItemId: fx.menuItemId, quantity: 1 }],
      customerName: 'I18N ID E2E',
      contactPhone: '081200009400',
      deliveryAddress: 'Jl. Terjemahan 94, Jakarta',
      contactEmail: 'i18n-id-e2e@example.com',
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const order = (await res.json()) as { id: string; code: string };

  await idContext(page);
  await page.goto(
    `/orders/${order.id}?code=${order.code}&email=${encodeURIComponent('i18n-id-e2e@example.com')}`,
  );
  await expect(
    page.getByRole('heading', { level: 1, name: `Pesanan ${order.code} dibuat!` }),
  ).toBeVisible();
  await expect(
    page.getByText('🕐 Menunggu — menunggu konfirmasi restoran'),
  ).toBeVisible();
  await expect(page.getByText('Nomor referensi:')).toBeVisible();

  await expect(page.getByRole('heading', { level: 2, name: 'Progres pesanan' })).toBeVisible();
  await expect(page.getByText('Pesanan dikirim ke restoran')).toBeVisible();
  await expect(page.getByText('Diterima oleh restoran')).toBeVisible();
  await expect(page.getByText('menunggu…')).toBeVisible();

  await expect(page.getByRole('heading', { level: 2, name: 'Pembayaran' })).toBeVisible();
  const hint = page.getByTestId('payment-signin-hint');
  await expect(hint).toBeVisible();
  await expect(hint.getByRole('link', { name: 'Masuk' })).toBeVisible();
  await expect(hint).toContainText('untuk membayar pesanan ini');

  await expect(page.getByRole('heading', { level: 2, name: 'Hidangan' })).toBeVisible();
  await expect(page.getByText('1 × Nasi Goreng Spesial')).toBeVisible();
  await expect(page.getByText('Diantar ke:').locator('..')).toContainText(
    'Jl. Terjemahan 94, Jakarta',
  );
  await expect(page.getByText('Kontak:').locator('..')).toContainText('I18N ID E2E');
  await expect(page.getByRole('link', { name: '← Pesan makanan lagi' })).toBeVisible();
});

test('ID OrderVerify island on an unknown order: localized denial path', async ({ page }) => {
  await idContext(page);
  // A syntactically valid uuid that exists nowhere: the SSR read 404s.
  await page.goto('/orders/00000000-0000-4000-8000-000000000094');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Pesanan tidak ditemukan' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Ini pesanan Anda?' })).toBeVisible();
  await page.locator('#order-verify-email').fill('entah@example.com');
  await page.getByRole('button', { name: 'Buka', exact: true }).click();
  await expect(page.getByTestId('order-verify-failed')).toHaveText(
    'Tidak ada yang terbuka — email salah, atau tidak ada pesanan dengan kombinasi itu.',
  );
  await expect(page.getByRole('link', { name: '← Kembali ke restoran' })).toBeVisible();
});
