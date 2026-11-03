import { expect, test } from '@playwright/test';

/** Owner portal: analytics plus direct-to-storage menu-image upload. */
test('owner can inspect analytics and upload a menu image', async ({ page }) => {
  await page.goto('/login?next=/dashboard/analytics');
  await page.locator('#email').fill('owner@foodorder.app');
  await page.locator('#password').fill(['demo', '1234'].join(''));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Restaurant analytics' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Analytics/ })).toHaveAttribute('aria-current', 'page');

  const switcher = page.getByLabel('Restaurant');
  await expect(switcher).toBeVisible();
  await switcher.selectOption({ label: 'Warung Nusantara' });

  await expect(page.getByTestId('analytics-gross-revenue')).toContainText('$73.00');
  await expect(page.getByTestId('analytics-completed-orders')).toContainText('3');
  await expect(page.getByTestId('analytics-busiest-hour')).toContainText('UTC');

  const breakdown = page.getByRole('table', { name: 'Completed orders by UTC hour' });
  await expect(breakdown).toBeVisible();
  await expect(breakdown.getByRole('row')).toHaveCount(25);
  await expect(breakdown.getByRole('columnheader', { name: 'UTC hour' })).toBeVisible();
  await expect(breakdown.getByRole('columnheader', { name: 'Completed orders' })).toBeVisible();

  let presignBody: any;
  let uploadedBody: Buffer | null = null;
  let patchedBody: any;
  const publicUrl = 'https://cdn.example.test/menu-items/dish/upload.webp';
  await page.route('**/api/menu/items/*/image-upload', async (route) => {
    presignBody = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        uploadUrl: 'https://uploads.example.test/menu-items/dish/upload.webp?signature=test',
        imageUrl: publicUrl,
        objectKey: 'menu-items/dish/upload.webp',
        requiredHeaders: { 'Content-Type': 'image/webp' },
        expiresAt: '2026-11-03T03:00:00.000Z',
      }),
    });
  });
  await page.route('https://uploads.example.test/**', async (route) => {
    expect(route.request().method()).toBe('PUT');
    expect(route.request().headers()['content-type']).toBe('image/webp');
    uploadedBody = route.request().postDataBuffer();
    await route.fulfill({ status: 200, body: '' });
  });
  await page.route('**/api/menu/items/*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    patchedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'dish',
        ...patchedBody,
        isAvailable: true,
        restaurantId: 'restaurant',
      }),
    });
  });

  await page.goto('/dashboard/menu');
  await page.getByRole('combobox', { name: 'Restaurant' }).selectOption({ label: 'Warung Nusantara' });
  const row = page.locator('[data-testid^="menu-row-"]', { hasText: 'Nasi Goreng Spesial' });
  await row.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog');
  const bytes = Buffer.from('fake-webp-image-bytes');
  await dialog.getByLabel('Image file').setInputFiles({
    name: 'dish.webp',
    mimeType: 'image/webp',
    buffer: bytes,
  });
  await dialog.getByRole('button', { name: 'Upload image' }).click();
  await expect(dialog.getByText('Image uploaded. Save changes to publish it.')).toBeVisible();
  await expect(dialog.getByLabel('Image URL')).toHaveValue(publicUrl);
  expect(presignBody).toEqual({ contentType: 'image/webp', sizeBytes: bytes.length });
  expect(uploadedBody?.equals(bytes)).toBe(true);

  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();
  expect(patchedBody.imageUrl).toBe(publicUrl);
});
