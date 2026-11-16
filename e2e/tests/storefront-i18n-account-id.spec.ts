import { expect, test, type Page } from '@playwright/test';

/**
 * Session 96 — storefront i18n sweep #4 (/favorites + /account chrome and
 * the shared FavoriteButton heart labels, plus the two new document
 * <title>s). Same doctrine as sweeps #1–#3: assert the LOCALIZED chrome in
 * an ID context (locale cookie), stay strictly read-only — nothing is
 * added/removed from favorites, no export is triggered, no delete form is
 * submitted (the export button would fire a real browser download and the
 * delete submit would consume the demo account). EN regression rides on
 * the untouched existing specs (account.spec, zz-gdpr-account,
 * empty-states, zz-forms-a11y) whose English pins the catalog values
 * reproduce byte-identically; only the brand-new EN titles are pinned here.
 */

const WEB = process.env.E2E_WEB_URL || 'http://localhost:3000';

async function idContext(page: Page) {
  await page.context().addCookies([{ name: 'locale', value: 'id', url: WEB }]);
}

async function signInId(page: Page, next: string) {
  await page.goto(`/login?next=${next}`);
  await page.getByLabel('Email', { exact: true }).fill('demo@foodorder.app');
  await page.getByLabel('Kata sandi', { exact: true }).fill('demo1234');
  // Session 95 rule: under the ID cookie the login CTA reads 'Masuk'.
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test('ID favorites: signed-out gate, localized title and CTA link', async ({ page }) => {
  await idContext(page);
  await page.goto('/favorites');
  await expect(page).toHaveTitle('Hidangan tersimpan — FoodOrder');
  await expect(page.getByRole('heading', { level: 1, name: 'Hidangan tersimpan' })).toBeVisible();
  await expect(page.getByText('Masuk untuk menyimpan hidangan.')).toBeVisible();
  await expect(
    page.getByText('Ketuk ikon hati pada menu apa pun dan hidangan akan menunggu Anda di sini.'),
  ).toBeVisible();
  // Localized suffix of the localized skeleton aria exists during load;
  // signed-out the gate CTA is the page's only main 'Masuk' link.
  await expect(page.getByRole('main').getByRole('link', { name: 'Masuk', exact: true })).toHaveAttribute(
    'href',
    '/login?next=%2Ffavorites',
  );
});

test('ID favorites: signed-in list renders localized meta line and heart labels', async ({
  page,
}) => {
  await idContext(page);
  await signInId(page, '%2Ffavorites');
  await expect(page).toHaveURL(/\/favorites$/);

  // Seeded hearts render through the localized row meta ('· disimpan <date>')
  // and the localized FavoriteButton aria (rows are favorites → 'Hapus dari
  // favorit'). Assertion-only: the heart and Add buttons are NEVER clicked.
  await expect(page.getByText(/· disimpan /).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hapus dari favorit' }).first()).toBeVisible();
});

test('ID account: signed-out gate with localized title', async ({ page }) => {
  await idContext(page);
  await page.goto('/account');
  await expect(page).toHaveTitle('Akun & privasi — FoodOrder');
  await expect(page.getByRole('heading', { level: 1, name: 'Akun & privasi' })).toBeVisible();
  await expect(page.getByText('Masuk untuk mengelola data Anda.')).toBeVisible();
  await expect(
    page.getByText('Ekspor semua data yang kami simpan tentang Anda, atau hapus akun Anda sepenuhnya.'),
  ).toBeVisible();
});

test('ID account: signed-in chrome — headings, identity line, both cards', async ({ page }) => {
  await idContext(page);
  await signInId(page, '%2Faccount');
  await expect(page).toHaveURL(/\/account$/);

  await expect(page.getByText('Masuk sebagai')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Unduh data Anda' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unduh data saya' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Hapus akun Anda' })).toBeVisible();
  await expect(page.getByLabel('Kata sandi saat ini', { exact: true })).toBeEditable();
  // The mono DELETE token stays the exact server phrase INSIDE the localized
  // label — accessible name 'Ketik DELETE untuk mengonfirmasi'.
  await expect(page.getByLabel(/Ketik DELETE untuk mengonfirmasi/)).toBeEditable();
  await expect(page.getByRole('button', { name: 'Hapus akun saya' })).toBeVisible();
});

test('ID account: the localized client guard fires before any request', async ({ page }) => {
  await idContext(page);
  await signInId(page, '%2Faccount');
  await expect(page).toHaveURL(/\/account$/);

  // Empty password submit is CLIENT-blocked (the DELETE endpoint is never
  // reached) — the localized pre-check answers instead. Nothing is deleted.
  await page.getByRole('button', { name: 'Hapus akun saya' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Masukkan kata sandi Anda saat ini.' }),
  ).toBeVisible();
  // Still signed in with the form intact.
  await expect(page.getByText('Masuk sebagai')).toBeVisible();
});

test('EN titles: the two new document titles render the pinned English strings', async ({
  page,
}) => {
  await page.goto('/favorites');
  await expect(page).toHaveTitle('Saved dishes — FoodOrder');
  await page.goto('/account');
  await expect(page).toHaveTitle('Account & privacy — FoodOrder');
});
