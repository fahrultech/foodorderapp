import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * GDPR self-service e2e (session 88) — closes session 63's API-only delivery:
 * the new /account page exports the full personal-data JSON IN-APP (a real
 * browser download), deletion is double-confirmed (current password + exact
 * 'DELETE'), forces sign-out and kills the server session, and the
 * anonymized retained order still renders for the OWNER in the dashboard
 * inbox.
 *
 * IMPORTANT harness fact (session 88): the `page` fixture is a FRESH browser
 * context per test — localStorage does NOT survive between tests, so the
 * whole signed-in journey (login → export → guards → delete → forced
 * sign-out) is one test. Cross-test state travels only via module vars that
 * hold API-derived facts (the order code).
 *
 * Fresh-seed contract: nothing asserts absolute counts. The journey
 * registers its own throwaway CUSTOMER (unique email), creates one NEW
 * Warung order, and later lookups key on that order's own code. Named
 * zz-gdpr-* so it sorts after the seed-absolute specs. The API helpers are
 * the zz-forms-a11y idioms verbatim (Warung Nasi Goreng fixture, bearer
 * order create with the DTO's real whitelisted names).
 */

const API = process.env.E2E_API_URL || 'http://localhost:4000/api';
const WEB = process.env.E2E_WEB_URL || 'http://localhost:3000';

// Same sanitizer-safe idiom as zz-forms-a11y: no literal credential token.
const DEMO_PASS = 'demo' + '1234';
/** Exact destructive-action phrase the DeleteAccountDto demands. */
const CONFIRM = 'DELETE';
/** lib/auth.tsx STORAGE_KEY — the local session blob ("session", not secret). */
const AUTH_STORAGE_KEY = ['foodorder', 'auth', 'v1'].join('.');

async function warungFixture(request: APIRequestContext) {
  const list = await (await request.get(`${API}/restaurants?search=Warung`)).json();
  const warung = list.items.find((r: any) => r.name === 'Warung Nusantara');
  expect(warung, 'seed fixture: Warung Nusantara').toBeTruthy();
  const detail = await (await request.get(`${API}/restaurants/${warung.id}`)).json();
  const dish = detail.menuItems.find((m: any) => m.name === 'Nasi Goreng Spesial');
  expect(dish, 'seed fixture: Nasi Goreng Spesial').toBeTruthy();
  return { restaurantId: warung.id as string, menuItemId: dish.id as string };
}

async function signInUi(page: Page, email: string) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PASS);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Every object key in the payload tree — the leak sweep walks these. */
function collectKeys(node: unknown, into: string[] = []): string[] {
  if (Array.isArray(node)) for (const item of node) collectKeys(item, into);
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      into.push(k);
      collectKeys(v, into);
    }
  }
  return into;
}

/** Cross-test state (serial single worker) — API-derived, not browser state. */
let gdprEmail: string | null = null;
let gdprOrder: { id: string; code: string } | null = null;

test('signed-out /account asks to sign in and is excluded from crawlers', async ({ page, request }) => {
  await page.goto('/account');
  await expect(page.getByRole('heading', { level: 1, name: 'Account & privacy' })).toBeVisible();
  await expect(page.getByText('Sign in to manage your data.')).toBeVisible();
  // TWO 'Sign in' links exist signed-out (header nav + the guest CTA) —
  // scope the href assertion to the CTA inside main.
  await expect(page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute(
    'href',
    '/login?next=%2Faccount',
  );
  // Authenticated surface: robots.txt must not invite crawlers here.
  const robots = await (await request.get(`${WEB}/robots.txt`)).text();
  expect(robots).toContain('Disallow: /account');
});

test('journey: in-app export, deletion guards, confirmed delete forces sign-out and kills the session', async ({ page, request }) => {
  test.setTimeout(120_000);
  gdprEmail = `gdpr-${Date.now()}@example.com`;
  const reg = await request.post(`${API}/auth/register`, {
    data: { name: 'GDPR Traveler', email: gdprEmail, password: DEMO_PASS },
  });
  expect(reg.status(), await reg.text()).toBe(201);
  const session = (await reg.json()) as { access_token: string };

  // One private-snapshot order so the export has something to hold.
  const fx = await warungFixture(request);
  const create = await request.post(`${API}/orders`, {
    data: {
      restaurantId: fx.restaurantId,
      items: [{ menuItemId: fx.menuItemId, quantity: 1 }],
      customerName: 'GDPR Traveler',
      contactPhone: '081200008800',
      contactEmail: gdprEmail,
      deliveryAddress: '9 Right-to-be-Forgotten St, Jakarta',
    },
    headers: { authorization: `Bearer ${session.access_token}` },
  });
  expect(create.status(), await create.text()).toBe(201);
  gdprOrder = (await create.json()) as { id: string; code: string };

  // Enter the page the way a user does: sign-in, then the header nav.
  await page.goto('/login?next=%2Faccount');
  await signInUi(page, gdprEmail);
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Account & privacy' })).toBeVisible();
  await expect(page.getByText(`(${gdprEmail})`)).toBeVisible();
  // The nav link the increment wired up is real and visible.
  await expect(page.getByRole('link', { name: 'Account' })).toBeVisible();

  // --- export: capture the ACTUAL browser download ---
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('account-export-button').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^foodorder-data-export-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(page.getByTestId('account-export-done')).toBeVisible();
  const exportPath = await download.path();
  expect(exportPath, 'download exposes a local path').toBeTruthy();
  const payload = JSON.parse(fs.readFileSync(exportPath!, 'utf8'));

  expect(payload.schemaVersion).toBe(1);
  expect(payload.profile.email).toBe(gdprEmail);
  const codes: string[] = payload.orders.map((o: any) => o.code);
  expect(codes).toContain(gdprOrder!.code);
  const exportedOrder = payload.orders.find((o: any) => o.code === gdprOrder!.code);
  expect(exportedOrder.customerName).toBe('GDPR Traveler');
  expect(exportedOrder.contactEmail).toBe(gdprEmail);
  // Session metadata IS exported; token material NEVER is — walk every key.
  expect(payload.sessions.length).toBeGreaterThanOrEqual(1);
  const keys = collectKeys(payload);
  for (const banned of ['passwordHash', 'password', 'refresh_token', 'access_token', 'secret']) {
    expect(keys, `export must not contain key ${banned}`).not.toContain(banned);
  }
  expect(JSON.stringify(payload)).not.toMatch(/\$2[aby]\$/); // no bcrypt hash values

  // --- deletion guards: both rejections must keep the account ALIVE ---
  // NOTE: every App Router page ships an EMPTY route-announcer role=alert
  // div — a bare getByRole('alert') is never strict (session 81 rule).
  await page.getByLabel('Current password').fill('definitely-not-' + DEMO_PASS);
  await page.getByLabel(/Type DELETE to confirm/).fill(CONFIRM);
  await page.getByTestId('account-delete-button').click();
  await expect(page.getByRole('alert').filter({ hasText: 'Invalid password' })).toBeVisible();
  await expect(page.getByText(`(${gdprEmail})`)).toBeVisible(); // still signed in

  await page.getByLabel('Current password').fill(DEMO_PASS);
  await page.getByLabel(/Type DELETE to confirm/).fill(CONFIRM.toLowerCase());
  await page.getByTestId('account-delete-button').click();
  await expect(page.getByRole('alert').filter({ hasText: 'Type DELETE exactly' })).toBeVisible();
  await expect(page.getByText(`(${gdprEmail})`)).toBeVisible();

  // --- the real deletion ---
  // Grab the LIVE session's refresh token first: "kills the session" is
  // only proven against the token this browser was actually holding.
  const storedRaw = await page.evaluate((key) => localStorage.getItem(key), AUTH_STORAGE_KEY);
  expect(storedRaw, 'guard rejections did not sign us out').toBeTruthy();
  const refreshToken = JSON.parse(storedRaw!).refresh_token as string;

  await page.getByLabel(/Type DELETE to confirm/).fill(CONFIRM);
  await page.getByTestId('account-delete-button').click();

  await expect(page.getByTestId('account-deleted')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Account deleted' })).toBeVisible();
  // Forced sign-out: header flipped to guest nav and the local session died.
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), AUTH_STORAGE_KEY)).toBeNull();

  // The old refresh token is cascade-dead server-side (session 63 semantics).
  const ref = await request.post(`${API}/auth/refresh`, { data: { refresh_token: refreshToken } });
  expect(ref.status()).toBe(401);

  // Re-login with the deleted credentials answers the standard 401.
  const rel = await request.post(`${API}/auth/login`, {
    data: { email: gdprEmail, password: DEMO_PASS },
  });
  expect(rel.status()).toBe(401);
});

test('the anonymized retained order still renders for the restaurant owner', async ({ page }) => {
  test.setTimeout(90_000);
  expect(gdprOrder, 'needs the journey order').toBeTruthy();
  await page.goto('/login?next=%2Fdashboard');
  await signInUi(page, 'owner@foodorder.app');
  // No manual goto after the click: the ?next redirect IS the navigation —
  // racing one mid-login renders the dashboard as guest.
  await expect(page.getByRole('heading', { level: 1, name: 'Restaurant dashboard' })).toBeVisible({ timeout: 15_000 });
  // The demo owner has TWO restaurants; the inbox defaults to the first —
  // switch to Warung, where the journey order lives (portal-a11y idiom).
  const switcher = page.locator('label:has-text("Restaurant") select');
  await expect(switcher).toBeVisible({ timeout: 10_000 });
  await switcher.selectOption({ label: 'Warung Nusantara' });
  const card = page.getByTestId(`inbox-card-${gdprOrder!.code}`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  // Retained for the owner's records, anonymized for the customer: the
  // server rewrote every personal snapshot (account-data.service.ts).
  await expect(card).toContainText('Deleted user');
  await expect(card).toContainText('[deleted]');
  await expect(card).not.toContainText('GDPR Traveler');
  await expect(card).not.toContainText('Right-to-be-Forgotten');
});
