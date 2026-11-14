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

/**
 * Session 93 — the localization LEFTOVERS: portal document <title>s (route
 * layouts), /dashboard/menu + /dashboard/analytics chrome, the /orders/my
 * history chrome and the TrafficPanel internals + its code-split spinner.
 * Read-only throughout; no seeded state is touched.
 */

const PORTAL_TITLES: Array<[string, string, string]> = [
  ['/dashboard', 'Restaurant dashboard — FoodOrder', 'Dasbor restoran — FoodOrder'],
  ['/dashboard/kitchen', 'Kitchen display — FoodOrder', 'Tampilan dapur — FoodOrder'],
  ['/dashboard/menu', 'Menu manager — FoodOrder', 'Manajer menu — FoodOrder'],
  ['/dashboard/analytics', 'Restaurant analytics — FoodOrder', 'Analitik restoran — FoodOrder'],
  ['/driver', 'Driver deliveries — FoodOrder', 'Antaran kurir — FoodOrder'],
  ['/admin', 'Admin overview — FoodOrder', 'Ringkasan admin — FoodOrder'],
];

test('portal document titles are localized per locale (guest-safe: layouts own the metadata)', async ({
  page,
}) => {
  for (const [path, enTitle] of PORTAL_TITLES) {
    await page.goto(path);
    await expect(page).toHaveTitle(enTitle);
  }
  await useIndonesian(page);
  for (const [path, , idTitle] of PORTAL_TITLES) {
    await page.goto(path);
    await expect(page).toHaveTitle(idTitle);
  }
});

test('menu manager: chrome, rows and the dish dialog render in Indonesian', async ({ page }) => {
  await signIn(page, 'owner@foodorder.app');
  await useIndonesian(page);
  await page.goto('/dashboard/menu');
  await expect(page.getByRole('heading', { level: 1, name: 'Manajer menu' })).toBeVisible();
  // Pin the known restaurant (owner default is Seoul Street — live-feed doctrine).
  const switcher = page.getByLabel('Restoran');
  await expect(switcher).toBeVisible({ timeout: 10_000 });
  await switcher.selectOption({ label: 'Warung Nusantara' });
  await expect(page.getByText('Hidangan untuk Warung Nusantara')).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Tambah hidangan' })).toBeVisible();
  // Row action labels + the availability toggle title tooltip.
  await expect(page.getByRole('button', { name: 'Ubah', exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Sembunyikan' }).or(page.getByRole('button', { name: 'Tampilkan' })).first(),
  ).toBeVisible();
  // Dialog chrome opens and closes WITHOUT saving (read-only).
  await page.getByRole('button', { name: '+ Tambah hidangan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Tambah hidangan' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Nama *')).toBeVisible();
  await expect(dialog.getByText('Batasi unit yang dijual')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('analytics: summary cards and hourly table render in Indonesian', async ({ page }) => {
  await signIn(page, 'owner@foodorder.app');
  await useIndonesian(page);
  await page.goto('/dashboard/analytics');
  await expect(page.getByRole('heading', { level: 1, name: 'Analitik restoran' })).toBeVisible();
  await expect(page.getByTestId('analytics-gross-revenue')).toContainText('Pendapatan kotor');
  await expect(page.getByTestId('analytics-completed-orders')).toContainText('Pesanan selesai');
  await expect(page.getByTestId('analytics-busiest-hour')).toContainText('Jam tersibuk');
  await expect(page.getByRole('heading', { level: 2, name: 'Permintaan per jam' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Jam UTC' })).toBeVisible();
});

test('order history: tabs, rows and pagination render in Indonesian', async ({ page }) => {
  await signIn(page, 'demo@foodorder.app');
  await useIndonesian(page);
  await page.goto('/orders/my');
  await expect(page.getByRole('heading', { level: 1, name: 'Pesanan saya' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Semua' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Menunggu' })).toBeVisible();
  await expect(page.getByRole('button', { name: '↻ Muat ulang' })).toBeVisible();
  // The seeded history renders with localized link + tabpanel furniture.
  const card = page.locator('[data-testid^="order-card-"]').first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.getByRole('link', { name: 'Detail' })).toBeVisible();
  await expect(page.getByText(/Halaman 1 dari/)).toBeVisible();
});

test('admin traffic panel + skeleton labels render in Indonesian', async ({ page }) => {
  await signIn(page, 'admin@foodorder.app');
  await useIndonesian(page);
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/api/admin/metrics') && res.status() === 200),
    page.goto('/admin'),
  ]);
  expect(await response.json()).toHaveProperty('totals');
  await expect(page.getByRole('heading', { level: 2, name: 'Lalu lintas & anggaran error' })).toBeVisible();
  await expect(page.getByTestId('traffic-card-requests')).toContainText('kunci rute');
  await expect(page.getByTestId('traffic-card-budget')).toContainText('Anggaran error');
  await expect(page.getByTestId('traffic-route-table')).toBeVisible();
});
