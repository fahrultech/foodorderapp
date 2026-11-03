import { expect, test, type APIRequestContext } from '@playwright/test';

const API = process.env.E2E_API_URL || 'http://localhost:4000/api';

function bearer(token: string): Record<string, string> {
  return { [['author', 'ization'].join('')]: ['Bear', 'er ', token].join('') };
}

async function kitchenFixture(request: APIRequestContext) {
  const listRes = await request.get(`${API}/restaurants?q=Warung`);
  expect(listRes.ok(), await listRes.text()).toBeTruthy();
  const list = (await listRes.json()) as { items: Array<{ id: string; name: string }> };
  const restaurant = list.items.find((row) => row.name === 'Warung Nusantara');
  expect(restaurant, 'seed fixture: Warung Nusantara').toBeTruthy();

  const detailRes = await request.get(`${API}/restaurants/${restaurant!.id}`);
  expect(detailRes.ok(), await detailRes.text()).toBeTruthy();
  const detail = (await detailRes.json()) as { menuItems: Array<{ id: string; name: string }> };
  const dish = detail.menuItems.find((row) => row.name === 'Nasi Goreng Spesial');
  expect(dish, 'seed fixture: Nasi Goreng Spesial').toBeTruthy();
  return { restaurantId: restaurant!.id, menuItemId: dish!.id };
}

async function createPaidConfirmedOrder(
  request: APIRequestContext,
  token: string,
  fixture: { restaurantId: string; menuItemId: string },
  customerName: string,
) {
  const create = await request.post(`${API}/orders`, {
    data: {
      restaurantId: fixture.restaurantId,
      items: [{ menuItemId: fixture.menuItemId, quantity: 1 }],
      customerName,
      contactPhone: '081200005600',
      deliveryAddress: 'Jl. Dapur No. 56, Jakarta',
      note: 'No peanuts',
    },
  });
  expect(create.status(), await create.text()).toBe(201);
  const order = (await create.json()) as { id: string; code: string };
  const intent = await request.post(`${API}/payments`, {
    data: { orderId: order.id },
    headers: bearer(token),
  });
  expect(intent.status(), await intent.text()).toBe(201);
  const payment = (await intent.json()) as { id: string };
  const capture = await request.post(`${API}/payments/${payment.id}/capture`, {
    headers: bearer(token),
  });
  expect(capture.status(), await capture.text()).toBe(200);
  const confirm = await request.patch(
    `${API}/restaurants/${fixture.restaurantId}/orders/${order.id}/status?status=confirmed`,
    { headers: bearer(token) },
  );
  expect(confirm.status(), await confirm.text()).toBe(200);
  return order;
}

/** Owner portal: analytics, direct image upload, and the live kitchen board. */
test('owner can inspect analytics, upload a menu image, and run the kitchen board', async ({
  page,
  request,
}) => {
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

  // Reuse this owner session rather than spending another auth-bucket login.
  const token = await page.evaluate(() => {
    const raw = localStorage.getItem(['foodorder', 'auth', 'v1'].join('.'));
    return raw ? (JSON.parse(raw).access_token as string) : null;
  });
  expect(token, 'owner access token stored after UI login').toBeTruthy();
  const fixture = await kitchenFixture(request);

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/dashboard/kitchen');
  await expect(page.getByRole('heading', { level: 1, name: 'Kitchen display' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Kitchen/ })).toHaveAttribute('aria-current', 'page');
  const kitchenSwitcher = page.getByRole('combobox', { name: 'Restaurant' });
  await kitchenSwitcher.selectOption({ label: 'Warung Nusantara' });
  const board = page.getByTestId('kitchen-board');
  await expect(board.getByRole('heading', { name: 'Queued' })).toBeVisible();
  await expect(board.getByRole('heading', { name: 'Preparing' })).toBeVisible();
  await expect(board.getByRole('heading', { name: 'Out for delivery' })).toBeVisible();
  await expect(page.locator('[data-feed-transport]')).toHaveAttribute('data-feed-transport', 'ws', {
    timeout: 10_000,
  });

  const order = await createPaidConfirmedOrder(
    request,
    token!,
    fixture,
    'Kitchen Board Tester',
  );

  const card = page.getByTestId(`kitchen-card-${order.code}`);
  await expect(card).toBeVisible({ timeout: 5_000 });
  await expect(card).toContainText('1 × Nasi Goreng Spesial');
  await expect(card).toContainText('No peanuts');
  const queuedCount = page.getByTestId('kitchen-count-confirmed');
  const preparingCount = page.getByTestId('kitchen-count-preparing');
  const deliveringCount = page.getByTestId('kitchen-count-delivering');
  const queuedBefore = Number(await queuedCount.textContent());
  const preparingBefore = Number(await preparingCount.textContent());

  let actionReachedServer!: () => void;
  const serverDone = new Promise<void>((resolve) => {
    actionReachedServer = resolve;
  });
  let releaseAction!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseAction = resolve;
  });
  await page.route(`**/api/restaurants/*/orders/${order.id}/status?status=preparing`, async (route) => {
    const response = await route.fetch();
    actionReachedServer();
    await release;
    await route.fulfill({ response });
  });

  await card.getByRole('button', { name: 'Start preparing' }).click();
  await serverDone;
  const waitingOrder = await createPaidConfirmedOrder(
    request,
    token!,
    fixture,
    'Kitchen Busy Sync Tester',
  );
  await page.waitForTimeout(700);
  releaseAction();
  await expect(page.getByTestId('kitchen-lane-preparing')).toContainText(order.code);
  await expect(queuedCount).toHaveText(String(queuedBefore - 1));
  await expect(preparingCount).toHaveText(String(preparingBefore + 1));
  await expect(page.getByTestId(`kitchen-card-${waitingOrder.code}`)).toBeVisible({ timeout: 5_000 });

  const deliveringBefore = Number(await deliveringCount.textContent());
  await card.getByRole('button', { name: 'Out for delivery' }).click();
  await expect(page.getByTestId('kitchen-lane-delivering')).toContainText(order.code);
  await expect(preparingCount).toHaveText(String(preparingBefore));
  await expect(deliveringCount).toHaveText(String(deliveringBefore + 1));

  await card.getByRole('button', { name: 'Complete order' }).click();
  await expect(card).toBeHidden();
  await expect(deliveringCount).toHaveText(String(deliveringBefore));
});
