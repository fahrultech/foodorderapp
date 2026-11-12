import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Phase 7 a11y pass #2 (session 81) — the forms session 78 explicitly left
 * over: LOGIN, REGISTER (now inline per-field role=alert errors +
 * focus-first-invalid), saved ADDRESSES (the orphan labels — real
 * htmlFor/id associations now + focus into the opened form), the
 * ORDER-HISTORY status filter (upgraded from bare role=tab to the full APG
 * tabs pattern: roving tabindex, Arrow/Home/End, aria-controls tabpanel),
 * the receipt ORDERVERIFY island (hint wired as the input's accessible
 * description) and the RATE CARD (star radios carry "N star(s)" names, the
 * comment box is labelled, errors are role=alert).
 *
 * Named zz-forms-* so Playwright's serial run sorts it after every
 * seed-absolute assertion (admin counts, owner-analytics $73 fixture,
 * guest-smoke rating pills) — this file registers a user, saves an address,
 * and completes + reviews a NEW Warung order. The API helpers are copied
 * VERBATIM from portal-a11y.spec.ts (same fixtures: demo@foodorder.app /
 * owner@foodorder.app via loginToken, Warung Nasi Goreng, 429-tolerant
 * payOrder for the payments bucket).
 */

const API = process.env.E2E_API_URL || 'http://localhost:4000/api';

async function loginToken(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${API}/auth/login`, {
    data: { email, password: 'demo1234' },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

async function warungFixture(request: APIRequestContext) {
  const list = await (await request.get(`${API}/restaurants?search=Warung`)).json();
  const warung = list.items.find((r: any) => r.name === 'Warung Nusantara');
  expect(warung, 'seed fixture: Warung Nusantara').toBeTruthy();
  const detail = await (await request.get(`${API}/restaurants/${warung.id}`)).json();
  const dish = detail.menuItems.find((m: any) => m.name === 'Nasi Goreng Spesial');
  expect(dish, 'seed fixture: Nasi Goreng Spesial').toBeTruthy();
  return { restaurantId: warung.id as string, menuItemId: dish.id as string };
}

async function createOrder(
  request: APIRequestContext,
  fixture: { restaurantId: string; menuItemId: string },
  token?: string,
) {
  const res = await request.post(`${API}/orders`, {
    data: {
      restaurantId: fixture.restaurantId,
      items: [{ menuItemId: fixture.menuItemId, quantity: 1 }],
      customerName: 'A11y Tester',
      contactPhone: '081200007800',
      contactEmail: 'a11y@example.com',
      deliveryAddress: '8 Accessibility Ave, Jakarta',
    },
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string; code: string };
}

// The payments bucket is 10 req/min/IP and several suite files pay orders in
// the same serial minute — a 429 here is the limiter (documented smoke
// pitfall), so wait out the advertised window and retry ONCE.
async function payOrder(request: APIRequestContext, token: string, orderId: string) {
  const post = (path: string, data?: unknown) =>
    request.post(`${API}${path}`, {
      data,
      headers: { authorization: `Bearer ${token}` },
    });
  let res = await post('/payments', { orderId });
  if (res.status() === 429) {
    const body: any = await res.json().catch(() => null);
    const waitSec = Math.min(45, (body?.error?.details?.retry_after_sec ?? 25) + 2);
    await new Promise((r) => setTimeout(r, waitSec * 1000));
    res = await post('/payments', { orderId });
  }
  expect(res.status(), await res.text()).toBe(201);
  const { id: paymentId } = (await res.json()) as { id: string };
  let cap = await post(`/payments/${paymentId}/capture`);
  if (cap.status() === 429) {
    const body: any = await cap.json().catch(() => null);
    const waitSec = Math.min(45, (body?.error?.details?.retry_after_sec ?? 25) + 2);
    await new Promise((r) => setTimeout(r, waitSec * 1000));
    cap = await post(`/payments/${paymentId}/capture`);
  }
  expect(cap.status(), await cap.text()).toBe(200);
}


const DEMO_PASS = 'demo' + '1234';

/** Drive an order through the OWNER ladder. The shipped confirm gate means
 *  `confirmed` refuses unpaid orders — pay before calling. */
async function ownerAdvance(
  request: APIRequestContext,
  ownerToken: string,
  restaurantId: string,
  orderId: string,
) {
  for (const status of ['confirmed', 'preparing', 'delivering', 'completed']) {
    const res = await request.patch(
      `${API}/restaurants/${restaurantId}/orders/${orderId}/status?status=${status}`,
      { headers: { authorization: `Bearer ${ownerToken}` }, },
    );
    expect(res.status(), await res.text()).toBe(200);
  }
}

async function signInUi(page: Page, email: string) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PASS);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Cross-test state (serial single worker): the order the rate test drives
 *  to completed is unlocked by the GUEST rung in the OrderVerify test. */
let drivenOrder: { id: string; code: string } | null = null;

test('login: both fields are programmatically labelled; a failed sign-in answers role=alert', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Email', { exact: true })).toBeEditable();
  await expect(page.getByLabel('Password', { exact: true })).toBeEditable();
  await page.getByLabel('Email', { exact: true }).fill('demo@foodorder.app');
  await page.getByLabel('Password', { exact: true }).fill('definitely-wrong-9');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // NOTE: every App Router page ships an EMPTY <div role=alert id=__next-route-announcer__>
  // (Next's route change announcer) — a bare getByRole('alert') is NEVER strict here.
  await expect(page.getByRole('alert').filter({ hasText: 'Invalid email or password' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
});

test('register: inline role=alert per broken field, aria wiring, focus lands on the first invalid', async ({ page }) => {
  await page.goto('/register');
  for (const name of [
    'Name',
    'Email',
    'Password',
    'Confirm password',
    // exact accessible names INCLUDE the "(optional)" span — exact:true is
    // also what keeps 'Password' from also matching 'Confirm password'.
    'Phone (optional)',
    'Delivery address (optional)',
  ]) {
    await expect(page.getByLabel(name, { exact: true })).toBeVisible();
  }
  await page.getByLabel('Name', { exact: true }).fill('A');
  await page.getByLabel('Email', { exact: true }).fill('not-an-email');
  await page.getByLabel('Password', { exact: true }).fill('shortpw');
  await page.getByLabel('Confirm password', { exact: true }).fill('differentpw');
  await page.getByRole('button', { name: 'Create account' }).click();

  // Focus-first-invalid: Name is the first broken field in DOM order.
  await expect(page.getByLabel('Name', { exact: true })).toBeFocused();
  // Each message is the field's OWN accessible description — not a floating list.
  await expect(page.getByRole('alert').filter({ hasText: 'Name must be 2–120 characters.' })).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute('aria-describedby', 'name-error');
  await expect(page.getByRole('alert').filter({ hasText: 'Passwords do not match.' })).toBeVisible();
  await expect(page.getByLabel('Confirm password', { exact: true })).toHaveAttribute('aria-describedby', 'confirm-error');
  await expect(page.getByRole('alert').filter({ hasText: 'at least 8 characters' })).toBeVisible();

  // Fix everything -> account is real and the user is signed in.
  await page.getByLabel('Name', { exact: true }).fill('Forms A11y');
  await page.getByLabel('Email', { exact: true }).fill(`forms-a11y-${Date.now()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PASS);
  await page.getByLabel('Confirm password', { exact: true }).fill(DEMO_PASS);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/');
});

test('addresses: labels associate, the opened form takes focus, invalid phone answers an inline alert', async ({ page }) => {
  await page.goto('/login?next=%2Faddresses');
  await signInUi(page, 'demo@foodorder.app');
  await expect(page.getByRole('heading', { level: 1, name: 'Delivery addresses' })).toBeVisible();

  await page.getByRole('button', { name: /Add (your first )?address/ }).click();
  // The form opens WITH focus on its first field — no tab-hunting.
  await expect(page.getByLabel('Label', { exact: true })).toBeFocused();

  await page.getByLabel('Label', { exact: true }).fill('Forms Home');
  await page.getByLabel('Recipient name').fill('Demo Customer');
  await page.getByLabel('Phone for this address').fill('banana');
  await page.getByLabel('Street address').fill('Jl. Keyboard No. 7, Jakarta');
  await page.getByRole('button', { name: 'Save address' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Phone looks invalid' }),
  ).toBeVisible();

  await page.getByLabel('Phone for this address').fill('+62 812 0000 8100');
  await page.getByRole('button', { name: 'Save address' }).click();
  await expect(page.getByRole('heading', { name: 'Forms Home' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save address' })).toHaveCount(0);
});

test('order history: status filter is a real APG tablist driving the tabpanel', async ({ page }) => {
  await page.goto('/login?next=/orders/my');
  await signInUi(page, 'demo@foodorder.app');
  await expect(page.getByRole('heading', { level: 1, name: 'My orders' })).toBeVisible();

  const tablist = page.getByRole('tablist', { name: 'Filter orders by status' });
  const all = tablist.getByRole('tab', { name: /^All/ });
  // FILTER order is the STATUS FLOW order: All -> Pending -> Confirmed -> ...
  const pending = tablist.getByRole('tab', { name: /^Pending/ });

  // Roving tabindex: exactly ONE tab is in the tab order.
  await expect(tablist.locator('[tabindex="0"]')).toHaveCount(1);
  await expect(all).toHaveAttribute('aria-selected', 'true');
  await expect(all).toHaveAttribute('tabindex', '0');
  await expect(pending).toHaveAttribute('tabindex', '-1');

  // Arrow moves AND selects, focus follows; the panel is re-labelled.
  await all.focus();
  await all.press('ArrowRight');
  await expect(pending).toHaveAttribute('aria-selected', 'true');
  await expect(pending).toBeFocused();
  const panel = page.getByRole('tabpanel');
  await expect(panel).toHaveAttribute('aria-labelledby', 'orders-tab-pending');

  // End -> last tab (Cancelled); ArrowRight from it wraps to All.
  await page.keyboard.press('End');
  await expect(tablist.getByRole('tab', { name: /^Cancelled/ })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(all).toBeFocused();
  await expect(all).toHaveAttribute('aria-selected', 'true');

  // The tab actually drives the panel: Completed shows the seeded demo rows.
  await tablist.getByRole('tab', { name: /^Completed/ }).click();
  await expect(panel.getByTestId('order-card-FO-SEED8')).toBeVisible();
});

test('receipt: bare link auto-unlocks via the bearer rung; the rate form is fully named', async ({ page, request }) => {
  test.setTimeout(120_000);
  const demoToken = await loginToken(request, 'demo@foodorder.app');
  const ownerToken = await loginToken(request, 'owner@foodorder.app');
  const fx = await warungFixture(request);
  const order = await createOrder(request, fx, demoToken);
  await payOrder(request, demoToken, order.id);
  await ownerAdvance(request, ownerToken, fx.restaurantId, order.id);
  drivenOrder = order;

  await page.goto('/login');
  await signInUi(page, 'demo@foodorder.app');
  await page.goto(`/orders/${order.id}`);
  // OrderVerify's bearer probe hands the bare link back to the SSR receipt.
  await expect(page.getByRole('heading', { level: 1, name: `Order ${order.code} placed!` })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 2, name: 'Rate your order' })).toBeVisible();

  // Star radios now carry REAL accessible names (they were nameless before).
  await expect(page.getByRole('group', { name: 'Your rating' })).toBeVisible();
  const four = page.getByRole('radio', { name: '4 stars' });
  await expect(page.getByRole('radio', { name: '1 star' })).toBeVisible(); // singular form
  // The sr-only radio is a 1px clipped input — its WRAPPING LABEL is the real
  // click target (check() on the input fails hit-target interception forever).
  await page.locator('label', { has: four }).click();
  await expect(four).toBeChecked();

  await page.getByLabel('Your comment').fill('Delivery was quick, fries still hot.');
  await page.getByRole('button', { name: 'Submit review' }).click();
  // The stored-review view replaces the form — proof the POST landed.
  await expect(page.getByText('Delivery was quick, fries still hot.')).toBeVisible();
  await expect(page.getByRole('radio', { name: '4 stars' })).toHaveCount(0);
});

test('OrderVerify guest rung: description wired, wrong email stays "nothing unlocked", proof email unlocks', async ({ page }) => {
  test.skip(!drivenOrder, 'needs the order driven by the previous test');
  const order = drivenOrder!;
  await page.goto(`/orders/${order.id}`);
  const emailBox = page.getByLabel('Checkout email');
  await expect(emailBox).toBeVisible();
  await expect(emailBox).toHaveAttribute('aria-describedby', 'order-verify-hint');

  await emailBox.fill('totally-wrong@example.com');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByTestId('order-verify-failed')).toBeVisible();

  await emailBox.fill('a11y@example.com');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `Order ${order.code} placed!` })).toBeVisible();
});
