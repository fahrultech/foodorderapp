import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, bearer, createOrder, loginToken, payOrder, signInUi, warungFixture } from '../helpers/fixtures';

/**
 * Phase 6 a11y pass on checkout + owner portal (session 78):
 *
 *  - EVERY checkout field has a programmatic <label for> association and the
 *    email help text is wired as the field's accessible description;
 *  - the dashboard status tabs implement the ARIA tabs pattern: roving
 *    tabindex, Arrow/Home/End move+select, an aria-controls-wired tabpanel;
 *  - live inbox changes (new order, owner accept) are mirrored into a
 *    polite aria-live region — a silent push repaint is otherwise invisible
 *    to assistive tech;
 *  - the dish dialog keeps keyboard focus inside (Tab trap) and hands focus
 *    back to its opener when it closes;
 *  - the tracking page announces ORDER STATUS transitions over the live feed.
 *
 * Named to sort AFTER admin/owner-analytics (those assert seed-absolute
 * counts; this file creates orders). Fixtures mirror live-feed.spec:
 * owner@foodorder.app / demo@foodorder.app (pw demo1234), Warung Nusantara.
 * Orders are paid first — the confirm gate is ON by default.
 */

async function addOneNasiGoreng(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: /Warung Nusantara/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Warung Nusantara' })).toBeVisible();
  const row = page
    .locator('div.divide-y > div', {
      has: page.getByRole('heading', { level: 3, name: 'Nasi Goreng Spesial' }),
    })
    .first();
  await row.getByRole('button', { name: 'Add', exact: true }).click();
}

test('every checkout field is programmatically labelled (and the email hint is a description)', async ({
  page,
}) => {
  await addOneNasiGoreng(page);
  await page.getByRole('link', { name: /Cart/ }).click();
  await page.getByRole('link', { name: /Checkout/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeVisible();

  // Each label must ASSOCIATE, not merely sit nearby: getByLabel only finds
  // controls with a real label relationship (before this session none did).
  for (const name of [
    'Your name',
    'Phone',
    'Contact email',
    'Delivery address',
    'Note for the restaurant',
    'Promo code',
  ]) {
    await expect(page.getByLabel(name)).toBeVisible();
  }
  await expect(page.getByLabel('Your name')).toBeEditable();
  await page.getByLabel('Your name').fill('Labelled Checkout');

  // Accessible description from the aria-describedby help paragraph.
  await expect(
    page.getByRole('textbox', {
      name: 'Contact email',
      description: /link alone no longer shows anything/,
    }),
  ).toBeVisible();
});

test('dashboard status tabs: roving tabindex + arrow keys drive the tabpanel', async ({
  page,
}) => {
  await signInUi(page, 'owner@foodorder.app', { goto: '/login?next=/dashboard' });
  await expect(page.getByRole('heading', { level: 1, name: 'Restaurant dashboard' })).toBeVisible();

  const tablist = page.getByRole('tablist', { name: 'Filter orders by status' });
  await expect(tablist).toBeVisible();
  const all = page.getByRole('tab', { name: /^All/ });
  const pending = page.getByRole('tab', { name: /^Pending/ });

  // Roving tabindex: exactly ONE tab is in the tab order at a time.
  await expect(tablist.locator('[tabindex="0"]')).toHaveCount(1);
  await expect(all).toHaveAttribute('aria-selected', 'true');
  await expect(all).toHaveAttribute('tabindex', '0');
  await expect(pending).toHaveAttribute('tabindex', '-1');

  // Arrow moves AND selects (auto-activation), focus follows the selection.
  await all.focus();
  await all.press('ArrowRight');
  await expect(pending).toHaveAttribute('aria-selected', 'true');
  await expect(pending).toBeFocused();
  await expect(all).toHaveAttribute('aria-selected', 'false');

  // The tabs' aria-controls target is a real tabpanel labeled by the active tab.
  const panel = page.getByRole('tabpanel');
  await expect(panel).toHaveAttribute('aria-labelledby', 'status-tab-pending');

  // End jumps to the last tab (Cancelled), wrap-around from there returns to All.
  await pending.focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: /^Cancelled/ })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(all).toBeFocused();
  await expect(all).toHaveAttribute('aria-selected', 'true');
});

test('live inbox announces new orders and owner status actions via aria-live', async ({
  page,
  request,
}) => {
  await signInUi(page, 'owner@foodorder.app', { goto: '/login?next=/dashboard' });
  await expect(page.getByRole('heading', { level: 1, name: 'Restaurant dashboard' })).toBeVisible();

  const switcher = page.locator('label:has-text("Restaurant") select');
  await expect(switcher).toBeVisible({ timeout: 10_000 });
  await switcher.selectOption({ label: 'Warung Nusantara' });
  const pill = page.locator('[data-feed-transport]');
  await expect(pill).toHaveAttribute('data-feed-transport', 'ws', { timeout: 10_000 });

  const demoToken = await loginToken(request, 'demo@foodorder.app');
  const fx = await warungFixture(request);
  const order = await createOrder(request, fx, { token: demoToken });
  await payOrder(request, demoToken, order.id);

  const region = page.getByTestId('dashboard-live-region');
  // The same push sync that reveals the card must feed the polite region.
  await expect(region).toContainText(`${order.code} is a new order, currently pending`, {
    timeout: 10_000,
  });

  // Owner accept from the card: the in-place patch announces the transition.
  const card = page.locator(`[data-testid="inbox-card-${order.code}"]`);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('aria-label', `Order ${order.code}, pending`);
  await card.getByRole('button', { name: '✓ Accept' }).click();
  await expect(region).toContainText(`${order.code} moved from pending to confirmed`, {
    timeout: 10_000,
  });
});

test('dish dialog traps Tab and returns focus to its opener on Escape', async ({ page }) => {
  await signInUi(page, 'owner@foodorder.app', { goto: '/login?next=/dashboard/menu' });
  await expect(page.getByRole('heading', { level: 1, name: 'Menu manager' })).toBeVisible();

  const addBtn = page.getByRole('button', { name: '+ Add dish' });
  await expect(addBtn).toBeEnabled({ timeout: 10_000 });
  await addBtn.click();
  const dialog = page.getByRole('dialog', { name: 'Add a dish' });
  await expect(dialog).toBeVisible();

  // autoFocus lands on Name; Shift+Tab from the first stop must WRAP inside
  // the dialog, not leak to the browser chrome / background page.
  await expect(page.locator('#mi-name')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  const insideDialog = await page.evaluate(() =>
    Boolean(document.activeElement?.closest('[role="dialog"]')),
  );
  expect(insideDialog).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(addBtn).toBeFocused();
});

test('tracking page announces order status transitions over the live feed', async ({
  page,
  request,
}) => {
  const demoToken = await loginToken(request, 'demo@foodorder.app');
  const ownerToken = await loginToken(request, 'owner@foodorder.app');
  const fx = await warungFixture(request);
  const order = await createOrder(request, fx, { token: demoToken });
  await payOrder(request, demoToken, order.id);

  await signInUi(page, 'demo@foodorder.app', { goto: '/login' });
  await expect(page).not.toHaveURL(/\/login/);

  await page.goto(`/orders/${order.id}`);
  await expect(
    page.getByRole('heading', { level: 1, name: `Order ${order.code} placed!` }),
  ).toBeVisible();
  const live = page.getByTestId('order-status-live');
  await expect(live).toBeAttached();
  await expect(page.locator('[data-feed-transport]')).toHaveAttribute(
    'data-feed-transport',
    'ws',
    { timeout: 10_000 },
  );

  const patch = async (status: string) => {
    const res = await request.patch(
      `${API}/restaurants/${fx.restaurantId}/orders/${order.id}/status?status=${status}`,
      { headers: bearer(ownerToken) },
    );
    expect(res.status(), await res.text()).toBe(200);
  };

  await patch('confirmed');
  await expect(live).toContainText('Order status changed from pending to confirmed', {
    timeout: 10_000,
  });
  await patch('preparing');
  await expect(live).toContainText('Order status changed from confirmed to preparing', {
    timeout: 10_000,
  });
});
