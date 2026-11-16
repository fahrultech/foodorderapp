import { expect, test, type Page } from '@playwright/test';

/**
 * Session 95 — storefront i18n sweep #3 (login, register, addresses book,
 * and the document <title>s of login/register/addresses/checkout/receipt).
 * Same doctrine as the portal/storefront sweeps before it: assert the
 * LOCALIZED chrome in an ID context (locale cookie), stay read-only — no
 * account is created here, no order is placed, no seed-state counter is
 * touched. EN regression is covered by the untouched existing specs; the EN
 * message values are byte-pinned against them (plus one EN title test here,
 * the titles being brand-new surfaces nothing else pins).
 */

const WEB = process.env.E2E_WEB_URL || 'http://localhost:3000';

async function idContext(page: Page) {
  await page.context().addCookies([{ name: 'locale', value: 'id', url: WEB }]);
}

test('ID login: localized chrome, labels and CTA; the localized document title', async ({
  page,
}) => {
  await idContext(page);
  await page.goto('/login');
  await expect(page).toHaveTitle('Masuk — FoodOrder');
  await expect(page.getByRole('heading', { level: 1, name: 'Masuk' })).toBeVisible();
  await expect(page.getByText('Pesan lebih cepat: nama dan riwayat Anda tersimpan di akun.')).toBeVisible();
  await expect(page.getByLabel('Email', { exact: true })).toBeEditable();
  await expect(page.getByLabel('Kata sandi', { exact: true })).toBeEditable();
  // Header also shows a 'Masuk' LINK signed-out — pin the form CTA by role+exact.
  await expect(page.getByRole('button', { name: 'Masuk', exact: true })).toBeVisible();
  await expect(page.getByText('Belum punya akun?')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Buat akun' })).toBeVisible();
  await expect(page.getByText('Login demo:')).toBeVisible();
});

test('ID register: localized chrome, placeholders, and inline validation messages', async ({
  page,
}) => {
  await idContext(page);
  await page.goto('/register');
  await expect(page).toHaveTitle('Buat akun — FoodOrder');
  await expect(page.getByRole('heading', { level: 1, name: 'Buat akun Anda' })).toBeVisible();
  await expect(page.getByText('Hanya butuh beberapa detik — Anda akan langsung masuk.')).toBeVisible();
  for (const label of [
    'Nama',
    'Email',
    'Kata sandi',
    'Konfirmasi kata sandi',
    // '(opsional)' spans are PART of the accessible name (session 81 pin).
    'Telepon (opsional)',
    'Alamat pengiriman (opsional)',
  ]) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByPlaceholder('min. 8 karakter')).toBeVisible();
  await expect(page.getByPlaceholder('ulangi')).toBeVisible();
  await expect(page.getByPlaceholder('Budi Santoso')).toBeVisible();

  // Broken fields answer the LOCALIZED inline alerts; the submit is
  // client-blocked, so nothing is created (read-only like the rest here).
  await page.getByLabel('Nama', { exact: true }).fill('A');
  await page.getByLabel('Email', { exact: true }).fill('bukan-email');
  await page.getByLabel('Kata sandi', { exact: true }).fill('pendek');
  await page.getByLabel('Konfirmasi kata sandi', { exact: true }).fill('lain');
  await page.getByRole('button', { name: 'Buat akun', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Nama harus 2–120 karakter.' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Masukkan alamat email yang valid.' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Kata sandi minimal 8 karakter.' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Kata sandi tidak cocok.' })).toBeVisible();
  // Focus-first-invalid still lands on the name field under ID chrome.
  await expect(page.getByLabel('Nama', { exact: true })).toBeFocused();

  await expect(page.getByText('Sudah punya akun?')).toBeVisible();
});

test('ID addresses: signed-out gate and signed-in book chrome, localized title', async ({
  page,
}) => {
  await idContext(page);
  await page.goto('/addresses');
  await expect(page).toHaveTitle('Alamat pengiriman — FoodOrder');
  await expect(page.getByRole('heading', { level: 1, name: 'Alamat pengiriman' })).toBeVisible();
  await expect(page.getByText('Masuk untuk menyimpan alamat.')).toBeVisible();
  await expect(
    page.getByText('Simpan rumah, kantor, dan semua titik kirim lain dalam satu sentuhan saat checkout.'),
  ).toBeVisible();

  // Sign in through the ID login surface, then the real (seeded) book.
  await page.goto('/login?next=%2Faddresses');
  await page.getByLabel('Email', { exact: true }).fill('demo@foodorder.app');
  await page.getByLabel('Kata sandi', { exact: true }).fill('demo1234');
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page).toHaveURL(/\/addresses$/);

  await expect(page.getByRole('button', { name: 'Tambah alamat' })).toBeVisible();
  await expect(
    page.getByText('Alamat tersimpan mempercepat checkout — yang ditandai utama dipilih otomatis'),
  ).toBeVisible();
  // Seeded book: the default row carries the localized badge. exact:true
  // because a string getByText is a CASE-INSENSITIVE substring match — the
  // page hint ('...ditandai utama...') and 'Jadikan utama' otherwise collide.
  await expect(page.getByText('Utama', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ubah' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hapus' }).first()).toBeVisible();
});

test('ID checkout + bare receipt routes carry the localized document titles', async ({
  page,
}) => {
  await idContext(page);
  await page.goto('/checkout');
  await expect(page).toHaveTitle('Checkout — FoodOrder');
  // The layout owns the title even while the SSR receipt read 404s and the
  // OrderVerify island offers the unlock paths (no order is needed).
  await page.goto('/orders/00000000-0000-4000-8000-000000000095');
  await expect(page).toHaveTitle('Pesanan — FoodOrder');
  await expect(page.getByRole('heading', { level: 1, name: 'Pesanan tidak ditemukan' })).toBeVisible();
});

test('EN titles: the five new document titles render the pinned English strings', async ({
  page,
}) => {
  await page.goto('/login');
  await expect(page).toHaveTitle('Sign in — FoodOrder');
  await page.goto('/register');
  await expect(page).toHaveTitle('Create account — FoodOrder');
  await page.goto('/addresses');
  await expect(page).toHaveTitle('Delivery addresses — FoodOrder');
  await page.goto('/checkout');
  await expect(page).toHaveTitle('Checkout — FoodOrder');
  await page.goto('/orders/00000000-0000-4000-8000-000000000095');
  await expect(page).toHaveTitle('Order — FoodOrder');
});
