import { expect, test, type Page } from '@playwright/test';
import {
  createOrder,
  loginToken,
  WEB,
  warungFixture,
} from '../helpers/fixtures';
import { issueReceiptToken } from '../helpers/receipt-token';

/**
 * Phase 15 #3 — "one-click pay from the magic link", through the REAL
 * browser. A guest who arrived from the emailed receipt link (`?rt=`) can
 * PAY the order without ever creating an account: the panel reads the
 * payment history, creates the intent and captures it, all on the same
 * capability. The ladder lives server-side (payment-rt-access specs + live
 * smoke); THIS spec pins the browser surface and the wire contract:
 *
 *  - guest + valid rt on a GUEST order: unpaid panel + rt note + working
 *    PayButton → paid pill survives a reload; the payment POSTs carry the
 *    rt query and NO Authorization header (the client never fabricates a
 *    session to pay its own email);
 *  - guest + valid rt on an OWNED order: the receipt still renders (view
 *    rung unchanged) but the panel stays on the session-43 sign-in hint —
 *    the capability TIER (read ≠ money on an account) mirrored honestly;
 *  - ID locale byte-pin of the new panel note (intercepted list read —
 *    zero real money state touched).
 *
 * Orders are created over the API (own fixtures, unique emails) — zero
 * seed-state mutation, green across repeat runs (zz-magic-link precedent).
 * The payments rate bucket is 10/min/IP: this spec makes exactly 2 POSTs.
 */

const rtPage = async (page: Page, orderId: string, rt: string) => {
  await page.goto(`${WEB}/orders/${orderId}?rt=${encodeURIComponent(rt)}`);
};

test('guest rt receipt pays a GUEST order with no account (wire carries no Authorization)', async ({
  page,
  request,
}) => {
  const fx = await warungFixture(request);
  const order = await createOrder(request, fx, {
    contactEmail: 'rt-pay-e2e@example.com',
  });
  const rt = issueReceiptToken(order.id);
  await rtPage(page, order.id, rt);

  // panel resolves through the rt list read (rows arrive with no session)
  await expect(page.locator('[data-testid="payment-unpaid"]')).toBeVisible();
  await expect(page.locator('[data-testid="payment-rt-note"]')).toBeVisible();
  await expect(page.locator('[data-testid="payment-signin-hint"]')).toHaveCount(0);
  const payButton = page.locator('[data-testid="pay-button"]');
  await expect(payButton).toBeVisible();

  // Register BOTH POST waiters BEFORE the click: intent→capture fire back
  // to back inside one click handler, and a waitForResponse attached after
  // the intent resolves can miss the capture response outright.
  const intentRes = page
    .waitForResponse((r) => r.url().includes('/api/payments?rt=') && r.request().method() === 'POST')
    .then(async (r) => ({ status: r.status(), req: r.request() }));
  const captureRes = page
    .waitForResponse(
      (r) => r.url().includes('/capture') && r.request().method() === 'POST',
    )
    .then(async (r) => ({ status: r.status(), req: r.request() }));
  await payButton.click();
  const intent = await intentRes;
  expect(intent.status).toBe(201);
  expect(intent.req.url()).toContain(`rt=${encodeURIComponent(rt)}`);
  // THE contract: the money POST carries no Authorization header at all.
  expect(await intent.req.headerValue('authorization')).toBeNull();

  await expect(page.locator('[data-testid="payment-paid"]')).toBeVisible({
    timeout: 10_000,
  });
  const capture = await captureRes;
  expect(capture.status).toBe(200);
  expect(await capture.req.headerValue('authorization')).toBeNull();

  // A reload re-reads through the same rung: the paid pill is server truth,
  // not optimistic UI (the receipt page's own list fetch rides rt again).
  await page.reload();
  await expect(page.locator('[data-testid="payment-paid"]')).toBeVisible();
  await expect(page.locator('[data-testid="pay-button"]')).toHaveCount(0);
});

test('owned order: valid rt renders the receipt but the panel keeps the sign-in hint (tier)', async ({
  page,
  request,
}) => {
  const fx = await warungFixture(request);
  const token = await loginToken(request, 'demo@foodorder.app');
  const order = await createOrder(request, fx, {
    contactEmail: 'rt-tier-e2e@example.com',
    token,
  });
  const rt = issueReceiptToken(order.id);
  await rtPage(page, order.id, rt);

  // view rung alive (session 133): the receipt itself rendered — pinned on
  // the h1 (the code also rides the reference line; strict mode).
  await expect(page.locator('h1')).toContainText(order.code);
  // money rung absent (Phase 15 tier): no pay affordance, no rt note,
  // the untouched session-43 hint.
  await expect(page.locator('[data-testid="payment-signin-hint"]')).toBeVisible();
  await expect(page.locator('[data-testid="pay-button"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="payment-rt-note"]')).toHaveCount(0);
});

test('ID locale: the rt pay note byte-pins on the guest panel', async ({
  page,
  request,
}) => {
  const fx = await warungFixture(request);
  const order = await createOrder(request, fx, {
    contactEmail: 'rt-id-e2e@example.com',
  });
  const rt = issueReceiptToken(order.id);
  await page.context().addCookies([{ name: 'locale', value: 'id', url: WEB }]);
  // Intercepted list read: zero real money state, honest empty history.
  await page.route('**/api/orders/*/payments*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    }),
  );
  await rtPage(page, order.id, rt);
  await expect(page.locator('[data-testid="payment-rt-note"]')).toHaveText(
    'Bayar lewat tautan dalam email Anda. Tanpa akun.',
  );
});
