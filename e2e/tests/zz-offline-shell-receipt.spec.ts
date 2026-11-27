import { expect, test } from '@playwright/test';
import { createOrder, warungFixture } from '../helpers/fixtures';

/**
 * Phase 16 #3 FULLY-offline receipt restore (session 141). zz-receipt-offline
 * covers the API-down-while-web-answers case (server branch); this is the
 * deeper case: `context.setOffline(true)` severs EVERY network path — the
 * browser cannot even reach the web server — and the service worker must
 * still surface the saved receipt for /orders/<id> URLs the device actually
 * viewed (lib/order-cache), behind the same honest banner, with ZERO server
 * round-trips (none are even possible).
 *
 * Locale honesty: the cached /offline shell HTML embeds the next-intl catalog
 * serialized at CACHE time (session-137 SSR-probe truth), and the shell slot
 * is single-entry — so each offline leg is preceded by an ONLINE visit to
 * /offline carrying that locale's cookie, which refreshes the slot (the
 * network-first shell branch re-caches the document).
 *
 * The service worker must be CONTROLLING before severing (install pre-caches
 * the shell + its referenced hashed chunks — the session-141 sw.js change),
 * and the receipt must have been persisted by a live view (ReceiptBody
 * `persist`) inside this same context, so the whole ladder rides ONE test.
 */

const CACHE_KEY = ['foodorder', 'receipts', 'v1'].join('.');
const SW_CACHE = 'foodorder-storefront-v2';

test('fully-offline receipt restore: the SW shell surfaces the device copy with zero round-trips', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(150_000);
  const fixture = await warungFixture(request);

  // Two guest orders: one gets a live receipt view (persisted), the other is
  // NEVER viewed — during the total outage it must fall back to the generic
  // offline card, never borrow the first order's rows.
  const viewed = await createOrder(request, fixture, {
    contactEmail: 'shell-view@example.com',
    customerName: 'Shell View',
  });
  const unviewed = await createOrder(request, fixture, {
    contactEmail: 'shell-unviewed@example.com',
    customerName: 'Shell Unviewed',
  });

  // --- 1. live view renders the receipt AND writes the device copy.
  await page.goto(
    `/orders/${viewed.id}?email=${encodeURIComponent('shell-view@example.com')}`,
  );
  await expect(page.getByText(viewed.code).first()).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ k, oid }) => JSON.parse(localStorage.getItem(k) ?? '{}')[oid]?.order?.code ?? 'none',
          { k: CACHE_KEY, oid: viewed.id },
        ),
      { timeout: 10_000 },
    )
    .toBe(viewed.code);

  // The worker must be controlling: install pre-caches the shell documents
  // and, since session 141, the hashed chunks they reference (the restore
  // island's own JS must be reachable with the network gone).
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), {
      timeout: 15_000,
    })
    .toBe(true);

  // Visit /offline online: refreshes the (EN) shell slot + warms the island's
  // chunk graph through the runtime path on top of the install pre-cache.
  await page.goto('/offline');
  await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible();
  await expect
    .poll(
      async () =>
        page.evaluate(async (name) => {
          const cache = await caches.open(name);
          return (await cache.match('/offline')) !== undefined;
        }, SW_CACHE),
      { timeout: 10_000 },
    )
    .toBe(true);

  // --- 2. sever EVERYTHING: the web server is as unreachable as the API.
  await context.setOffline(true);
  try {
    // Bare receipt URL (no email proof, no params — the server never sees it):
    // the saved copy surfaces behind the SAME banner as the API-down branch.
    await page.goto(`/orders/${viewed.id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="receipt-cached-banner"]')).toBeVisible();
    await expect(page.getByText('Showing a saved copy')).toBeVisible();
    await expect(page.getByText(viewed.code).first()).toBeVisible();
    await expect(page.getByText('Nasi Goreng Spesial')).toBeVisible();
    // generic card replaced (ONE receipt view on screen, never furniture pile-up):
    await expect(page.locator('[data-testid="offline-shell-card"]')).toHaveCount(0);
    // the live-API islands are GATED OFF (session-137 doctrine — a drop is not
    // a data failure), and no fetch was even attempted against a dead origin:
    await expect(page.locator('[data-testid="payment-panel"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="order-status-live"]')).toHaveCount(0);

    // Unviewed id: honest offline card, no borrow of the other order's rows.
    await page.goto(`/orders/${unviewed.id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="offline-shell-card"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible();
    await expect(page.locator('[data-testid="receipt-cached-banner"]')).toHaveCount(0);
    await expect(page.getByText(viewed.code)).toHaveCount(0);

    // A non-receipt URL is byte-identical to today's offline furniture.
    await page.goto('/restaurants', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="offline-shell-card"]')).toBeVisible();
    await expect(page.locator('[data-testid="receipt-cached-banner"]')).toHaveCount(0);
  } finally {
    await context.setOffline(false);
  }

  // --- 3. ID locale: refresh the shell slot in ID (the catalog rides the
  // cached document), THEN re-sever — the restored banner is localized.
  await context.addCookies([{ name: 'locale', value: 'id', url: 'http://localhost:3000' }]);
  await page.goto('/offline');
  await expect(page.getByRole('heading', { name: 'Anda sedang luring' })).toBeVisible();

  await context.setOffline(true);
  try {
    await page.goto(`/orders/${viewed.id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="receipt-cached-banner"]')).toBeVisible();
    await expect(page.getByText('Menampilkan salinan tersimpan')).toBeVisible();
    await expect(page.getByText('Coba tampilan live lagi')).toBeVisible();
    await expect(page.getByText(viewed.code).first()).toBeVisible();
  } finally {
    await context.setOffline(false);
    await context.clearCookies();
  }

  // --- 4. back online: the live server-rendered receipt takes over again.
  await page.goto(
    `/orders/${viewed.id}?email=${encodeURIComponent('shell-view@example.com')}`,
  );
  await expect(page.locator('[data-testid="receipt-cached-banner"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="payment-panel"]')).toBeVisible();
  await expect(page.getByText(viewed.code).first()).toBeVisible();
});
