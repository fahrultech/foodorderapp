import { expect, test, type APIRequestContext } from '@playwright/test';
import { execSync, spawn } from 'child_process';
import * as path from 'path';
import { API, createOrder, timed, warungFixture } from '../helpers/fixtures';

/**
 * Phase 15 receipt offline resilience (session 137): a successfully viewed
 * receipt persists per-id in localStorage (ReceiptBody `persist`), and when
 * the API is DOWN the receipt route's server branch hands the page to
 * CachedReceiptFallback — the SAME view restored from the device under an
 * honest "saved copy" banner, never the not-found lie and never the live-API
 * islands (payment rows, live feed, rating) which would only be able to
 * answer with failure cards.
 *
 * Offline emulation is the REAL thing: the config-booted API is SIGTERMed for
 * the down legs and re-spawned with the webServer's exact env in `finally`
 * (Playwright only probes webServers at suite start, so the suite survives;
 * every later spec gets a healthy API — this file's zz-rank keeps it after
 * all seed-absolute counting specs anyway).
 *
 * localStorage survives within ONE browser context, so the whole ladder rides
 * one test: live view -> persist -> kill -> restore -> unviewed-id guard ->
 * corrupt guard -> restart -> live again -> 4xx byte-identity.
 */

const CACHE_KEY = ['foodorder', 'receipts', 'v1'].join('.');
const API_DIR = path.join(__dirname, '..', '..', 'apps', 'api');

async function apiUp(request: APIRequestContext): Promise<boolean> {
  try {
    const res = await request.get(`${API}/health`);
    return res.ok();
  } catch {
    return false;
  }
}

test('receipt offline resilience: live view persists, API-drop restores it with the honest banner', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(180_000); // the kill + cold restart legs dominate
  const fixture = await warungFixture(request);

  // Two guest orders: one gets viewed (cached), one stays UNviewed — during
  // the drop it must NOT borrow the first order's copy (per-id guard).
  const viewed = await createOrder(request, fixture, {
    contactEmail: 'cache-view@example.com',
    customerName: 'Cache View',
  });
  const unviewed = await createOrder(request, fixture, {
    contactEmail: 'cache-unviewed@example.com',
    customerName: 'Cache Unviewed',
  });
  const url = (id: string, email: string) =>
    `/orders/${id}?email=${encodeURIComponent(email)}`;

  // --- 1. live view renders normally AND writes the device copy
  await page.goto(url(viewed.id, 'cache-view@example.com'));
  await expect(page.getByText(viewed.code).first()).toBeVisible();
  await expect(page.locator('[data-testid="payment-panel"]')).toBeVisible();
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

  // --- 2. sever the API (real network drop for the data path)
  await timed('kill-api', async () => {
    execSync('pkill -f "node dist/main[.]js" || true');
    await expect
      .poll(async () => !(await apiUp(request)), { timeout: 20_000 })
      .toBe(true);
  });

  try {
    // unviewed order during the drop: honest offline card, no borrow, and
    // NOT the not-found lie either (downness is not absence).
    await page.goto(url(unviewed.id, 'cache-unviewed@example.com'));
    await expect(page.locator('[data-testid="api-offline"]')).toBeVisible();
    await expect(page.locator('[data-testid="receipt-cached-banner"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="order-verify-email"]')).toHaveCount(0);

    // viewed order during the drop: the SAME receipt restored from the device.
    await page.goto(url(viewed.id, 'cache-view@example.com'));
    await expect(page.locator('[data-testid="receipt-cached-banner"]')).toBeVisible();
    await expect(page.getByText(viewed.code).first()).toBeVisible();
    await expect(page.getByText('Showing a saved copy')).toBeVisible();
    await expect(page.getByText('Nasi Goreng Spesial')).toBeVisible();
    // ID locale rides the same island (session-92 provider doctrine):
    await context.addCookies([{ name: 'locale', value: 'id', url: 'http://localhost:3000' }]);
    await page.goto(url(viewed.id, 'cache-view@example.com'));
    await expect(page.getByText('Menampilkan salinan tersimpan')).toBeVisible();
    await expect(page.getByText('Coba tampilan live lagi')).toBeVisible();
    await context.clearCookies();
    await page.goto(url(viewed.id, 'cache-view@example.com'));
    await expect(page.getByText('Showing a saved copy')).toBeVisible();
    // the live-API islands are GATED OFF, not erroring:
    await expect(page.locator('[data-testid="payment-panel"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="order-status-live"]')).toHaveCount(0);
    // and the 4xx not-found card never rides on a DOWN answer:
    await expect(page.locator('[data-testid="order-verify-email"]')).toHaveCount(0);

    // unknown uuid while the API is down: island path, but NO cached copy
    // exists for it -> offline card, never another order's rows:
    await page.goto('/orders/00000000-dead-4000-8000-000000000000?email=none@example.com');
    await expect(page.locator('[data-testid="api-offline"]')).toBeVisible();
    await expect(page.locator('[data-testid="receipt-cached-banner"]')).toHaveCount(0);

    // corrupt-copy guard: a stored entry without a valid order shape is
    // dropped, never rendered.
    await page.evaluate(
      ({ k, oid }) => localStorage.setItem(k, JSON.stringify({ [oid]: { savedAt: 'x' } })),
      { k: CACHE_KEY, oid: viewed.id },
    );
    await page.goto(url(viewed.id, 'cache-view@example.com'));
    await expect(page.locator('[data-testid="api-offline"]')).toBeVisible();
    await expect(page.locator('[data-testid="receipt-cached-banner"]')).toHaveCount(0);
  } finally {
    // --- 3. bring the API back with the webServer's exact boot env
    await timed('restart-api', async () => {
      const child = spawn('node', ['dist/main.js'], {
        cwd: API_DIR,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          RATE_LIMIT_AUTH_MAX: '100',
          RATE_LIMIT_PAYMENTS_MAX: '100',
          HTTP_CACHE_TTL_SEC: '0',
        },
      });
      child.unref();
      await expect
        .poll(async () => await apiUp(request), { timeout: 40_000, interval: 1000 })
        .toBe(true);
    });
  }

  // --- 4. live again: server branch takes over, banner gone, islands return,
  // and the fresh read RE-PERSISTS a valid copy (overwrite path).
  await page.goto(url(viewed.id, 'cache-view@example.com'));
  await expect(page.locator('[data-testid="receipt-cached-banner"]')).toHaveCount(0);
  await expect(page.getByText(viewed.code).first()).toBeVisible();
  await expect(page.locator('[data-testid="payment-panel"]')).toBeVisible();
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

  // --- 5. the 4xx byte-identity contract, back with a live API: unknown id
  // keeps the classic not-found card, the island never appears.
  await page.goto('/orders/00000000-dead-4000-8000-000000000000?email=none@example.com');
  await expect(page.locator('#order-verify-email')).toBeVisible();
  await expect(page.locator('[data-testid="receipt-offline-island"]')).toHaveCount(0);
});
