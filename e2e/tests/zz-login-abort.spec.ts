import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Session 100 — the ROOT CAUSE of the recurring `zz-forms-a11y`
 * "receipt: bare link..." flake, pinned in BOTH directions.
 *
 * Mechanism (the sibling of the session-93/97 redirect-swallow race):
 * `signInUi` used to return the moment the Sign in click dispatched. A
 * `page.goto` issued right after starts a full-document navigation that
 * COMMITS while `POST /auth/login` is still in flight — Chromium cancels
 * pending fetches on document navigation — so `login()` never resolves,
 * `applySession` never runs, and the target page renders the GUEST state.
 * The receipt test then timed out on a signed-in-only heading; the
 * `?next`-redirect call sites never hit it because the redirect IS their
 * navigation (zz-gdpr-account documented that hazard in a comment — this
 * file makes it executable). The product's session-97 nav settle-gate
 * cannot help here: `inert` blocks CLICKS, not a script-driven `goto`.
 *
 * Both tests HOLD the login response (armed at REQUEST time per the
 * session-97 harness truth) so the flight window is ~1.5 s wide and the
 * race is deterministic, not probabilistic. The hold still lets the real
 * API call through (route.fetch + fulfill) so a surviving page completes.
 *
 * Read-only by design: no orders created, no counts asserted, /orders/my
 * only ever checked for the h1 gate-vs-title flip — seed-safe, and named
 * zz-* to sort after the seed-absolute specs.
 */

const DEMO_PASS = 'demo' + '1234';
/** lib/auth.tsx STORAGE_KEY — the local session blob ("session", not secret). */
const AUTH_STORAGE_KEY = ['foodorder', 'auth', 'v1'].join('.');
/** Wide enough that any real goto commits mid-flight; short for test time. */
const HOLD_MS = 1500;

async function holdLoginResponses(page: Page): Promise<void> {
  await page.route('**/auth/login', async (route: Route) => {
    await new Promise((r) => setTimeout(r, HOLD_MS));
    try {
      const res = await route.fetch();
      await route.fulfill({ response: res });
    } catch {
      /* The page navigated away mid-hold — THAT is the abort being pinned;
         a dead route handle must never fail the test itself. */
    }
  });
}

async function fillAndClick(page: Page, email: string) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PASS);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('HAZARD: a manual goto the moment after the click ABORTS the in-flight login — target renders guest', async ({ page }) => {
  test.setTimeout(90_000);
  await holdLoginResponses(page);
  await page.goto('/login');
  await fillAndClick(page, 'demo@foodorder.app');
  // The OLD zz-forms-a11y receipt sequence reproduced VERBATIM: click, then
  // navigate immediately. click() resolves while the POST is in flight; the
  // new document's commit cancels it long before the 1.5 s hold ends.
  await page.goto('/orders/my');

  // Guest render — the exact flake signature (an assertion timeout on a
  // signed-in-only element).
  await expect(
    page.getByRole('heading', { level: 1, name: 'Sign in to see your orders' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'My orders' })).toHaveCount(0);
  // Not "slow" — ABORTED: the round trip completed server-side inside this
  // hold window, yet the old document never got to persist a session.
  expect(await page.evaluate((key) => localStorage.getItem(key), AUTH_STORAGE_KEY)).toBeNull();
});

test('FIX: the hardened signInUi contract (redirect COMMIT before any goto) rides out the same hold', async ({ page }) => {
  test.setTimeout(90_000);
  await holdLoginResponses(page);
  await page.goto('/login');
  await fillAndClick(page, 'demo@foodorder.app');
  // VERBATIM contract of the hardened helper (zz-forms-a11y +
  // zz-gdpr-account signInUi): the URL must leave /login — proof that
  // login() resolved and applySession persisted — before the caller
  // navigates anywhere.
  await expect(page).not.toHaveURL(/\/login(\?|#|$)/, { timeout: 20_000 });
  expect(await page.evaluate((key) => localStorage.getItem(key), AUTH_STORAGE_KEY)).not.toBeNull();

  await page.goto('/orders/my');
  await expect(page.getByRole('heading', { level: 1, name: 'My orders' })).toBeVisible();
});
