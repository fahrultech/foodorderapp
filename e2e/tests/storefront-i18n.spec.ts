import { expect, test } from '@playwright/test';

test('storefront switches between English and Indonesian and persists the choice', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Order from local restaurants' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Bahasa Indonesia' }).click();

  await expect(page.locator('html')).toHaveAttribute('lang', 'id');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Pesan dari restoran lokal' }),
  ).toBeVisible();
  await expect(page.getByPlaceholder('Cari restoran atau hidangan…')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Keranjang' })).toBeVisible();

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'id');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Pesan dari restoran lokal' }),
  ).toBeVisible();

  await page.getByRole('link', { name: /Warung Nusantara/ }).first().click();
  await expect(page.getByRole('link', { name: '← Semua restoran' })).toBeVisible();
  await expect(page.getByPlaceholder('Cari menu — hidangan, deskripsi, kategori…')).toBeVisible();
  await expect(page.getByText('5 hidangan', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('link', { name: '← All restaurants' })).toBeVisible();
  await expect(page.getByText('5 dishes', { exact: true })).toBeVisible();
});
