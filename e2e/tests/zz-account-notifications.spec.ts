import { expect, test, type Page } from '@playwright/test';
import { API, DEMO_PASS, bearer, signInUi } from '../helpers/fixtures';

/**
 * Notification channel settings e2e (session 131) — the web surface for
 * session 130's GET/PATCH /users/me/notification-settings. Round-trips a
 * flip THROUGH THE REAL UI and proves persistence three ways: a fresh
 * reload re-reads the row, the direct-API GET agrees byte-for-byte, and the
 * GDPR export embeds the same state.
 *
 * Fresh-seed contract (session 88 doctrine): registers its own throwaway
 * CUSTOMER (unique email) so nothing here consumes seed state or touches
 * demo@foodorder.app; every lookup keys on that user. The `page` fixture is
 * a fresh context per test, so login re-runs each test while the module vars
 * carry the API-derived identity.
 *
 * Named zz-* so it sorts AFTER the seed-absolute specs (admin.spec pins the
 * users total via a no-separator DOM concat): the registration here adds one
 * customer row and must never run before those counts are read.
 *
 * Locator note: each checkbox label wraps BOTH the label text and its hint
 * span, so the accessible name is the combined string — state assertions
 * ride the data-testid locators, label pins use exact getByText.
 */

const WEB = process.env.E2E_WEB_URL || 'http://localhost:3000';

/** Cross-test state (serial single worker) — API-derived, not browser state. */
let notifyEmail: string | null = null;
let notifyToken: string | null = null;

async function signedInAccount(page: Page, email: string) {
  await page.goto('/login?next=%2Faccount');
  await signInUi(page, email);
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Account & privacy' })).toBeVisible();
}

test('defaults ON; an email flip persists across reload, on the API wire and in the GDPR export', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  notifyEmail = `notify-${Date.now()}@example.com`;
  const reg = await request.post(`${API}/auth/register`, {
    data: { name: 'Nina Notify', email: notifyEmail, password: DEMO_PASS },
  });
  expect(reg.status(), await reg.text()).toBe(201);
  notifyToken = ((await reg.json()) as { access_token: string }).access_token;

  await signedInAccount(page, notifyEmail);
  const emailBox = page.getByTestId('account-notify-email');
  const pushBox = page.getByTestId('account-notify-push');
  await expect(emailBox).toBeVisible(); // the settings GET has landed
  // Column defaults preserve the pre-feature behavior: both channels ON.
  await expect(emailBox).toBeChecked();
  await expect(pushBox).toBeChecked();
  await expect(page.getByText('Order status emails', { exact: true })).toBeVisible();
  await expect(page.getByText('Browser push alerts', { exact: true })).toBeVisible();

  // Flip email OFF -> re-read persisted state + transient saved confirmation.
  await emailBox.click();
  await expect(page.getByTestId('account-notify-saved')).toHaveText('Order status emails saved');
  await expect(emailBox).not.toBeChecked();
  await expect(pushBox).toBeChecked();

  // Persistence is server-side: a fresh document re-reads the row.
  await page.goto('/account');
  await expect(page.getByTestId('account-notify-email')).toBeVisible();
  await expect(page.getByTestId('account-notify-email')).not.toBeChecked();
  await expect(page.getByTestId('account-notify-push')).toBeChecked();

  // The direct API agrees exactly with what the UI shows.
  const wire = await (
    await request.get(`${API}/users/me/notification-settings`, { headers: bearer(notifyToken!) })
  ).json();
  expect(wire).toEqual({ orderEmail: false, orderPush: true });

  // GDPR export parity (session 130 embedded the toggles next to the profile).
  const exp = await (await request.get(`${API}/users/me/export`, { headers: bearer(notifyToken!) })).json();
  expect(exp.notificationSettings).toEqual({ orderEmail: false, orderPush: true });
});

test('an unreachable PATCH self-reverts the checkbox and writes nothing; the retry lands', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  expect(notifyEmail, 'needs the first test user').toBeTruthy();
  await signedInAccount(page, notifyEmail!);
  const pushBox = page.getByTestId('account-notify-push');
  await expect(pushBox).toBeChecked(); // carried over from test 1

  // Network-fail ONLY the writes; the settings GET must still work.
  await page.route('**/users/me/notification-settings', (route) =>
    route.request().method() === 'PATCH' ? route.abort() : route.continue(),
  );
  await pushBox.click();
  await expect(page.getByTestId('account-notify-save-error')).toBeVisible();
  // No optimistic write: the control value is the LAST PERSISTED state...
  await expect(pushBox).toBeChecked();
  await expect(page.getByTestId('account-notify-saved')).toHaveCount(0);

  // ...and the rejected attempt wrote nothing server-side.
  const wire = await (
    await request.get(`${API}/users/me/notification-settings`, { headers: bearer(notifyToken!) })
  ).json();
  expect(wire).toEqual({ orderEmail: false, orderPush: true });

  // With the route restored the same flip persists.
  await page.unroute('**/users/me/notification-settings');
  await pushBox.click();
  await expect(page.getByTestId('account-notify-saved')).toHaveText('Browser push alerts saved');
  await expect(pushBox).not.toBeChecked();
  await page.goto('/account');
  await expect(page.getByTestId('account-notify-push')).toBeVisible();
  await expect(page.getByTestId('account-notify-push')).not.toBeChecked();
});

test('a failed settings GET degrades to an honest error card; retry recovers', async ({ page }) => {
  test.setTimeout(120_000);
  expect(notifyEmail, 'needs the first test user').toBeTruthy();
  await page.context().route('**/users/me/notification-settings', (route) => route.abort());
  await signedInAccount(page, notifyEmail!);
  await expect(page.getByTestId('account-notify-card')).toBeVisible();
  await expect(page.getByTestId('account-notify-load-error')).toBeVisible();
  // Never fabricate checkboxes for unread state — the toggles are absent.
  await expect(page.getByTestId('account-notify-email')).toHaveCount(0);

  await page.context().unroute('**/users/me/notification-settings');
  await page.getByTestId('account-notify-retry').click();
  await expect(page.getByTestId('account-notify-email')).toBeVisible();
  // Recovers into the persisted truth (email OFF, push OFF from test 2).
  await expect(page.getByTestId('account-notify-email')).not.toBeChecked();
  await expect(page.getByTestId('account-notify-push')).not.toBeChecked();
});
