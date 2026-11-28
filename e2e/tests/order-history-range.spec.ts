import { expect, test, type Page } from '@playwright/test';
import { signInUi } from '../helpers/fixtures';

/**
 * Order-history date-range filter (Phase 17, session 148): the /orders/my
 * quick-pick chips ride GET /api/orders/my `?from=<ISO>` (closed range,
 * server-validated). This spec pins the WIRE contract (exact param shapes,
 * composition with the status tab, absence for "All time") plus the honest
 * empty-period escape hatch — via intercepted envelopes where counts would
 * be seed-dependent, real data where only the request shape matters.
 *
 * Read-only by design: no orders are created, no absolute counts asserted,
 * so it is fresh-seed-safe in any sort position.
 */

const DEMO = 'demo@foodorder.app';
const DAY_MS = 86_400_000;

function ordersReqs(page: Page): URL[] {
  const seen: URL[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/orders/my')) seen.push(new URL(r.url()));
  });
  return seen;
}

/** The `from` a chip must have minted, within a minute of the click. */
function assertWindow(from: string, days: number): void {
  const expected = Date.now() - days * DAY_MS;
  const skew = Math.abs(new Date(from).getTime() - expected);
  expect(skew, `from=${from} should name a ~${days}-day window`).toBeLessThan(60_000);
}

test('chips wire the ISO lower bound; All time sends no param at all', async ({ page }) => {
  const seen = ordersReqs(page);
  await signInUi(page, DEMO, { goto: '/login?next=/orders/my' });
  await expect.poll(() => seen.length, { timeout: 15_000 }).toBeGreaterThan(0);
  // Default state: no date param on the wire, chip pressed.
  expect([...seen[seen.length - 1].searchParams.keys()]).not.toContain('from');
  await expect(page.getByTestId('hist-range-all')).toHaveAttribute('aria-pressed', 'true');

  const req7 = page.waitForRequest(
    (r) => r.url().includes('/api/orders/my') && new URL(r.url()).searchParams.has('from'),
  );
  await page.getByTestId('hist-range-7d').click();
  const u7 = new URL((await req7).url());
  assertWindow(u7.searchParams.get('from')!, 7);
  expect(u7.searchParams.get('to')).toBeNull(); // quick picks are lower-bound-only
  await expect(page.getByTestId('hist-range-7d')).toHaveAttribute('aria-pressed', 'true');
  // Seeded history is recent: the same cards must still render (no lie of
  // an empty list behind a working filter).
  await expect(page.locator('[data-testid^="order-card-"]').first()).toBeVisible({
    timeout: 10_000,
  });

  const reqBack = page.waitForRequest(
    (r) =>
      r.url().includes('/api/orders/my') && !new URL(r.url()).searchParams.has('from'),
  );
  await page.getByTestId('hist-range-all').click();
  await reqBack;
});

test('range composes with the status tab on one wire', async ({ page }) => {
  const seen = ordersReqs(page);
  await signInUi(page, DEMO, { goto: '/login?next=/orders/my' });
  await expect.poll(() => seen.length, { timeout: 15_000 }).toBeGreaterThan(0);

  const reqTab = page.waitForRequest(
    (r) => new URL(r.url()).searchParams.get('status') === 'completed',
  );
  await page.locator('#orders-tab-completed').click();
  await reqTab;

  const reqBoth = page.waitForRequest((r) => {
    const p = new URL(r.url()).searchParams;
    return p.get('status') === 'completed' && p.has('from');
  });
  await page.getByTestId('hist-range-30d').click();
  const u = new URL((await reqBoth).url());
  assertWindow(u.searchParams.get('from')!, 30);
  // The range change reset pagination back to the first page.
  expect(u.searchParams.get('page') ?? '1').toBe('1');
});

test('empty period names the period and offers the way back', async ({ page }) => {
  const served: URL[] = [];
  await page.route('**/api/orders/my*', (route) => {
    served.push(new URL(route.request().url()));
    return route.fulfill({ json: { items: [], total: 0, page: 1, limit: 10 } });
  });
  await signInUi(page, DEMO, { goto: '/login?next=/orders/my' });
  // No range: the honest never-ordered title (the account may truly be new).
  await expect(page.getByRole('heading', { level: 2, name: 'No orders yet' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('hist-range-clear')).toHaveCount(0);

  await page.getByTestId('hist-range-7d').click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'No orders in this period' }),
  ).toBeVisible();
  const clear = page.getByTestId('hist-range-clear');
  await expect(clear).toBeVisible();

  const reqBack = page.waitForRequest(
    (r) =>
      r.url().includes('/api/orders/my') && !new URL(r.url()).searchParams.has('from'),
  );
  await clear.click();
  await reqBack;
  await expect(page.getByRole('heading', { level: 2, name: 'No orders yet' })).toBeVisible();
  // The 7-day click really did ride a from bound on the wire.
  expect(served.some((u) => u.searchParams.has('from'))).toBe(true);
});

test('the range chips are localized in Indonesian', async ({ page }) => {
  await signInUi(page, DEMO, { goto: '/login?next=/orders/my' });
  await page
    .locator('[data-testid="hist-range-group"]')
    .waitFor({ timeout: 15_000 });
  // Sign-in first: the locale cookie must not translate the login chrome
  // under a helper that pins it (session 95 contract).
  await page.context().addCookies([
    {
      name: 'locale',
      value: 'id',
      url: process.env.E2E_WEB_URL || 'http://localhost:3000',
    },
  ]);
  await page.reload();
  await expect(
    page.getByRole('group', { name: 'Filter tanggal pesanan' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Sepanjang waktu' })).toBeVisible();
  await expect(page.getByRole('button', { name: '7 hari terakhir' })).toBeVisible();
  await expect(page.getByRole('button', { name: '30 hari terakhir' })).toBeVisible();
  await expect(page.getByRole('button', { name: '90 hari terakhir' })).toBeVisible();
});
