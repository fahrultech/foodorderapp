import { expect, Page, test } from '@playwright/test';

/**
 * Session 92 — portal CHROME localization (EN/ID) across dashboard,
 * kitchen, driver and admin (session 91 shipped the state furniture; this
 * proves the page titles, gate cards, action labels and transport pills).
 *
 * Read-only by design: the driver card comes from a `page.route`
 * interception (a synthetic preparing order — labels are the only thing
 * under test), and nothing here advances or creates state, so the later
 * `zz-driver-portal` spec still finds FO-SEED3 untouched.
 *
 * Sign in happens BEFORE the locale flip (the login page is English
 * chrome) — same pattern as portal-states.spec.ts.
 */

const DEMO_PASSWORD = 'demo' + '1234';

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function useIndonesian(page: Page) {
  await page.context().addCookies([
    {
      name: 'locale',
      value: 'id',
      url: process.env.E2E_WEB_URL || 'http://localhost:3000',
    },
  ]);
}

test('dashboard: guest gate card + signed-in chrome render in Indonesian', async ({ page }) => {
  await useIndonesian(page);
  await page.goto('/dashboard');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Masuk untuk membuka portal restoran Anda' }),
  ).toBeVisible();
  // The localized header also carries a 'Masuk' link — pin the gate CTA by href.
  await expect(page.locator('a[href="/login?next=/dashboard"]')).toHaveText('Masuk');

  await signIn(page, 'owner@foodorder.app');
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1, name: 'Dasbor restoran' })).toBeVisible();
  // The owner has two seeded restaurants; pin a known one (same doctrine as
  // live-feed.spec.ts) so the subtitle is deterministic.
  const switcher = page.locator('label select');
  await expect(switcher).toBeVisible({ timeout: 10_000 });
  await switcher.selectOption({ label: 'Warung Nusantara' });
  await expect(page.getByText('Pesanan masuk untuk Warung Nusantara')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Semua' })).toBeVisible();
  await expect(page.getByRole('button', { name: '↻ Muat ulang' })).toBeVisible();
  // PortalTabs nav shared with the dashboard.
  await expect(page.getByRole('link', { name: '📥 Pesanan' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Dapur/ })).toBeVisible();
});

test('kitchen: board title and lane headers render in Indonesian', async ({ page }) => {
  await signIn(page, 'owner@foodorder.app');
  await useIndonesian(page);
  await page.goto('/dashboard/kitchen');
  await expect(page.getByRole('heading', { level: 1, name: 'Tampilan dapur' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Antrean' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Sedang disiapkan' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Diantar' })).toBeVisible();
  await expect(page.getByRole('button', { name: '↻ Muat ulang' })).toBeVisible();
});

test('driver: inbox chrome + card labels + action button render in Indonesian (intercepted order)', async ({
  page,
}) => {
  await signIn(page, 'driver@foodorder.app');
  await useIndonesian(page);

  const syntheticOrder = {
    id: '00000000-0000-4000-8000-000000000092',
    code: 'FO-CHROMEID',
    status: 'preparing',
    createdAt: new Date().toISOString(),
    customerName: 'Indah Permata',
    deliveryAddress: 'Jl. Contoh No. 92, Jakarta',
    contactPhone: '0812-000-0092',
    note: 'Tanpa sambal',
    restaurant: { id: '00000000-0000-4000-8000-000000000001', name: 'Warung Nusantara' },
    items: [{ id: '00000000-0000-4000-8000-000000000011', name: 'Nasi Goreng', quantity: 1 }],
  };
  await page.route('**/api/driver/orders**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [syntheticOrder], total: 1, page: 1, limit: 50 }),
    }),
  );

  await page.goto('/driver');
  await expect(page.getByRole('heading', { level: 1, name: 'Antaran kurir' })).toBeVisible();
  await expect(page.getByText('Penjemputan dan pengantaran yang ditugaskan')).toBeVisible();
  // Status pill + card furniture + the one action label under test.
  await expect(page.getByText('Siap diambil')).toBeVisible();
  await expect(page.getByText('Tujuan')).toBeVisible();
  await expect(page.getByText('Catatan: Tanpa sambal')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mulai antar' })).toBeVisible();
  await page.unroute('**/api/driver/orders**');
});

test('admin: overview tables and gate chrome render in Indonesian', async ({ page }) => {
  await useIndonesian(page);
  await page.goto('/admin');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Akses admin diperlukan' }),
  ).toBeVisible();

  await signIn(page, 'admin@foodorder.app');
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: 'Ringkasan admin' })).toBeVisible();
  await expect(page.getByText('Operasi platform')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Pengguna terbaru' })).toBeVisible();
  // Users table header row + Orders table headers.
  await expect(page.getByRole('columnheader', { name: 'Bergabung' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Dibuat' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Muat ulang', exact: true })).toBeVisible();
});
